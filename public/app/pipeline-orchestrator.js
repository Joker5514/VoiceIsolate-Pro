/* ============================================
   VoiceIsolate Pro v22.1 — Pipeline Orchestrator
   Threads from Space v11
   ONNX Runtime Web init · AudioWorklet setup
   52-slider → AudioWorkletNode param mapping
   WebGPU > WASM fallback · SharedArrayBuffer rings
   ============================================ */

'use strict';

const WORKLET_READY_FALLBACK_MS = 250;

/**
 * PipelineOrchestrator
 * ─────────────────────
 * Owns:
 *  - The AudioContext and AudioWorkletNode (live path)
 *  - ONNX Runtime session initialisation (via ml-worker.js)
 *  - SharedArrayBuffer ring buffer allocation
 *  - Slider → worklet parameter forwarding
 *
 * Lifecycle (managed automatically by the bootstrap at the bottom):
 *   orch.init() is called on the first user gesture.
 *   orch.connectSource(srcNode) wires microphone / file source.
 *   orch.updateParams(params) is called on every slider change.
 *
 * NOTE: This file is loaded as a classic <script> (not ES module).
 * Do NOT add `export` or `import` statements.
 */
class PipelineOrchestrator {
  constructor() {
    /** @type {AudioContext|null} */
    this.ctx          = null;
    /** @type {AudioWorkletNode|null} */
    this.workletNode  = null;
    /** @type {Worker|null} */
    this.mlWorker     = null;
    /** @type {boolean} */
    this.mlReady      = false;
    /** @type {boolean} */
    this.workletReady = false;
    /** @type {string} */
    this.mlProvider   = 'wasm';  // updated after ONNX init
    /** @type {boolean} */
    this.initialized  = false;
    /** @type {Promise|null} */
    this._initPromise = null;

    // Shared ring buffers  (allocated once, shared between worklet + ML worker)
    // Each SAB layout:  Int32[0]=writePtr, Int32[1]=readPtr, Float32[2..]
    this._ringCapacity = 32;   // slots
    this._quantumSize  = 128;  // render quantum samples
    this._halfN        = 1025; // fftSize/2+1 = 2048/2+1

    // inputRing: worklet → ML worker  (raw PCM quanta)
    this._inputRingSAB = null;
    // maskRing:  ML worker → worklet  (per-bin gain mask)
    this._maskRingSAB  = null;

    // Cached ML worker init promise — allows idempotent pre-warming before gesture
    this._mlInitPromise = null;

    this._isolationParams = {
      isolationMethod: 'hybrid',
      ecapaSimilarityThreshold: 0.65,
      backgroundVolume: 0,
      maskRefinement: true,
    };
  }

  // ── One-time initialisation ─────────────────────────────────────────────
  /**
   * Must be called from a user-gesture handler (e.g. button click)
   * to satisfy browser autoplay policy.
   * Safe to call multiple times — subsequent calls return the cached promise.
   */
  init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {
    try {
      await this._createAudioContext();
      await this._loadWorklet();
      this._allocateRings();
      await this._initMLWorker();
      this._bindSliders();
      this.initialized = true;
      // Isolation controls are also bound eagerly in the bootstrap (so they
      // work even if AudioContext / worklet init fails). Calling here is
      // idempotent — duplicate listeners are guarded by _isolationBindingsAttached.
      this._bindIsolationControls();
      console.info('[Orchestrator] Fully initialised ✓');
    } catch (err) {
      console.error('[Orchestrator] Init failed:', err);
      // Non-fatal: offline pipeline (runPipeline via DSPCore) still works
    }
  }

  // ── AudioContext ────────────────────────────────────────────────────────
  async _createAudioContext() {
    // Re-use pre-warmed suspended ctx if available (set by bootstrapOrchestrator prewarm)
    if (this._preWarmedCtx && this._preWarmedCtx.state !== 'closed') {
      this.ctx = this._preWarmedCtx;
      this._preWarmedCtx = null;
      this._workletModulesLoaded = true;
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      const app = window._vipApp;
      if (app) app.ctx = this.ctx;
      return;
    }
    // Re-use app's existing AudioContext if available to avoid double-context
    const app = window._vipApp;
    if (app && app.ctx && app.ctx.state !== 'closed') {
      this.ctx = app.ctx;
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    this.ctx = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: 'interactive',
      sampleRate: 48000
    });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    // Share back with app
    if (app) app.ctx = this.ctx;
  }

  // ── AudioWorklet loading ─────────────────────────────────────────────────
  async _loadWorklet() {
    if (!this.ctx) throw new Error('AudioContext not initialised');
    if (!this._workletModulesLoaded) {
      try {
        await this.ctx.audioWorklet.addModule('/app/dsp-processor.js');
        console.info('[Orchestrator] AudioWorklet modules loaded');
      } catch (err) {
        console.error('[Orchestrator] Failed to load AudioWorklet module:', err);
        throw err;
      }
    }

    this.workletNode = new AudioWorkletNode(this.ctx, 'dsp-processor', {
      numberOfInputs:  1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        frameSize:    4096,
        fftSize:      2048,
        hopSize:      512,
        ringCapacity: this._ringCapacity
      }
    });

    // Route: workletNode → destination
    this.workletNode.connect(this.ctx.destination);

    // Listen for 'ready' ack from processor
    this.workletNode.port.onmessage = (e) => {
      if (e.data.type === 'ready') {
        this.workletReady = true;
        console.info('[Orchestrator] DSP worklet ready');
      } else if (e.data.type === 'error') {
        console.warn('[Orchestrator] DSP worklet error:', e.data.msg);
      }
    };
  }

  // ── SharedArrayBuffer ring allocation ───────────────────────────────────
  _allocateRings() {
    // Check SharedArrayBuffer availability upfront
    if (typeof SharedArrayBuffer === 'undefined') {
      console.warn('[Orchestrator] SharedArrayBuffer not available (missing COOP/COEP headers or unsupported browser); live ML masking disabled. Falling back to Creator mode.');
      this._inputRingSAB = null;
      this._maskRingSAB  = null;
      try {
        if (typeof globalThis !== 'undefined' && typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
          globalThis.dispatchEvent(new CustomEvent('sabUnavailable', {
            detail: { reason: 'SharedArrayBuffer not available' }
          }));
        }
      } catch (_) { /* event dispatch is best-effort */ }
      return false;
    }

    try {
      const inputBytes =
        Int32Array.BYTES_PER_ELEMENT * 2 +
        this._ringCapacity * this._quantumSize * Float32Array.BYTES_PER_ELEMENT;
      this._inputRingSAB = new SharedArrayBuffer(inputBytes);

      const maskBytes =
        Int32Array.BYTES_PER_ELEMENT * 2 +
        this._ringCapacity * this._halfN * Float32Array.BYTES_PER_ELEMENT;
      this._maskRingSAB = new SharedArrayBuffer(maskBytes);

      new Int32Array(this._inputRingSAB).fill(0);
      new Int32Array(this._maskRingSAB ).fill(0);

      this.workletNode.port.postMessage({
        type:      'initRings',
        inputRing: this._inputRingSAB,
        maskRing:  this._maskRingSAB
      });

      // Forward SABs to ML worker if it was pre-warmed before the gesture
      if (this.mlWorker) {
        this.mlWorker.postMessage({
          type:         'initRingBuffers',
          inputRing:    this._inputRingSAB,
          maskRing:     this._maskRingSAB,
          ringCapacity: this._ringCapacity,
          quantumSize:  this._quantumSize,
          halfN:        this._halfN
        });
      }
      // Some worklets acknowledge ring init asynchronously. If no explicit
      // ready message arrives, fall back after a short grace period.
      setTimeout(() => {
        if (!this.workletReady) {
          this.workletReady = true;
        }
      }, WORKLET_READY_FALLBACK_MS);
      return true;
    } catch (err) {
      // SharedArrayBuffer blocked (COOP/COEP misconfigured or SAB construction failed) — graceful degradation
      console.warn('[Orchestrator] SharedArrayBuffer allocation failed; live ML masking disabled:', err.message);
      this._inputRingSAB = null;
      this._maskRingSAB  = null;
      try {
        if (typeof globalThis !== 'undefined' && typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
          globalThis.dispatchEvent(new CustomEvent('sabUnavailable', {
            detail: { reason: err?.message || String(err) }
          }));
        }
      } catch (_) { /* event dispatch is best-effort */ }
      return false;
    }
  }

  async waitForReadiness(timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.workletReady && this.mlReady) return true;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  }

  // ── ONNX Runtime + ML Worker initialisation ─────────────────────────────
  // Idempotent: safe to call immediately at bootstrap (no user gesture needed
  // for Web Workers) AND again from _doInit() — returns the cached promise.
  _initMLWorker() {
    if (this._mlInitPromise) return this._mlInitPromise;
    this._mlInitPromise = this._doInitMLWorker();
    return this._mlInitPromise;
  }

  async _doInitMLWorker() {
    return new Promise((resolve) => {
      // ── Construct the ML Worker ──────────────────────────────────────────
      this.mlWorker = new Worker('./ml-worker.js');

      // ── Apply graceful-degradation patch (ml-worker-models-patch.js) ────
      // Stamps ⚠ DSP badges on pipeline stage UI elements for any missing
      // .onnx files. Non-destructive — worker still functions without models.
      if (typeof window._mlWorkerPatch === 'function') {
        window._mlWorkerPatch(this.mlWorker, {
          logToConsole: true,
          onWarning: (stageId, modelKey, meta) => {
            // Stamp individual stage badge
            const el = document.querySelector(
              `[data-stage-id="${stageId}"], [data-stage="${stageId}"]`
            );
            if (!el) return;
            const existing = el.querySelector('.vip-stage-ml-status');
            if (existing) existing.remove();
            const badge = document.createElement('span');
            badge.className    = 'vip-stage-ml-status';
            badge.textContent  = '⚠ DSP';
            badge.style.cssText =
              'color:#f59e0b;font-size:10px;font-weight:700;' +
              'margin-left:4px;cursor:help;vertical-align:middle;';
            badge.title =
              `${meta.stageName || modelKey}: model file absent
` +
              `Expected: models/${meta.filename || modelKey + '.onnx'}
` +
              `Stage running in DSP passthrough mode.`;
            const label =
              el.querySelector('.stage-name,.stage-label,h4,h3,span') || el;
            label.appendChild(badge);
          },
          onManifest: (manifest) => {
            if (typeof window._stampPipelineStages === 'function') {
              window._stampPipelineStages(manifest);
            }
          }
        });
      }

      // ── Apply IndexedDB model cache patch (ml-worker-fetch-cache.js) ────
      // If models are cached in IDB, pass Object URLs so the worker skips
      // re-fetching them from disk. Falls back gracefully if cache is empty.
      if (typeof window._vipPreloadModels === 'function') {
        // Fire-and-forget preload — models load while audio context inits.
        // The 'vip:modelsPreloaded' event (fired by fetch-cache.js) notifies
        // the worker to swap in the cached sessions once they're ready.
        window._vipPreloadModels(
          ['silero_vad', 'noise_classifier', 'deepfilter',
           'dns2_conformer_small', 'ecapa_tdnn', 'convtasnet', 'bsrnn', 'demucs'],
          { forceRefresh: false }
        ).then((modelPaths) => {
          // Forward any resolved Object URLs to the already-running worker
          const cached = Object.keys(modelPaths);
          if (cached.length > 0) {
            this.mlWorker.postMessage({ type: 'cacheModelPaths', modelPaths });
            console.info(
              `[Orchestrator] Forwarded ${cached.length} cached model URL(s) to ML worker:`,
              cached
            );
          }
        }).catch((err) => {
          // Preload failure is fully non-fatal — DSP passthrough continues
          console.warn('[Orchestrator] Model preload warning:', err.message);
        });
      }

      // ── Standard message handler ─────────────────────────────────────────
      this.mlWorker.onmessage = (e) => {
        const { type } = e.data;
        if (type === 'ready') {
          this.mlReady    = true;
          this.mlProvider = e.data.provider || 'wasm';
          console.info(
            `[Orchestrator] ML worker ready — provider: ${this.mlProvider}`,
            e.data.models
          );
          // Share with app instance
          if (window._vipApp) window._vipApp.mlWorker = this.mlWorker;
          // Re-send any isolation config and sound mutes that the user may
          // have changed before the worker became ready.
          try {
            this.mlWorker.postMessage({
              type: 'setIsolationConfig',
              payload: this._isolationParams,
            });
            const sm = window._vipApp && window._vipApp.soundMutes;
            if (sm && Object.keys(sm).length) {
              this.mlWorker.postMessage({ type: 'setSoundMutes', payload: sm });
            }
            // Attach the worker to the isolation-controls module so any
            // speaker cards bound before the worker came online now route
            // mute/solo/isolate/enroll messages through.
            if (typeof window._attachMLWorkerToIsolation === 'function') {
              window._attachMLWorkerToIsolation(this.mlWorker);
            }
          } catch (_) { /* best-effort */ }
          resolve();
        } else if (type === 'log') {
          const lvl = e.data.level;
          if (console[lvl]) console[lvl]('[ml-worker]', e.data.msg);
        } else if (type === 'vad_status') {
          if (window._vipApp) window._vipApp.vadModelMissing = !!e.data.vadModelMissing;
          if (e.data.vadModelMissing) {
            console.warn('[Orchestrator] Fallback VAD active (Silero model missing)');
          }
        } else if (type === 'diarization') {
          // ── Diarization result → update app state + timeline + speaker cards
          const { segments = [], duration = 0, speakerCount = 0 } = e.data;
          const app = window._vipApp;
          if (app && app.diarizationState) {
            app.diarizationState.history     = segments;
            app.diarizationState.numSpeakers = speakerCount ||
              new Set(segments.map(s => s.speakerId)).size;
            app.diarizationState.isActive    = segments.length > 0;
            app.diarizationState.confidence  = segments.length > 0
              ? segments.reduce((a, s) => a + (s.confidence || 1), 0) / segments.length : 1;
          }
          if (typeof window.onDiarizationResult === 'function')
            window.onDiarizationResult({ segments, duration, speakerCount });
          if (typeof window.updateSpeakerCards === 'function') {
            const palette = ['#3b82f6','#a855f7','#10b981','#f59e0b',
                             '#ef4444','#06b6d4','#84cc16','#f97316'];
            const map = {};  let ci = 0;
            segments.forEach(seg => {
              if (!map[seg.speakerId]) map[seg.speakerId] = {
                label: seg.label || ('Speaker ' + seg.speakerId),
                color: palette[ci++ % palette.length],
                volume: 1.0, muted: false, solo: false
              };
            });
            window.updateSpeakerCards(map);
          }
        } else if (type === 'voiceprintEnrolled') {
          const el = document.getElementById('voiceprintStatus');
          if (el) { el.textContent = '✓ Enrolled'; el.style.color = '#10b981'; }
        } else if (type === 'voiceprintCleared') {
          const el = document.getElementById('voiceprintStatus');
          if (el) { el.textContent = 'Not enrolled'; el.style.color = '#9ca3af'; }
        }
      };

      this.mlWorker.onerror = (err) => {
        console.warn('[Orchestrator] ML worker error:', err.message);
        this.mlReady = false;
        resolve(); // non-fatal — DSP passthrough still runs
      };

      // ── Init message ─────────────────────────────────────────────────────
      // SABs are NOT included here — they may not be allocated yet when the
      // worker is pre-warmed before the first gesture. They are forwarded
      // separately via 'initRingBuffers' inside _allocateRings() once ready.
      const msg = {
        type:      'init',
        ortUrl:    '/lib/ort.min.js',
        providers: ['webgpu', 'wasm'],
        models:    ['vad', 'deepfilter', 'dns2_conformer_small',
                    'ecapa_tdnn', 'convtasnet', 'bsrnn', 'demucs',
                    'noise_classifier']
      };

      this.mlWorker.postMessage(msg);
    });
  }

  // ── Connect / disconnect an audio source ────────────────────────────────
  /**
   * Connect an audio source to the pipeline. Synchronous when the pipeline
   * is already ready; otherwise defers the actual connection until readiness
   * (or until timeout) so callers don't silently drop the source.
   * @param {AudioNode} sourceNode
   * @returns {Promise<boolean>} resolves true if connected, false otherwise.
   */
  connectSource(sourceNode) {
    if (!this.workletNode) {
      console.warn('[Orchestrator] connectSource called before init()');
      return Promise.resolve(false);
    }
    if (this.workletReady && this.mlReady) {
      sourceNode.connect(this.workletNode);
      return Promise.resolve(true);
    }
    // Deferred connect: wait for readiness, then connect.
    return this.waitForReadiness().then((ready) => {
      if (!ready) {
        console.warn('[Orchestrator] connectSource timed out waiting for readiness', {
          workletReady: this.workletReady,
          workerReady:  this.mlReady
        });
        return false;
      }
      if (!this.workletNode) return false;
      try { sourceNode.connect(this.workletNode); } catch (_) { return false; }
      return true;
    });
  }

  disconnectSource(sourceNode) {
    try { sourceNode.disconnect(this.workletNode); } catch (_) {}
  }

  // ── Slider → Worklet parameter forwarding ───────────────────────────────
  /**
   * Called by the patched onSlider() and applyPreset() in app.js.
   * Forwards the full params snapshot to the AudioWorkletProcessor
   * via the message port.
   *
   * @param {Object} params  Full params snapshot from VoiceIsolatePro
   */
  updateParams(params) {
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({
      type: 'setParams',
      params: {
        // Noise Gate
        gateThresh:    params.gateThresh,
        gateRange:     params.gateRange,
        gateAttack:    params.gateAttack,
        gateRelease:   params.gateRelease,
        gateHold:      params.gateHold,
        gateLookahead: params.gateLookahead,
        // Spectral NR
        nrAmount:      params.nrAmount,
        nrSensitivity: params.nrSensitivity,
        nrSpectralSub: params.nrSpectralSub,
        nrFloor:       params.nrFloor,
        nrSmoothing:   params.nrSmoothing,
        // Voice Isolation
        voiceIso:      params.voiceIso,
        bgSuppress:    params.bgSuppress,
        voiceFocusLo:  params.voiceFocusLo,
        voiceFocusHi:  params.voiceFocusHi,
        // Output
        outGain:       params.outGain,
        dryWet:        params.dryWet
      }
    });

    // Forward blend weights to ML worker
    if (this.mlWorker) {
      this.mlWorker.postMessage({
        type:   'setWeights',
        demucs: params.voiceIso / 100,
        bsrnn:  1 - params.voiceIso / 100
      });
      this.mlWorker.postMessage({
        type: 'setParams',
        payload: {
          spectralFloor: Number.isFinite(params.spectralFloor) ? params.spectralFloor : 0.005,
          noiseReduce: Math.max(0, Math.min(1, (params.nrAmount || 0) / 100)),
          forensicMode: !!window._vipApp?.forensicMode
        }
      });
    }
  }

  updateIsolationParams(nextParams) {
    if (!nextParams || typeof nextParams !== 'object') return;
    this._isolationParams = {
      ...this._isolationParams,
      ...nextParams,
    };
    if (this.mlWorker) {
      this.mlWorker.postMessage({
        type: 'setIsolationConfig',
        payload: this._isolationParams,
      });
    }
  }

  // Public getter — used by app.js's offline pipeline so the Speaker
  // Isolation card's Bg Level / Mask Refine / Method controls actually
  // affect output even when the live worklet isn't running.
  getIsolationParams() {
    return { ...this._isolationParams };
  }

  // Forward sound mute state to the ML worker so it can apply identical
  // suppression in the live (worklet) path. Idempotent and safe to call
  // before the worker is ready (re-sent on 'ready').
  updateSoundMutes(soundMutes) {
    if (this.mlWorker) {
      this.mlWorker.postMessage({ type: 'setSoundMutes', payload: soundMutes || {} });
    }
  }

  // ── Bind all 52 sliders ──────────────────────────────────────────────────
  /**
   * Iterates every <input data-param> and attaches an 'input' listener that
   * calls updateParams() with a full DOM snapshot.
   * Safe to call before workletNode is created — updateParams() guards itself.
   */
  _bindSliders() {
    // Build the snapshot once up-front, then mutate the single changed field
    // on each 'input' event. Re-querying all 52 sliders per-event was O(N)
    // DOM work on every interaction; this drops it to O(1).
    const sliders = document.querySelectorAll('input[type="range"][data-param]');
    const snapshot = {};
    sliders.forEach((s) => { snapshot[s.dataset.param] = parseFloat(s.value); });
    sliders.forEach((el) => {
      el.addEventListener('input', () => {
        snapshot[el.dataset.param] = parseFloat(el.value);
        this.updateParams(snapshot);
      });
    });
  }

  // ── Bind diarization timeline + isolation control events ─────────────────
  // Idempotent: safe to call before AudioContext/MLWorker exist, and safe
  // to call multiple times (subsequent calls early-return).
  _bindIsolationControls() {
    if (this._isolationBindingsAttached) return;
    this._isolationBindingsAttached = true;
    const _set = (payload) => this.updateIsolationParams(payload);

    // Method select
    const mSel = document.getElementById('isolationMethodSelect');
    mSel?.addEventListener('change', () => _set({ isolationMethod: mSel.value }));

    // Confidence slider
    const cSl = document.getElementById('isolationConfidenceSlider');
    const cOut = document.getElementById('isolationConfidenceReadout');
    const _cPct = () => ((Number(cSl.value) - Number(cSl.min)) / (Number(cSl.max) - Number(cSl.min)) * 100).toFixed(1) + '%';
    if (cSl) cSl.style.setProperty('--pct', _cPct());
    cSl?.addEventListener('input', () => {
      if (cOut) cOut.textContent = cSl.value + '%';
      cSl.style.setProperty('--pct', _cPct());
      _set({ ecapaSimilarityThreshold: Number(cSl.value) / 100 });
    });

    // Background volume slider
    const bgSl = document.getElementById('isolationBgVolumeSlider');
    const bgOut = document.getElementById('isolationBgReadout');
    const _bgPct = () => ((Number(bgSl.value) - Number(bgSl.min)) / (Number(bgSl.max) - Number(bgSl.min)) * 100).toFixed(1) + '%';
    if (bgSl) bgSl.style.setProperty('--pct', _bgPct());
    bgSl?.addEventListener('input', () => {
      if (bgOut) bgOut.textContent = bgSl.value + '%';
      bgSl.style.setProperty('--pct', _bgPct());
      _set({ backgroundVolume: Number(bgSl.value) / 100 });
    });

    // Mask refinement checkbox
    const mRef = document.getElementById('isolationMaskRefine');
    mRef?.addEventListener('change', () => _set({ maskRefinement: mRef.checked }));

    // Zoom controls
    document.getElementById('diarZoomIn') ?.addEventListener('click', () => window._diarZoom?.(2));
    document.getElementById('diarZoomOut')?.addEventListener('click', () => window._diarZoom?.(0.5));
    document.getElementById('diarZoomFit')?.addEventListener('click', () => window._diarZoomFit?.());

    // Voiceprint enroll
    const enrollBtn = document.getElementById('enrollVoiceprintBtn');
    const clearBtn  = document.getElementById('clearVoiceprintBtn');
    const statusEl  = document.getElementById('voiceprintStatus');

    enrollBtn?.addEventListener('click', async () => {
      const app = window._vipApp;
      if (!app?.mediaStream) {
        if (statusEl) { statusEl.textContent = 'Start mic first'; statusEl.style.color = '#f59e0b'; }
        return;
      }
      if (statusEl) { statusEl.textContent = 'Recording 5s…'; statusEl.style.color = '#f59e0b'; }
      enrollBtn.disabled = true;
      try {
        const rec = new MediaRecorder(app.mediaStream, { mimeType: 'audio/webm;codecs=opus' });
        const chunks = [];
        rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        rec.start(100);
        await new Promise(r => setTimeout(r, 5000));
        rec.stop();
        await new Promise(r => { rec.onstop = r; });
        const blob    = new Blob(chunks, { type: 'audio/webm' });
        const arrBuf  = await blob.arrayBuffer();
        const decoded = await this.ctx.decodeAudioData(arrBuf);
        const pcm     = new Float32Array(decoded.getChannelData(0));
        if (this.mlWorker) {
          this.mlWorker.postMessage({ type: 'enrollVoiceprint', payload: { pcm } }, [pcm.buffer]);
        }
      } catch(err) {
        if (statusEl) { statusEl.textContent = 'Error: ' + err.message; statusEl.style.color = '#ef4444'; }
      } finally { enrollBtn.disabled = false; }
    });

    clearBtn?.addEventListener('click', () => this.mlWorker && this.mlWorker.postMessage({ type: 'clearVoiceprint' }));

    const initialParams = {};
    if (mSel?.value) initialParams.isolationMethod = mSel.value;
    if (cSl?.value) initialParams.ecapaSimilarityThreshold = Number(cSl.value) / 100;
    if (bgSl?.value) initialParams.backgroundVolume = Number(bgSl.value) / 100;
    if (mRef) initialParams.maskRefinement = mRef.checked;
    if (Object.keys(initialParams).length > 0) this.updateIsolationParams(initialParams);
  }

  // ── Suspend / resume AudioContext ────────────────────────────────────────
  async suspend() {
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  // ── Teardown ──────────────────────────────────────────────────────────────
  destroy() {
    if (this.mlWorker)   { this.mlWorker.terminate();  this.mlWorker   = null; }
    if (this.workletNode){ try { this.workletNode.disconnect(); } catch (_) {} this.workletNode = null; }
    if (this.ctx && this.ctx.state !== 'closed') { this.ctx.close(); this.ctx = null; }
    this.mlReady = false;
    this.initialized = false;
  }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
// Waits for VoiceIsolatePro to be stored on window._vipApp, then:
//  1. Attaches orch to app.orch
//  2. Patches onSlider / applyPreset / toggleRecording
//  3. Calls orch.init() on the first user gesture (click / keydown / touchstart)
// This file is loaded AFTER app.js so window._vipApp is already set.
(function bootstrapOrchestrator() {
  function attach(app) {
    const orch = new PipelineOrchestrator();
    app.orch = orch;
    // Also expose globally for debugging
    window._vipOrch = orch;

    // ── Patch onSlider ─────────────────────────────────────────────────
    const _origOnSlider = app.onSlider.bind(app);
    app.onSlider = function (el) {
      _origOnSlider(el);
      orch.updateParams(app.params);
    };

    // ── Patch applyPreset ──────────────────────────────────────────────
    const _origApply = app.applyPreset.bind(app);
    app.applyPreset = function (name) {
      _origApply(name);
      orch.updateParams(app.params);
    };

    // ── Patch toggleRecording to ensure worklet is ready first ─────────
    const _origToggle = app.toggleRecording.bind(app);
    app.toggleRecording = async function () {
      if (!orch.initialized) {
        try { await orch.init(); } catch (e) { console.warn('[Orchestrator] init during toggleRecording failed:', e); }
      }
      return _origToggle();
    };

    // ── Pre-warm ML Worker immediately ────────────────────────────────
    // Web Workers don't require a user gesture. Starting the ML Worker
    // now restores the eager-load behaviour that previously lived in the
    // VoiceIsolatePro constructor, so models begin loading at page open.
    // AudioContext + AudioWorklet are still deferred to first gesture below.
    orch._initMLWorker().catch(e =>
      console.warn('[Orchestrator] ML worker prewarm error:', e)
    );

    // ── Bind Speaker Isolation card controls eagerly ──────────────────
    // These controls (Method dropdown, Confidence/Bg Level sliders, Mask
    // Refine, Voiceprint, sound mute toggles) only touch DOM and post
    // messages — they don't need the AudioContext or AudioWorklet. Wiring
    // them at bootstrap means user interaction works immediately, and is
    // resilient to AudioContext init failures (e.g. autoplay-blocked).
    const bindIso = () => orch._bindIsolationControls();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bindIso, { once: true });
    } else {
      bindIso();
    }

    // ── Pre-warm AudioWorklet modules ─────────────────────────────────
    // A suspended AudioContext can be created without a user gesture;
    // addModule() only requires an AudioContext to exist, not be running.
    // This eliminates 50-200 ms of worklet compile latency on first gesture.
    orch._preWarmWorklet = (async () => {
      try {
        const suspCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        await suspCtx.audioWorklet.addModule('/app/dsp-processor.js');
        orch._preWarmedCtx = suspCtx;
        console.info('[Orchestrator] AudioWorklet pre-warmed');
      } catch (e) {
        console.warn('[Orchestrator] Worklet prewarm failed (non-fatal):', e);
      }
    })();

    // ── Lazy init on first gesture ─────────────────────────────────────
    // We defer AudioContext creation to first user interaction to satisfy
    // autoplay policy across all browsers.
    let gestureHandled = false;
    const onFirstGesture = () => {
      if (gestureHandled) return;
      gestureHandled = true;
      orch.init().catch(e => console.warn('[Orchestrator] init error:', e));
      ['click','keydown','touchstart'].forEach(ev =>
        document.removeEventListener(ev, onFirstGesture, { capture: true })
      );
    };
    ['click','keydown','touchstart'].forEach(ev =>
      document.addEventListener(ev, onFirstGesture, { capture: true, once: false })
    );

    console.info('[Orchestrator] Bootstrap complete — awaiting first user gesture');
  }

  // window._vipApp is set synchronously at the bottom of app.js
  // (DOMContentLoaded fires before scripts appended after app.js,
  //  but this script tag comes after app.js so _vipApp is set by now).
  if (window._vipApp) {
    attach(window._vipApp);
  } else {
    // Fallback poll in case script ordering changes
    let tries = 0;
    const poll = setInterval(() => {
      if (window._vipApp) { clearInterval(poll); attach(window._vipApp); }
      else if (++tries > 100) { clearInterval(poll); console.warn('[Orchestrator] window._vipApp never set'); }
    }, 50);
  }
})();
