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
  let _vizFullscreen = false;
  let _roRaf = 0;
  let _roScheduled = false;
  let _freqScratch = null;
  let _timeScratch = null;
  let _waveBaseCache = new WeakMap();
  let _playheadPxCache = new WeakMap();

  function _getPlayOffset() {
    const app = global._vipApp;
    if (app && typeof app._getTransportPosition === 'function') {
      return app._getTransportPosition();
    }
    if (app && app._fixPlayState && typeof app._fixPlayState.elapsed === 'function') {
      return app._fixPlayState.elapsed();
    }
    return (app && app.playOffset) || 0;
  }

  function _getAnalyser() {
    if (global._vipPlayAnalyser) return global._vipPlayAnalyser;
    const app = global._vipApp;
    if (app && typeof app._ensurePlaybackAnalyser === 'function') {
      try { return app._ensurePlaybackAnalyser(); } catch (_) {}
    }
    const bridge = app && app._bridge;
    if (bridge && typeof bridge.getAnalyser === 'function') {
      try {
        const an = bridge.getAnalyser();
        if (an) {
          global._vipPlayAnalyser = an;
          return an;
        }
      } catch (_) {}
    }
    if (app && app._fixPlayState && app._fixPlayState.analyser) {
      global._vipPlayAnalyser = app._fixPlayState.analyser;
      return global._vipPlayAnalyser;
    }
    return null;
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

  /* ── Static waveform render (cached — playhead overlays only during playback) ── */
  function _waveCacheKey(audioBuf, color) {
    return (audioBuf.length || 0) + ':' + (audioBuf.sampleRate || 0) + ':' + (color || '');
  }

  function _drawWaveformBase(canvas, audioBuf, color) {
    if (!canvas || !audioBuf || !audioBuf.getChannelData) return false;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    const { w, h } = _resizeCanvas(canvas, 70);
    const cacheKey = _waveCacheKey(audioBuf, color);
    const cached = _waveBaseCache.get(canvas);
    if (cached && cached.key === cacheKey && cached.w === w && cached.h === h) {
      ctx.putImageData(cached.image, 0, 0);
      return true;
    }

    const data = audioBuf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / w));
    const mid = h / 2;

    ctx.fillStyle = '#030306';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = color || '#22d3ee';
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

    try {
      _waveBaseCache.set(canvas, {
        key: cacheKey,
        w,
        h,
        image: ctx.getImageData(0, 0, w, h),
      });
    } catch (_) {}
    _playheadPxCache.delete(canvas);
    return true;
  }

  function _drawWaveformOnto(canvas, audioBuf, color) {
    _drawWaveformBase(canvas, audioBuf, color);
  }

  function _drawPlayhead(canvas, buffer, color, positionSec) {
    if (!canvas || !buffer) return;
    if (!_drawWaveformBase(canvas, buffer, color)) return;
    const dur = buffer.duration || 1;
    const offset = (typeof positionSec === 'number' && Number.isFinite(positionSec))
      ? positionSec
      : _getPlayOffset();
    const px = Math.round((offset / dur) * canvas.width);
    const lastPx = _playheadPxCache.get(canvas);
    if (lastPx === px) return;
    _playheadPxCache.set(canvas, px);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.strokeStyle = '#ff2a2a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, canvas.height);
    ctx.stroke();
  }

  function paintPlayheads(positionSec) {
    const app = global._vipApp;
    if (!app) return;
    const inBuf = app.inputBuffer || app.origBuffer;
    const outBuf = app.outputBuffer || app.procBuffer;
    if (_isTabDrawTarget('waveform') && inBuf) {
      _drawPlayhead($('waveCanvas'), inBuf, '#22d3ee', positionSec);
    }
    if (_isTabDrawTarget('abcompare')) {
      if (inBuf) _drawPlayhead($('waveOrigCanvas'), inBuf, '#22d3ee', positionSec);
      if (outBuf) _drawPlayhead($('waveProcCanvas'), outBuf, '#69ff47', positionSec);
    }
  }

  function drawStaticVisuals() {
    _waveBaseCache = new WeakMap();
    _playheadPxCache = new WeakMap();
    _resetCanvasDimCache();
    const app = global._vipApp;
    if (!app) return;
    const inBuf = app.inputBuffer || app.origBuffer;
    const outBuf = app.outputBuffer || app.procBuffer;
    _drawWaveformOnto($('waveCanvas'), inBuf, '#22d3ee');
    _drawWaveformOnto($('waveOrigCanvas'), inBuf, '#22d3ee');
    _drawWaveformOnto($('waveProcCanvas'), outBuf, '#69ff47');

    const specBuf = outBuf || inBuf;
    if (specBuf && typeof global.VIP_drawStaticSpectrogram === 'function') {
      const spec2d = $('spectro2DCanvas');
      const spec3d = $('spectroCanvas');
      try {
        global.VIP_drawStaticSpectrogram(spec2d, specBuf);
        if (spec2d && spec3d && spec2d.width) {
          const ctx = spec3d.getContext('2d');
          if (ctx) {
            _resizeCanvas(spec3d, 200);
            ctx.drawImage(spec2d, 0, 0, spec3d.width, spec3d.height);
          }
        }
      } catch (_) {}
    }
  }

  /* ── Canvas helpers ───────────────────────────────────────────────────── */
  function _resizeCanvas(canvas, fallbackH) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(
      rect.width > 0 ? rect.width : (canvas.offsetWidth || canvas.clientWidth || 800),
    ));
    const cssH = Math.max(1, Math.round(
      rect.height > 0
        ? rect.height
        : (parseInt(getComputedStyle(canvas).height, 10) || canvas.clientHeight || fallbackH || 240),
    ));
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    const prev = canvas.dataset.vipCssSize || '';
    const next = cssW + 'x' + cssH;
    if (canvas.width !== w || canvas.height !== h || prev !== next) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      canvas.dataset.vipCssSize = next;
      _playheadPxCache.delete(canvas);
    }
    return { w, h, cssW, cssH };
  }

  function _resetCanvasDimCache() {
    _spectroDims = null;
    _freqDims = null;
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
    let changed = false;
    for (const [id, h] of targets) {
      const c = $(id);
      if (!c || !_panelVisible(_canvasTabFor(id))) continue;
      const prev = c.dataset.vipCssSize || '';
      _resizeCanvas(c, h);
      if ((c.dataset.vipCssSize || '') !== prev) changed = true;
    }
    if (changed) {
      _resetCanvasDimCache();
      _waveBaseCache = new WeakMap();
      _playheadPxCache = new WeakMap();
    }
  }

  function _resizePremiumContainers() {
    for (const handle of _premiumHandles.values()) {
      if (handle && typeof handle.resize === 'function') {
        try { handle.resize(); } catch (_) {}
      }
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
  let _spectroDims = null;

  function _drawSpectro2DColumn(canvas, freqBytes) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!_spectroDims || _spectroDims.canvas !== canvas) {
      _spectroDims = { canvas, ..._resizeCanvas(canvas, 240) };
    }
    const { w, h } = _spectroDims;
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

  let _freqDims = null;

  function _drawFreqBars(canvas, freqBytes) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (!_freqDims || _freqDims.canvas !== canvas) {
      _freqDims = { canvas, ..._resizeCanvas(canvas, 80) };
    }
    const { w, h } = _freqDims;
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
    const an = _getAnalyser();
    if (!an) return;

    const bins = an.frequencyBinCount;
    if (!_freqScratch || _freqScratch.length !== bins) {
      _freqScratch = new Uint8Array(bins);
      _timeScratch = new Uint8Array(bins);
    }
    try {
      an.getByteFrequencyData(_freqScratch);
      an.getByteTimeDomainData(_timeScratch);
    } catch (_) {
      return;
    }

    _updateLufs(_timeScratch);

    if (_isTabDrawTarget('spectrogram')) {
      const spec2d = $('spectro2DCanvas');
      if (spec2d) {
        if (spec2d.style.display === 'none') spec2d.style.display = '';
        _drawSpectro2DColumn(spec2d, _freqScratch);
        _mirrorSpectro3D();
      }
      const freq = $('freqCanvas');
      if (freq) _drawFreqBars(freq, _freqScratch);
    }

    if (_isTabDrawTarget('waveform')) {
      const app = global._vipApp;
      const buf = app && (app.inputBuffer || app.origBuffer);
      if (buf) _drawPlayhead($('waveCanvas'), buf, '#22d3ee');
    }

    if (_isTabDrawTarget('abcompare')) _drawABCompareLive();

    _syncClustersEngine(_freqScratch);

    for (const handle of _premiumHandles.values()) {
      if (handle && typeof handle.tick === 'function') {
        try { handle.tick(); } catch (_) {}
      }
    }
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
    const an = _getAnalyser();
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

    if (!_getAnalyser()) return;
    for (const tab of tabsToRun) {
      if (!_premiumHandles.has(tab)) _initPremiumTab(tab);
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
    _activeTab = tab || 'spectrogram';
    if (tab === 'abcompare') drawStaticVisuals();
    _resizeVisibleCanvases();
    _syncPremiumViz();
  }

  function _activateTab(tab, btn) {
    if (!tab) return;
    if (_viewMode === 'gallery') setViewMode('single');
    const tabs = qsa('.viz-card .tab-btn[data-tab]');
    tabs.forEach((b) => {
      const on = b === btn || b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
      b.setAttribute('tabindex', on ? '0' : '-1');
    });
    qsa('.viz-card .panel[data-viz-panel]').forEach((p) => {
      p.classList.toggle('active', p.dataset.vizPanel === tab);
    });
    _onTabActivated(tab);
  }

  function _docFullscreenEl() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement || null;
  }

  function _exitVizFullscreen() {
    const card = document.querySelector('.viz-card');
    const btn = $('fullscreenSpectroBtn');
    _vizFullscreen = false;
    if (card) card.classList.remove('viz-fullscreen');
    $('spectro3d-container')?.classList.remove('fullscreen');
    if (btn) {
      btn.setAttribute('aria-pressed', 'false');
      btn.title = 'Enter fullscreen';
      btn.setAttribute('aria-label', 'Enter fullscreen');
    }
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (_docFullscreenEl() && exit) {
      try { Promise.resolve(exit.call(document)).catch(() => {}); } catch (_) {}
    }
    setTimeout(() => {
      _resizeVisibleCanvases();
      _syncPremiumViz();
    }, 120);
  }

  function _enterVizFullscreen() {
    const card = document.querySelector('.viz-card');
    const target = card || $('spectro3d-container') || $('spectroCanvas');
    const btn = $('fullscreenSpectroBtn');
    if (!target) return;
    _vizFullscreen = true;
    if (card) card.classList.add('viz-fullscreen');
    $('spectro3d-container')?.classList.add('fullscreen');
    if (btn) {
      btn.setAttribute('aria-pressed', 'true');
      btn.title = 'Exit fullscreen';
      btn.setAttribute('aria-label', 'Exit fullscreen');
    }
    const req = target.requestFullscreen
      || target.webkitRequestFullscreen
      || target.msRequestFullscreen;
    if (req) {
      try {
        Promise.resolve(req.call(target)).catch(() => {});
      } catch (_) {}
    }
    setTimeout(() => {
      _resizeVisibleCanvases();
      _syncPremiumViz();
    }, 120);
  }

  function toggleFullscreen() {
    if (_vizFullscreen || _docFullscreenEl()) _exitVizFullscreen();
    else _enterVizFullscreen();
  }

  function _wireFullscreen() {
    const btn = $('fullscreenSpectroBtn');
    if (!btn || btn.dataset.vipVizWired === '1') return;
    btn.dataset.vipVizWired = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleFullscreen();
    });
    document.addEventListener('fullscreenchange', () => {
      if (!_docFullscreenEl() && _vizFullscreen) _exitVizFullscreen();
      else if (_docFullscreenEl()) {
        _vizFullscreen = true;
        document.querySelector('.viz-card')?.classList.add('viz-fullscreen');
      }
      setTimeout(() => {
        _resizeVisibleCanvases();
        _syncPremiumViz();
      }, 80);
    });
    document.addEventListener('webkitfullscreenchange', () => {
      if (!_docFullscreenEl() && _vizFullscreen) _exitVizFullscreen();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && (_vizFullscreen || _docFullscreenEl())) {
        _exitVizFullscreen();
      }
    });
  }

  function _wireTabBar() {
    const bar = $('tabBar');
    if (!bar || bar.dataset.vipVizWired === '1') return;
    bar.dataset.vipVizWired = '1';
    const tabs = qsa('.viz-card .tab-btn[data-tab]');

    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('.tab-btn[data-tab]');
      if (!btn || !bar.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      _activateTab(btn.dataset.tab, btn);
    });

    tabs.forEach((btn, index) => {
      btn.addEventListener('keydown', (e) => {
        let newIndex = index;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          newIndex = (index + 1) % tabs.length;
          e.preventDefault();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          newIndex = (index - 1 + tabs.length) % tabs.length;
          e.preventDefault();
        } else if (e.key === 'Home') {
          newIndex = 0;
          e.preventDefault();
        } else if (e.key === 'End') {
          newIndex = tabs.length - 1;
          e.preventDefault();
        } else {
          return;
        }
        tabs[newIndex].focus();
        _activateTab(tabs[newIndex].dataset.tab, tabs[newIndex]);
      });
    });
  }

  function _wireGalleryToggle() {
    const btn = $('btnVizGallery');
    if (!btn || btn.dataset.vipVizWired === '1') return;
    btn.dataset.vipVizWired = '1';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setViewMode(_viewMode === 'gallery' ? 'single' : 'gallery');
    });
  }

  function wireChrome() {
    _wireGalleryToggle();
    _wireFullscreen();
    _wireTabBar();
  }

  function _scheduleLayoutResize() {
    if (_roScheduled) return;
    _roScheduled = true;
    cancelAnimationFrame(_roRaf);
    _roRaf = requestAnimationFrame(() => {
      _roScheduled = false;
      _resizeVisibleCanvases();
      _resizePremiumContainers();
    });
  }

  function _wireResizeObserver() {
    const card = document.querySelector('.viz-card');
    if (!card || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => _scheduleLayoutResize());
    ro.observe(card);
    const onViewportChange = () => {
      setTimeout(_scheduleLayoutResize, 180);
    };
    window.addEventListener('orientationchange', onViewportChange);
    window.addEventListener('resize', onViewportChange);
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
      const an = _getAnalyser();
      if (an && global.NeonPulseViz && typeof global.NeonPulseViz.init === 'function') {
        try { global.NeonPulseViz.init(an); } catch (_) {}
      }
    });
    window.addEventListener('vip:playStopped', () => {
      stop();
      _stopAllPremium();
    });
    window.addEventListener('vip:transportTick', (e) => {
      const pos = e && e.detail && typeof e.detail.position === 'number'
        ? e.detail.position
        : _getPlayOffset();
      paintPlayheads(pos);
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
    wireChrome();
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
    paintPlayheads,
    start,
    stop,
    onTabActivated: _onTabActivated,
    activateTab: _activateTab,
    initPremium: _initPremiumTab,
    setViewMode,
    getViewMode,
    syncPremium: _syncPremiumViz,
    toggleFullscreen,
    wireChrome,
  };
})(typeof window !== 'undefined' ? window : this);