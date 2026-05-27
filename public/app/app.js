/**
 * VoiceIsolate Pro — app.js  (Threads from Space v8)
 * =====================================================
 * Exports:  class VoiceIsolatePro  (also assigned to window.VoiceIsolatePro)
 *
 * vip-boot.js contract:
 *   - typeof VoiceIsolatePro !== 'undefined'   after this module evaluates
 *   - new VoiceIsolatePro()                    must not throw
 *   - instance.init()                          completes async bootstrap
 *   - window._vipApp                           set to the live instance
 *
 * Single-Pass Spectral Contract:
 *   ONE forward STFT  → in-place spectral ops → ONE iSTFT
 *   Both live inside dsp-processor.js AudioWorklet.
 *   app.js never touches spectral data directly.
 *
 * 100 % local — no cloud APIs, no external fetch except /app/models/*.onnx.
 */

import { buildPanels, runAudit, SLIDER_REGISTRY } from './slider-map.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function pill(id, state) {
  if (typeof window._setVipEnginePill === 'function') window._setVipEnginePill(id, state);
}

function showToast(msg, type = 'info') {
  const region = $('toastRegion');
  if (!region) return;
  const t = document.createElement('div');
  t.className = `toast toast--${type}`;
  t.textContent = msg;
  region.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// WAV encoder
// ---------------------------------------------------------------------------
function encodeWav(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const numSamples = audioBuffer.length;
  const sr = audioBuffer.sampleRate;
  const bps = 2;
  const buf = new ArrayBuffer(44 + numSamples * numCh * bps);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, buf.byteLength - 8, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, numCh, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * numCh * bps, true); v.setUint16(32, numCh * bps, true);
  v.setUint16(34, 16, true); ws(36, 'data'); v.setUint32(40, numSamples * numCh * bps, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const s = Math.max(-1, Math.min(1, audioBuffer.getChannelData(ch)[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      off += 2;
    }
  }
  return buf;
}

function downloadWav(audioBuffer, name) {
  const blob = new Blob([encodeWav(audioBuffer)], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// ---------------------------------------------------------------------------
// VoiceIsolatePro
// ---------------------------------------------------------------------------
class VoiceIsolatePro {
  constructor() {
    // Audio graph
    this.ctx = null;
    this.workletNode = null;
    this.mlWorker = null;
    this.sourceNode = null;
    this.micStream = null;

    // ONNX sessions
    this.onnxSessions = {};

    // State
    this.mode = 'idle';          // idle | live | creator
    this._initCalled = false;
    this._ctxReady = false;
    this.mlReady = false;

    // SharedArrayBuffer param lane (slot 0 = bypass, slots 1-52 = slider values)
    this.sharedParams = null;

    // Loaded audio buffers
    this.origBuffer = null;
    this.procBuffer = null;

    // Playback
    this._playNode = null;
    this._playStart = 0;
    this._playOffset = 0;
    this._playing = false;
    this._abVersion = 'A';
  }

  // ── Public init (called by vip-boot.js) ──────────────────────────────────
  async init() {
    if (this._initCalled) return;
    this._initCalled = true;

    this._bindDOM();
    this._initSliders();
    this._dismissBootSplash();

    // Lazy AudioContext — browser requires user gesture first
    // We prime it on the first meaningful click anywhere
    document.addEventListener('click', () => this._ensureAudioCtx(), { once: true });
    document.addEventListener('keydown', () => this._ensureAudioCtx(), { once: true });

    // Signal app:ready so onAppReady() subscribers in slider-map fire
    window.__vipAppReady = true;
    window.dispatchEvent(new CustomEvent('app:ready'));
  }

  // ── Boot splash ──────────────────────────────────────────────────────────
  _dismissBootSplash() {
    const splash = $('bootSplash');
    const fill = $('bootSplashProgress');
    if (!splash) return;
    let pct = 0;
    const iv = setInterval(() => {
      pct = Math.min(pct + Math.random() * 18 + 4, 100);
      if (fill) fill.style.width = pct + '%';
      if (pct >= 100) {
        clearInterval(iv);
        setTimeout(() => {
          splash.style.transition = 'opacity 0.4s ease';
          splash.style.opacity = '0';
          setTimeout(() => { splash.style.display = 'none'; }, 420);
        }, 200);
      }
    }, 80);
  }

  // ── AudioContext + AudioWorklet ──────────────────────────────────────────
  async _ensureAudioCtx() {
    if (this._ctxReady) {
      if (this.ctx?.state === 'suspended') await this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
      pill('engCtxPill', 'loading');

      // SharedArrayBuffer (requires COOP/COEP — already set in vercel.json)
      if (typeof SharedArrayBuffer !== 'undefined') {
        const sab = new SharedArrayBuffer(256 * Float32Array.BYTES_PER_ELEMENT);
        this.sharedParams = new Float32Array(sab);
        // Populate initial slider values into SAB
        SLIDER_REGISTRY.forEach((s, i) => {
          this.sharedParams[i + 1] = window.VIP_PARAMS?.[s.id] ?? s.val ?? 0;
        });
      }

      await this.ctx.audioWorklet.addModule('/app/dsp-processor.js');

      this.workletNode = new AudioWorkletNode(this.ctx, 'dsp-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          sampleRate: this.ctx.sampleRate,
          sharedParamsBuffer: this.sharedParams?.buffer ?? null,
        },
      });

      this.workletNode.port.onmessage = (e) => this._onWorkletMsg(e.data);
      pill('engCtxPill', 'ready');
      pill('engWorkletPill', 'ready');
      this._ctxReady = true;

      this._initMlWorker();
      console.info('[VIP] AudioContext + AudioWorklet ready.');
    } catch (err) {
      console.error('[VIP] AudioContext init failed:', err);
      pill('engCtxPill', 'error');
      pill('engWorkletPill', 'error');
    }
  }

  _onWorkletMsg(data) {
    if (!data) return;
    if (data.type === 'meter') this._updateMeters(data.peak, data.rms);
    if (data.type === 'log')   console.debug('[worklet]', data.msg);
  }

  // ── ML Worker ────────────────────────────────────────────────────────────
  _initMlWorker() {
    try {
      this.mlWorker = new Worker('/app/ml-worker.js', { type: 'module' });
      this.mlWorker.onmessage = (e) => this._onWorkerMsg(e.data);
      this.mlWorker.onerror = (e) => console.error('[VIP] ml-worker error:', e);
      const initPayload = {};
      for (const s of SLIDER_REGISTRY) initPayload[s.key] = window.VIP_PARAMS?.[s.id] ?? 0;
      this.mlWorker.postMessage({ type: 'init', params: initPayload });
      this.mlReady = true;
      pill('engMlPill', 'ready');
    } catch (err) {
      console.warn('[VIP] ml-worker unavailable (classical DSP only):', err);
      window.VIP_ML_AVAILABLE = false;
      pill('engMlPill', 'unavailable');
    }
  }

  _onWorkerMsg(data) {
    if (!data) return;
    if (data.type === 'progress') this._setPipeProgress(data.pct, data.label);
    if (data.type === 'result' && this.workletNode) {
      this.workletNode.port.postMessage({ type: 'ml_result', buffer: data.buffer }, [data.buffer]);
    }
  }

  // ── 52-Slider wiring ─────────────────────────────────────────────────────
  _initSliders() {
    buildPanels(document, (spec, rawVal) => {
      // Sync real-time sliders into SAB immediately
      if (this.sharedParams && spec.rt) {
        const idx = SLIDER_REGISTRY.findIndex(s => s.id === spec.id);
        if (idx >= 0) this.sharedParams[idx + 1] = rawVal;
      }
    });

    const audit = runAudit(document);
    if (audit.fail > 0) {
      console.warn('[VIP] Slider audit failures:', audit.checks);
    } else {
      console.info(`[VIP] ${audit.checks.sliderCount} sliders built OK.`);
    }

    // Reset button
    const resetBtn = $('resetSlidersBtn');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        document.querySelectorAll('.sr-row input[type="range"]').forEach(el => {
          const spec = SLIDER_REGISTRY.find(s => 'sl_' + s.id === el.id);
          if (!spec) return;
          el.value = spec.val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        });
      });
    }

    // Slider search filter
    const search = $('sliderSearch');
    if (search) {
      search.addEventListener('input', () => {
        const q = search.value.trim().toLowerCase();
        document.querySelectorAll('.sr-row').forEach(row => {
          const label = row.querySelector('.sr-label')?.textContent.toLowerCase() ?? '';
          row.style.display = (!q || label.includes(q)) ? '' : 'none';
        });
      });
    }

    // Accordion toggle for slider groups
    document.querySelectorAll('.slider-group-header').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.closest('.slider-group');
        if (!group) return;
        const isOpen = group.classList.toggle('active');
        btn.setAttribute('aria-expanded', String(isOpen));
      });
    });
  }

  // ── File handling ─────────────────────────────────────────────────────────
  async loadFile(file) {
    if (!file) return;
    const info = $('fileInfo');
    const loader = $('fileLoadIndicator');
    if (info) info.textContent = file.name;
    if (loader) loader.hidden = false;

    try {
      await this._ensureAudioCtx();
      const ab = await file.arrayBuffer();
      this.origBuffer = await this.ctx.decodeAudioData(ab);

      // Update header stats
      this._setHeaderStat('hDur', fmtTime(this.origBuffer.duration));
      this._setHeaderStat('hSR', this.origBuffer.sampleRate + ' Hz');
      this._setHeaderStat('hCh', this.origBuffer.numberOfChannels === 1 ? 'Mono' : 'Stereo');
      this._setHeaderStat('hFile', file.name.slice(0, 20));

      // Enable process buttons
      [$('processBtn'), $('mobileProcessBtn')].forEach(b => { if (b) b.disabled = false; });

      // Draw waveform if visuals available
      if (typeof window.drawWaveform === 'function') window.drawWaveform(this.origBuffer);

      showToast('File loaded: ' + file.name, 'info');
    } catch (err) {
      console.error('[VIP] File load error:', err);
      showToast('Failed to decode: ' + file.name, 'error');
    } finally {
      if (loader) loader.hidden = true;
    }
  }

  // ── Creator-mode processing ───────────────────────────────────────────────
  async process() {
    if (!this.origBuffer) { showToast('No file loaded.', 'error'); return; }
    if (this.mode === 'creator') return;
    this.mode = 'creator';
    this._setPipeProgress(0, 'Starting offline pipeline…');
    this._setHeaderStat('hStatus', 'PROCESSING');

    try {
      await this._ensureAudioCtx();
      const buf = this.origBuffer;
      const offline = new OfflineAudioContext(buf.numberOfChannels, buf.length, buf.sampleRate);
      await offline.audioWorklet.addModule('/app/dsp-processor.js');

      const offNode = new AudioWorkletNode(offline, 'dsp-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [buf.numberOfChannels],
        processorOptions: {
          sampleRate: offline.sampleRate,
          mode: 'offline',
          params: { ...window.VIP_PARAMS },
        },
      });

      const src = offline.createBufferSource();
      src.buffer = buf;
      src.connect(offNode);
      offNode.connect(offline.destination);
      src.start();

      this._setPipeProgress(30, 'Running DSP pipeline…');
      this.procBuffer = await offline.startRendering();
      this._setPipeProgress(100, 'Complete');
      this._setHeaderStat('hStatus', 'DONE');

      [$('reprocessBtn'), $('saveProcBtn'), $('auditLogBtn'), $('mobileReprocessBtn')].forEach(b => {
        if (b) b.disabled = false;
      });
      if (typeof window.drawWaveform === 'function') window.drawWaveform(this.procBuffer, 'proc');
      showToast('Processing complete!', 'info');
    } catch (err) {
      console.error('[VIP] Processing error:', err);
      showToast('Processing failed: ' + err.message, 'error');
      this._setHeaderStat('hStatus', 'ERROR');
    } finally {
      this.mode = 'idle';
    }
  }

  // ── Live mic ──────────────────────────────────────────────────────────────
  async startLive() {
    try {
      await this._ensureAudioCtx();
      this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      this.sourceNode = this.ctx.createMediaStreamSource(this.micStream);
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.ctx.destination);
      this.mode = 'live';
      const lbl = $('micLabel');
      if (lbl) lbl.textContent = 'Stop';
      this._setHeaderStat('hStatus', 'LIVE');
      showToast('Live mode active.', 'info');
    } catch (err) {
      showToast('Mic access denied.', 'error');
      console.error('[VIP] Mic error:', err);
    }
  }

  stopLive() {
    this.micStream?.getTracks().forEach(t => t.stop());
    try { this.sourceNode?.disconnect(); } catch (_) {}
    this.sourceNode = null;
    this.micStream = null;
    this.mode = 'idle';
    const lbl = $('micLabel');
    if (lbl) lbl.textContent = 'Record';
    this._setHeaderStat('hStatus', 'IDLE');
  }

  // ── Transport ─────────────────────────────────────────────────────────────
  async play() {
    const buf = this._abVersion === 'B' && this.procBuffer ? this.procBuffer : this.origBuffer;
    if (!buf) return;
    await this._ensureAudioCtx();
    this._stopPlayback();
    this._playNode = this.ctx.createBufferSource();
    this._playNode.buffer = buf;
    this._playNode.playbackRate.value = parseFloat($('tpSpeed')?.value ?? 1);
    this._playNode.connect(this.workletNode ?? this.ctx.destination);
    if (this.workletNode) this.workletNode.connect(this.ctx.destination);
    this._playStart = this.ctx.currentTime - this._playOffset;
    this._playNode.start(0, this._playOffset);
    this._playing = true;
    this._playNode.onended = () => { this._playing = false; this._playOffset = 0; this._updateTransportUI(); };
    this._updateTransportUI();
    requestAnimationFrame(() => this._tickTransport());
  }

  pause() {
    if (!this._playing) return;
    this._playOffset = this.ctx.currentTime - this._playStart;
    this._stopPlayback();
    this._playing = false;
    this._updateTransportUI();
  }

  stop() {
    this._playOffset = 0;
    this._stopPlayback();
    this._playing = false;
    this._updateTransportUI();
  }

  _stopPlayback() {
    try { this._playNode?.stop(); this._playNode?.disconnect(); } catch (_) {}
    this._playNode = null;
  }

  _tickTransport() {
    if (!this._playing) return;
    const cur = this.ctx.currentTime - this._playStart;
    const dur = this.origBuffer?.duration ?? 0;
    const pct = dur > 0 ? (cur / dur) * 1000 : 0;
    const seek = $('tpSeek');
    if (seek) seek.value = Math.min(pct, 1000);
    const curEl = $('tpCur');
    if (curEl) curEl.textContent = fmtTime(cur);
    requestAnimationFrame(() => this._tickTransport());
  }

  _updateTransportUI() {
    const dur = this.origBuffer?.duration ?? 0;
    const durEl = $('tpDur');
    if (durEl) durEl.textContent = fmtTime(dur);
    [$('tpPlay'), $('tpPause'), $('tpStop'), $('tpRew'), $('tpFwd'), $('tpSeek'), $('tpAB')].forEach(b => {
      if (b) b.disabled = !this.origBuffer;
    });
  }

  // ── Bypass ────────────────────────────────────────────────────────────────
  setBypass(on) {
    if (this.sharedParams) this.sharedParams[0] = on ? 1 : 0;
    this.workletNode?.port.postMessage({ type: 'bypass', enabled: on });
  }

  // ── DOM binding ───────────────────────────────────────────────────────────
  _bindDOM() {
    // File input
    const fileInput = $('fileInput');
    const fileBtn   = $('fileBtn');
    const dropZone  = $('dropZone');
    const uploadZone = $('uploadZone');
    const clearFile  = $('clearFile');

    if (fileBtn && fileInput) fileBtn.addEventListener('click', () => fileInput.click());
    if (uploadZone) {
      uploadZone.addEventListener('click', () => fileInput?.click());
      uploadZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput?.click(); });
    }
    if (fileInput) fileInput.addEventListener('change', e => this.loadFile(e.target.files[0]));
    if (dropZone) {
      dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
      dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
      dropZone.addEventListener('drop', e => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');
        this.loadFile(e.dataTransfer.files[0]);
      });
    }
    if (clearFile) {
      clearFile.addEventListener('click', () => {
        this.origBuffer = null;
        this.procBuffer = null;
        this.stop();
        const info = $('fileInfo');
        if (info) info.textContent = 'No file loaded';
        if (fileInput) fileInput.value = '';
        [$('processBtn'), $('reprocessBtn'), $('saveProcBtn'), $('saveOrigBtn'), $('auditLogBtn'),
         $('mobileProcessBtn'), $('mobileReprocessBtn')].forEach(b => { if (b) b.disabled = true; });
        this._updateTransportUI();
        this._setHeaderStat('hStatus', 'IDLE');
      });
    }

    // Process / Reprocess
    const processBtn    = $('processBtn');
    const reprocessBtn  = $('reprocessBtn');
    const mobileProcess = $('mobileProcessBtn');
    const mobileReproc  = $('mobileReprocessBtn');
    if (processBtn)   processBtn.addEventListener('click',   () => this.process());
    if (reprocessBtn) reprocessBtn.addEventListener('click', () => this.process());
    if (mobileProcess) mobileProcess.addEventListener('click', () => this.process());
    if (mobileReproc)  mobileReproc.addEventListener('click',  () => this.process());

    // Mic
    const micBtn = $('micBtn');
    if (micBtn) {
      micBtn.addEventListener('click', () => {
        if (this.mode === 'live') this.stopLive(); else this.startLive();
      });
    }

    // Transport
    $('tpPlay')?.addEventListener('click',  () => this.play());
    $('tpPause')?.addEventListener('click', () => this.pause());
    $('tpStop')?.addEventListener('click',  () => this.stop());
    $('tpRew')?.addEventListener('click',   () => { this._playOffset = 0; if (this._playing) this.play(); });
    $('tpFwd')?.addEventListener('click',   () => {
      const dur = this.origBuffer?.duration ?? 0;
      this._playOffset = Math.min(this._playOffset + 10, dur);
      if (this._playing) this.play();
    });
    $('tpSeek')?.addEventListener('input', e => {
      const dur = this.origBuffer?.duration ?? 0;
      this._playOffset = (parseFloat(e.target.value) / 1000) * dur;
      if (this._playing) this.play();
    });
    const speedSel    = $('tpSpeed');
    const speedDown   = $('tpSpeedDown');
    const speedUp     = $('tpSpeedUp');
    const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
    if (speedSel) {
      speedSel.addEventListener('change', () => {
        if (this._playNode) this._playNode.playbackRate.value = parseFloat(speedSel.value);
      });
    }
    if (speedDown && speedSel) {
      speedDown.addEventListener('click', () => {
        const cur = parseFloat(speedSel.value);
        const idx = SPEEDS.indexOf(cur);
        if (idx > 0) { speedSel.value = SPEEDS[idx - 1]; speedSel.dispatchEvent(new Event('change')); }
      });
    }
    if (speedUp && speedSel) {
      speedUp.addEventListener('click', () => {
        const cur = parseFloat(speedSel.value);
        const idx = SPEEDS.indexOf(cur);
        if (idx < SPEEDS.length - 1) { speedSel.value = SPEEDS[idx + 1]; speedSel.dispatchEvent(new Event('change')); }
      });
    }

    // A/B toggle
    const tpAB     = $('tpAB');
    const tpABLabel = $('tpABLabel');
    if (tpAB) {
      tpAB.addEventListener('click', () => {
        if (!this.procBuffer) { showToast('Process a file first for A/B.', 'info'); return; }
        this._abVersion = this._abVersion === 'A' ? 'B' : 'A';
        if (tpABLabel) {
          tpABLabel.dataset.version = this._abVersion;
          tpABLabel.querySelector('.tp-ab-tag').textContent = this._abVersion;
          tpABLabel.querySelector('.tp-ab-name').textContent = this._abVersion === 'A' ? 'Original' : 'Processed';
        }
        tpAB.classList.toggle('active', this._abVersion === 'B');
        tpAB.classList.add('tp-ab-no-output');
        setTimeout(() => tpAB.classList.remove('tp-ab-no-output'), 700);
        if (this._playing) this.play();
      });
      // Keyboard shortcut X
      document.addEventListener('keydown', e => {
        if (e.key === 'x' || e.key === 'X') tpAB.click();
      });
    }

    // Save buttons
    $('saveOrigBtn')?.addEventListener('click', () => {
      if (this.origBuffer) downloadWav(this.origBuffer, 'original-' + Date.now() + '.wav');
    });
    $('saveProcBtn')?.addEventListener('click', () => {
      if (this.procBuffer) downloadWav(this.procBuffer, 'processed-' + Date.now() + '.wav');
    });

    // UI scale
    let scale = 1;
    $('uiScaleDn')?.addEventListener('click', () => {
      scale = Math.max(0.7, scale - 0.05);
      document.body.style.zoom = scale;
      const v = $('uiScaleVal'); if (v) v.textContent = Math.round(scale * 100) + '%';
    });
    $('uiScaleUp')?.addEventListener('click', () => {
      scale = Math.min(1.4, scale + 0.05);
      document.body.style.zoom = scale;
      const v = $('uiScaleVal'); if (v) v.textContent = Math.round(scale * 100) + '%';
    });

    // Header stats toggle
    const statsToggle = $('statsToggle');
    const hdrStats    = $('hdrStats');
    if (statsToggle && hdrStats) {
      statsToggle.addEventListener('click', () => {
        const open = hdrStats.classList.toggle('open');
        statsToggle.setAttribute('aria-expanded', String(open));
        statsToggle.innerHTML = open ? '&#9650;' : '&#9660;';
      });
    }

    // Forensic toggle
    $('forensicToggle')?.addEventListener('click', () => showToast('Forensic mode: set in Advanced sliders.', 'info'));

    // Preset selector
    $('presetSel')?.addEventListener('change', e => this._applyPreset(e.target.value));
    document.querySelectorAll('.btn-preset').forEach(b => {
      b.addEventListener('click', () => this._applyPreset(b.dataset.preset));
    });

    // Custom preset modal
    $('openPresetModalBtn')?.addEventListener('click', () => {
      const modal = $('customPresetModal');
      if (modal) { modal.style.display = 'flex'; modal.setAttribute('aria-hidden', 'false'); }
    });
    $('closePresetModal')?.addEventListener('click', () => {
      const modal = $('customPresetModal');
      if (modal) { modal.style.display = 'none'; modal.setAttribute('aria-hidden', 'true'); }
    });

    // Viz tab switching
    document.querySelectorAll('.tab-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
          b.setAttribute('tabindex', '-1');
        });
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        btn.setAttribute('tabindex', '0');
        const panel = document.getElementById('tab-' + btn.dataset.tab);
        if (panel) panel.classList.add('active');
      });
    });

    // Fullscreen spectrogram
    $('fullscreenSpectroBtn')?.addEventListener('click', () => {
      const el = $('spectro3d-container') ?? $('spectroCanvas');
      if (el?.requestFullscreen) el.requestFullscreen();
    });
  }

  // ── Preset application ────────────────────────────────────────────────────
  _applyPreset(name) {
    const PRESETS = {
      'Voice Clarity':    { nrAmount: 70, gateThresh: -42, compThresh: -24, compRatio: 4, outGain: 2, voiceIso: 80 },
      'Podcast Clean':    { nrAmount: 85, gateThresh: -50, compThresh: -20, compRatio: 3, outGain: 0, deEssAmt: 6 },
      'Forensic Extract': { nrAmount: 95, gateThresh: -60, compThresh: -30, compRatio: 8, voiceIso: 95, bgSuppress: 90 },
      'Music Vocal':      { nrAmount: 40, voiceIso: 60, harmRecov: 50, compRatio: 2.5, compThresh: -18 },
      'Whisper Boost':    { nrAmount: 60, gateThresh: -65, outGain: 6, compRatio: 6, compThresh: -36 },
      'Phone/Radio':      { hpFreq: 300, lpFreq: 3400, nrAmount: 80, compRatio: 5 },
      'Live Performance': { nrAmount: 30, gateThresh: -38, compRatio: 3, stereoWidth: 120 },
      'Surveillance':     { nrAmount: 92, gateThresh: -70, voiceIso: 90, bgSuppress: 85, outGain: 10 },
    };
    const preset = PRESETS[name];
    if (!preset) return;
    Object.entries(preset).forEach(([id, val]) => {
      const el = document.getElementById('sl_' + id);
      if (el) { el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    showToast('Preset applied: ' + name, 'info');
  }

  // ── Meter + pipeline UI ───────────────────────────────────────────────────
  _updateMeters(peak, rms) {
    const fmt = v => (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB';
    this._setHeaderStat('hPeak', fmt(peak ?? -60));
    this._setHeaderStat('hRMS',  fmt(rms  ?? -60));
    const vuIn  = document.querySelector('.vu-meter:nth-child(1)');
    const vuOut = document.querySelector('.vu-meter:nth-child(2)');
    const toLevel = v => Math.max(0, ((v + 60) / 60) * 100).toFixed(1) + '%';
    if (vuIn)  vuIn.style.setProperty('--vu-level',  toLevel(rms ?? -60));
    if (vuOut) vuOut.style.setProperty('--vu-level', toLevel(peak ?? -60));
  }

  _setPipeProgress(pct, label) {
    const fill  = $('pipeFill');
    const bar   = $('pipeBar');
    const detail = $('pipeDetail');
    const badge  = $('vip-proc-badge');
    if (fill)   fill.style.width = pct + '%';
    if (bar)    bar.setAttribute('aria-valuenow', pct);
    if (detail) detail.textContent = label || '';
    if (badge)  badge.dataset.state = pct >= 100 ? 'done' : pct > 0 ? 'processing' : 'idle';
    const spinner = badge?.querySelector('.vip-pb-spinner');
    if (spinner) spinner.style.display = (pct > 0 && pct < 100) ? '' : 'none';
    const lbl = badge?.querySelector('.vip-pb-label');
    if (lbl) lbl.textContent = label || (pct >= 100 ? 'Done' : 'Ready');
  }

  _setHeaderStat(id, val) {
    const el = $(id);
    if (el) el.textContent = val;
  }
}

// ---------------------------------------------------------------------------
// Register on window so vip-boot.js can call: typeof VoiceIsolatePro
// ---------------------------------------------------------------------------
window.VoiceIsolatePro = VoiceIsolatePro;

export default VoiceIsolatePro;
export { VoiceIsolatePro };
