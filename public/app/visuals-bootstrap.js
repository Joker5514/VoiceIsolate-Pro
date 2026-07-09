/**
 * visuals-bootstrap.js
 * Wires visualization tabs to the playback analyser from vip-fixes.js.
 * Supports single-tab mode and gallery (show-all) mode.
 */
(function (global) {
  'use strict';

  if (global.__VIP_VISUALS_BOOT__) return;
  global.__VIP_VISUALS_BOOT__ = true;

  const $ = (id) => document.getElementById(id);
  const qsa = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  const PREMIUM_TABS = ['aura', 'topo', 'swarm', 'liquid'];
  const CLUSTERS_TAB = 'clusters';

  /* ── State ────────────────────────────────────────────────────────────── */
  let _rafId = 0;
  let _running = false;
  let _activeTab = 'spectrogram';
  let _viewMode = 'single';
  let _premiumHandles = new Map();
  let _vizEngine = null;
  let _specX = 0;
  let _lufsShortBuf = [];
  let _lufsIntBuf = [];
  let _syntheticDiarHistory = [];
  let _lastDiarSpeaker = 0;
  let _lastDiarSegStart = 0;
  let _lastSpeakerState = null;

  function _getPlayOffset() {
    const app = global._vipApp;
    if (app && app._fixPlayState && typeof app._fixPlayState.elapsed === 'function') {
      return app._fixPlayState.elapsed();
    }
    return (app && app.playOffset) || 0;
  }

  function _isTabDrawTarget(tab) {
    if (_viewMode === 'gallery') return true;
    return tab === _activeTab;
  }

  function _panelVisible(tabName) {
    const panel = $('tab-' + tabName);
    if (!panel) return false;
    if (_viewMode === 'gallery') return true;
    return panel.classList.contains('active');
  }

  /* ── Static waveform render ───────────────────────────────────────────── */
  function _drawWaveformOnto(canvas, audioBuf, color) {
    if (!canvas || !audioBuf || !audioBuf.getChannelData) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const cssH = parseInt(getComputedStyle(canvas).height, 10) || 0;
    const bw = rect.width > 0 ? rect.width : (canvas.offsetWidth || 800);
    const bh = rect.height > 0 ? rect.height : (cssH || canvas.offsetHeight || 70);
    canvas.width = Math.floor(bw);
    canvas.height = Math.floor(bh);
    const w = canvas.width || 800;
    const h = canvas.height || 70;
    ctx.fillStyle = '#030306';
    ctx.fillRect(0, 0, w, h);

    const data = audioBuf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / w));
    const mid = h / 2;

    ctx.strokeStyle = color || '#22d3ee';
    ctx.fillStyle = (color || '#22d3ee') + '33';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let x = 0; x < w; x++) {
      let min = 1.0;
      let max = -1.0;
      const base = x * step;
      const end = Math.min(base + step, data.length);
      for (let i = base; i < end; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const yMin = mid - max * mid * 0.92;
      const yMax = mid - min * mid * 0.92;
      ctx.moveTo(x + 0.5, yMin);
      ctx.lineTo(x + 0.5, yMax);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
  }

  function _drawPlayhead(canvas, buffer, color) {
    if (!canvas || !buffer) return;
    _drawWaveformOnto(canvas, buffer, color);
    const dur = buffer.duration || 1;
    const px = (_getPlayOffset() / dur) * canvas.width;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = '#ff2a2a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, canvas.height);
    ctx.stroke();
  }

  function drawStaticVisuals() {
    const app = global._vipApp;
    if (!app) return;
    const inBuf = app.inputBuffer || app.origBuffer;
    const outBuf = app.outputBuffer || app.procBuffer;
    _drawWaveformOnto($('waveCanvas'), inBuf, '#22d3ee');
    _drawWaveformOnto($('waveOrigCanvas'), inBuf, '#22d3ee');
    _drawWaveformOnto($('waveProcCanvas'), outBuf, '#69ff47');
  }

  /* ── Canvas helpers ───────────────────────────────────────────────────── */
  function _resizeCanvas(canvas, fallbackH) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const baseW = rect.width > 0 ? rect.width : (canvas.offsetWidth || canvas.clientWidth || 800);
    const baseH = rect.height > 0 ? rect.height : (parseInt(getComputedStyle(canvas).height, 10) || canvas.clientHeight || fallbackH || 240);
    const w = Math.round(baseW * dpr);
    const h = Math.round(baseH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h };
  }

  function _resizeVisibleCanvases() {
    const targets = [
      ['spectro2DCanvas', 240],
      ['spectroCanvas', 200],
      ['freqCanvas', 80],
      ['waveCanvas', 70],
      ['waveOrigCanvas', 70],
      ['waveProcCanvas', 70],
      ['diarCanvas', 80],
      ['auraCanvas', 180],
      ['liquidCanvas', 180],
    ];
    for (const [id, h] of targets) {
      const c = $(id);
      if (c && _panelVisible(_canvasTabFor(id))) _resizeCanvas(c, h);
    }
  }

  function _canvasTabFor(id) {
    const map = {
      spectro2DCanvas: 'spectrogram',
      spectroCanvas: 'spectrogram',
      freqCanvas: 'spectrogram',
      waveCanvas: 'waveform',
      waveOrigCanvas: 'abcompare',
      waveProcCanvas: 'abcompare',
      diarCanvas: CLUSTERS_TAB,
      auraCanvas: 'aura',
      liquidCanvas: 'liquid',
    };
    return map[id] || _activeTab;
  }

  /* ── Spectrogram + frequency bars ─────────────────────────────────────── */
  function _drawSpectro2DColumn(canvas, freqBytes) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = _resizeCanvas(canvas, 240);
    try {
      ctx.drawImage(canvas, 1, 0, w - 1, h, 0, 0, w - 1, h);
    } catch (_) {
      ctx.clearRect(0, 0, w, h);
    }
    const colX = w - 1;
    const N = freqBytes.length;
    const lut = global.VIP_INFERNO_LUT;
    const colImg = ctx.createImageData(1, h);
    for (let y = 0; y < h; y++) {
      const t = 1 - (y / h);
      const idx = Math.min(N - 1, Math.floor(Math.pow(t, 2.0) * (N - 1)));
      const v = freqBytes[idx] / 255;
      let r = 0;
      let g = 0;
      let b = 0;
      if (lut) {
        const li = Math.min(255, Math.floor(v * 255)) * 3;
        r = lut[li];
        g = lut[li + 1];
        b = lut[li + 2];
      } else {
        r = Math.min(255, Math.floor(v * 320));
        g = Math.min(255, Math.floor((1 - Math.abs(v - 0.55)) * 220));
        b = Math.min(255, Math.floor((1 - v) * 220));
      }
      const pixelIdx = y * 4;
      colImg.data[pixelIdx] = r;
      colImg.data[pixelIdx + 1] = g;
      colImg.data[pixelIdx + 2] = b;
      colImg.data[pixelIdx + 3] = 255;
    }
    ctx.putImageData(colImg, colX, 0);
    _specX = (_specX + 1) % w;
  }

  function _mirrorSpectro3D() {
    const src = $('spectro2DCanvas');
    const dst = $('spectroCanvas');
    if (!src || !dst || !src.width) return;
    const ctx = dst.getContext('2d');
    if (!ctx) return;
    _resizeCanvas(dst, 200);
    ctx.drawImage(src, 0, 0, dst.width, dst.height);
  }

  function _drawFreqBars(canvas, freqBytes) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = _resizeCanvas(canvas, 80);
    ctx.fillStyle = 'rgba(3,3,6,0.45)';
    ctx.fillRect(0, 0, w, h);

    const N = freqBytes.length;
    const bars = 64;
    const step = Math.max(1, Math.floor(N / bars));
    const barW = w / bars;
    for (let b = 0; b < bars; b++) {
      let sum = 0;
      const base = b * step;
      const end = Math.min(base + step, N);
      for (let i = base; i < end; i++) sum += freqBytes[i];
      const avg = sum / (end - base);
      const v = avg / 255;
      const barH = v * h * 0.92;
      const hue = 180 - (b / bars) * 160;
      ctx.fillStyle = 'hsla(' + hue.toFixed(0) + ',95%,55%,0.9)';
      ctx.fillRect(b * barW + 1, h - barH, Math.max(1, barW - 2), barH);
    }
  }

  function _drawABCompareLive() {
    const app = global._vipApp;
    if (!app) return;
    const inBuf = app.inputBuffer || app.origBuffer;
    const outBuf = app.outputBuffer || app.procBuffer;
    if (inBuf) _drawPlayhead($('waveOrigCanvas'), inBuf, '#22d3ee');
    if (outBuf) _drawPlayhead($('waveProcCanvas'), outBuf, '#69ff47');
  }

  /* ── LUFS + header meters ─────────────────────────────────────────────── */
  function _updateLufs(timeBytes) {
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < timeBytes.length; i++) {
      const s = (timeBytes[i] - 128) / 128;
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sumSq += s * s;
    }
    const ms = sumSq / timeBytes.length;
    _lufsShortBuf.push(ms);
    _lufsIntBuf.push(ms);
    if (_lufsShortBuf.length > 24) _lufsShortBuf.shift();
    if (_lufsIntBuf.length > 180) _lufsIntBuf.shift();

    const meanShort = _lufsShortBuf.reduce((a, b) => a + b, 0) / Math.max(1, _lufsShortBuf.length);
    const meanInt = _lufsIntBuf.reduce((a, b) => a + b, 0) / Math.max(1, _lufsIntBuf.length);

    const lufsShort = meanShort > 1e-12 ? 10 * Math.log10(meanShort) - 0.691 : -70;
    const lufsInt = meanInt > 1e-12 ? 10 * Math.log10(meanInt) - 0.691 : -70;

    const sEl = $('lufsS');
    if (sEl) sEl.textContent = lufsShort.toFixed(1);
    const iEl = $('lufsI');
    if (iEl) iEl.textContent = lufsInt.toFixed(1);

    const peakDb = peak > 1e-6 ? 20 * Math.log10(peak) : -60;
    const rmsDb = meanShort > 1e-12 ? 10 * Math.log10(meanShort) : -60;
    const fmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB';
    const hPeak = $('hPeak');
    if (hPeak) hPeak.textContent = fmt(peakDb);
    const hRMS = $('hRMS');
    if (hRMS) hRMS.textContent = fmt(rmsDb);

    if (!_isTabDrawTarget(CLUSTERS_TAB)) {
      const meters = document.querySelectorAll('#panel-vu-meters .vu-meter');
      const toLevel = (db) => Math.max(0, ((db + 60) / 60) * 100).toFixed(1) + '%';
      if (meters.length >= 1) meters[0].style.setProperty('--vu-level', toLevel(rmsDb));
      if (meters.length >= 2) meters[1].style.setProperty('--vu-level', toLevel(peakDb));
    }
  }

  /* ── Synthetic diarization for clusters tab ───────────────────────────── */
  function _getSyntheticSpeakerState(freqBytes) {
    const numSpeakers = 4;
    const speakerRMS = new Float32Array(numSpeakers);
    const chunk = Math.max(1, Math.floor(freqBytes.length / numSpeakers));
    let activeSpeaker = 0;
    let maxEnergy = 0;
    for (let s = 0; s < numSpeakers; s++) {
      let sum = 0;
      for (let i = s * chunk; i < (s + 1) * chunk && i < freqBytes.length; i++) sum += freqBytes[i];
      const rms = (sum / chunk) / 255 * 0.45;
      speakerRMS[s] = rms;
      if (rms > maxEnergy) {
        maxEnergy = rms;
        activeSpeaker = s;
      }
    }

    const now = _getPlayOffset();
    if (activeSpeaker !== _lastDiarSpeaker || now - _lastDiarSegStart > 1.2) {
      if (_syntheticDiarHistory.length && _syntheticDiarHistory[_syntheticDiarHistory.length - 1].endTime === now) {
        _syntheticDiarHistory[_syntheticDiarHistory.length - 1].endTime = now;
      } else if (_lastDiarSegStart > 0) {
        _syntheticDiarHistory.push({
          speaker: _lastDiarSpeaker,
          confidence: 0.75 + Math.random() * 0.2,
          startTime: _lastDiarSegStart,
          endTime: now,
        });
      }
      _lastDiarSpeaker = activeSpeaker;
      _lastDiarSegStart = now;
      if (_syntheticDiarHistory.length > 120) _syntheticDiarHistory.shift();
    } else if (_syntheticDiarHistory.length) {
      _syntheticDiarHistory[_syntheticDiarHistory.length - 1].endTime = now;
    } else {
      _syntheticDiarHistory.push({
        speaker: activeSpeaker,
        confidence: 0.85,
        startTime: Math.max(0, now - 0.5),
        endTime: now,
      });
    }

    return {
      activeSpeaker,
      numSpeakers,
      confidence: 0.85,
      speakerRMS,
      currentTime: now,
      history: _syntheticDiarHistory,
    };
  }

  function _ensureVizEngine() {
    if (_vizEngine || typeof global.VisualizationEngine !== 'function') return;
    _vizEngine = new global.VisualizationEngine({
      vuPanel: $('panel-vu-meters'),
      diarCanvas: $('diarCanvas'),
      maxSpeakers: 4,
      getAnalysers: () => {
        const an = global._vipPlayAnalyser;
        return { orig: an, proc: an };
      },
      getSpeakerState: () => _lastSpeakerState,
    });
  }

  function _syncClustersEngine(freqBytes) {
    if (!_isTabDrawTarget(CLUSTERS_TAB)) {
      if (_vizEngine) _vizEngine.stop();
      return;
    }
    _ensureVizEngine();
    if (!_vizEngine) return;
    _lastSpeakerState = _getSyntheticSpeakerState(freqBytes);
    if (!_vizEngine._running) _vizEngine.start();
    if (_vizEngine.diarCanvas) _resizeCanvas(_vizEngine.diarCanvas, 80);
  }

  /* ── Main RAF loop ────────────────────────────────────────────────────── */
  function _loop() {
    if (!_running) return;
    _rafId = requestAnimationFrame(_loop);
    const an = global._vipPlayAnalyser;
    if (!an) return;

    const bins = an.frequencyBinCount;
    const freqBytes = new Uint8Array(bins);
    const timeBytes = new Uint8Array(bins);
    try {
      an.getByteFrequencyData(freqBytes);
      an.getByteTimeDomainData(timeBytes);
    } catch (_) {
      return;
    }

    _updateLufs(timeBytes);

    if (_isTabDrawTarget('spectrogram')) {
      const spec2d = $('spectro2DCanvas');
      if (spec2d) {
        if (spec2d.style.display === 'none') spec2d.style.display = '';
        _drawSpectro2DColumn(spec2d, freqBytes);
        _mirrorSpectro3D();
      }
      const freq = $('freqCanvas');
      if (freq) _drawFreqBars(freq, freqBytes);
    }

    if (_isTabDrawTarget('waveform')) {
      const app = global._vipApp;
      const buf = app && (app.inputBuffer || app.origBuffer);
      if (buf) _drawPlayhead($('waveCanvas'), buf, '#22d3ee');
    }

    if (_isTabDrawTarget('abcompare')) _drawABCompareLive();

    _syncClustersEngine(freqBytes);
  }

  function start() {
    if (_running) return;
    _running = true;
    _rafId = requestAnimationFrame(_loop);
  }

  function stop() {
    _running = false;
    if (_rafId) {
      cancelAnimationFrame(_rafId);
      _rafId = 0;
    }
    if (_vizEngine) _vizEngine.stop();
  }

  /* ── Premium visualizers ──────────────────────────────────────────────── */
  function _stopPremiumTab(tabName) {
    const handle = _premiumHandles.get(tabName);
    if (handle && typeof handle.stop === 'function') {
      try { handle.stop(); } catch (_) {}
    }
    _premiumHandles.delete(tabName);
  }

  function _stopAllPremium() {
    for (const tab of Array.from(_premiumHandles.keys())) _stopPremiumTab(tab);
  }

  function _initPremiumTab(tabName) {
    if (_premiumHandles.has(tabName)) return;
    if (!_panelVisible(tabName)) return;
    const an = global._vipPlayAnalyser;
    if (!an) return;

    let handle = null;
    if (tabName === 'aura') {
      const c = $('auraCanvas');
      if (c && typeof global.VIP_initPulsingAura === 'function') {
        _resizeCanvas(c, 180);
        handle = global.VIP_initPulsingAura(an, c);
      }
    } else if (tabName === 'topo') {
      const cont = $('topoContainer');
      if (cont && typeof global.VIP_initTopographic3D === 'function') {
        if (cont.clientWidth < 2) cont.style.minHeight = '180px';
        handle = global.VIP_initTopographic3D(an, cont);
      }
    } else if (tabName === 'swarm') {
      const cont = $('swarmContainer');
      if (cont && typeof global.VIP_initParticleSwarm === 'function') {
        if (cont.clientWidth < 2) cont.style.minHeight = '180px';
        handle = global.VIP_initParticleSwarm(an, cont);
      }
    } else if (tabName === 'liquid') {
      const c = $('liquidCanvas');
      if (c && typeof global.VIP_initLiquidWaves === 'function') {
        _resizeCanvas(c, 180);
        handle = global.VIP_initLiquidWaves(an, c);
      }
    }
    if (handle) _premiumHandles.set(tabName, handle);
  }

  function _syncPremiumViz() {
    const tabsToRun = _viewMode === 'gallery'
      ? PREMIUM_TABS.slice()
      : (PREMIUM_TABS.includes(_activeTab) ? [_activeTab] : []);

    for (const tab of Array.from(_premiumHandles.keys())) {
      if (!tabsToRun.includes(tab)) _stopPremiumTab(tab);
    }

    if (!global._vipPlayAnalyser) return;
    for (const tab of tabsToRun) {
      if (!_premiumHandles.has(tab)) {
        requestAnimationFrame(() => _initPremiumTab(tab));
      }
    }
  }

  /* ── View mode + tab activation ───────────────────────────────────────── */
  function _applyGalleryDom() {
    const card = document.querySelector('.viz-card');
    const btn = $('btnVizGallery');
    if (card) card.classList.toggle('viz-gallery', _viewMode === 'gallery');
    if (btn) {
      btn.classList.toggle('is-active', _viewMode === 'gallery');
      btn.setAttribute('aria-pressed', String(_viewMode === 'gallery'));
      btn.textContent = _viewMode === 'gallery' ? 'Single View' : 'Show All';
    }
    const panels = qsa('.viz-card .panel[data-viz-panel]');
    if (_viewMode === 'gallery') {
      panels.forEach((p) => p.classList.add('active'));
      qsa('.tab-btn[data-tab]').forEach((b) => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
        b.setAttribute('tabindex', '-1');
      });
    } else {
      panels.forEach((p) => p.classList.remove('active'));
      const panel = $('tab-' + _activeTab);
      const tabBtn = document.querySelector('.tab-btn[data-tab="' + _activeTab + '"]');
      if (panel) panel.classList.add('active');
      if (tabBtn) {
        tabBtn.classList.add('active');
        tabBtn.setAttribute('aria-selected', 'true');
        tabBtn.setAttribute('tabindex', '0');
      }
    }
  }

  function setViewMode(mode) {
    _viewMode = mode === 'gallery' ? 'gallery' : 'single';
    _applyGalleryDom();
    _resizeVisibleCanvases();
    _syncPremiumViz();
    try {
      window.dispatchEvent(new CustomEvent('vip:vizModeChanged', { detail: { mode: _viewMode } }));
    } catch (_) {}
  }

  function getViewMode() {
    return _viewMode;
  }

  function _onTabActivated(tab) {
    if (_viewMode === 'gallery') setViewMode('single');
    _activeTab = tab || 'spectrogram';
    if (tab === 'abcompare') drawStaticVisuals();
    _resizeVisibleCanvases();
    _syncPremiumViz();
  }

  function _wireGalleryToggle() {
    const btn = $('btnVizGallery');
    if (!btn) return;
    btn.addEventListener('click', () => {
      setViewMode(_viewMode === 'gallery' ? 'single' : 'gallery');
    });
  }

  function _wireResizeObserver() {
    const card = document.querySelector('.viz-card');
    if (!card || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      _resizeVisibleCanvases();
      _syncPremiumViz();
    });
    ro.observe(card);
  }

  /* ── Event wiring ─────────────────────────────────────────────────────── */
  function _bindEvents() {
    window.addEventListener('vip:fileLoaded', drawStaticVisuals);
    window.addEventListener('vip:processingDone', drawStaticVisuals);
    window.addEventListener('vip:playStarted', () => {
      _lufsShortBuf = [];
      _lufsIntBuf = [];
      _syntheticDiarHistory = [];
      _lastDiarSegStart = _getPlayOffset();
      start();
      _resizeVisibleCanvases();
      _syncPremiumViz();
      const an = global._vipPlayAnalyser;
      if (an && global.NeonPulseViz && typeof global.NeonPulseViz.init === 'function') {
        try { global.NeonPulseViz.init(an); } catch (_) {}
      }
    });
    window.addEventListener('vip:playStopped', () => {
      stop();
      _stopAllPremium();
    });

    let polls = 0;
    const poll = setInterval(() => {
      polls++;
      const app = global._vipApp;
      if (app && (app.inputBuffer || app.origBuffer)) {
        clearInterval(poll);
        try { window.dispatchEvent(new CustomEvent('vip:fileLoaded')); } catch (_) {}
      } else if (polls > 600) {
        clearInterval(poll);
      }
    }, 100);
  }

  function _init() {
    _wireGalleryToggle();
    _wireResizeObserver();
    _bindEvents();
    if (global.NeonPulseViz && typeof global.NeonPulseViz.mount === 'function') {
      try { global.NeonPulseViz.mount('#neon-pulse-slot'); } catch (_) {}
    }
    setTimeout(drawStaticVisuals, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
  } else {
    _init();
  }

  global.VIP_VISUALS = {
    drawStatic: drawStaticVisuals,
    start,
    stop,
    onTabActivated: _onTabActivated,
    initPremium: _initPremiumTab,
    setViewMode,
    getViewMode,
    syncPremium: _syncPremiumViz,
  };
})(typeof window !== 'undefined' ? window : this);