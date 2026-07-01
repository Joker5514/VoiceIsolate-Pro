/**
 * visuals-bootstrap.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Wires the visualization tabs to the playback analyser created in vip-fixes.js.
 *
 * What this owns (purely additive — no module imports, no STFT/iSTFT):
 *   1. Static waveform render to #waveCanvas on `vip:fileLoaded`.
 *   2. A single RAF loop driving:
 *        • #spectro2DCanvas — scrolling 2D spectrogram (Inferno LUT from visuals.js)
 *        • #freqCanvas      — frequency bar rail
 *        • LUFS readouts (#lufsI / #lufsS) — rolling 400ms short-term, 3s integrated
 *        • Header peak/RMS (#hPeak / #hRMS)
 *   3. Lazy init of premium visualizers (aura / topo / swarm / liquid)
 *      from premium-visuals.js the first time the user activates their tab.
 *   4. Wave A/B comparison render whenever a processed buffer becomes available.
 *
 * Inputs:
 *   • window._vipPlayAnalyser  → set by vip-fixes.js when play() starts
 *   • Events:  vip:fileLoaded, vip:playStarted, vip:playStopped, vip:processingDone
 *
 * Hard constraints honored:
 *   • Zero external fetches / zero network.
 *   • Loaded as a classic <script src> so it works without ESM evaluation order
 *     gymnastics. Exposes globals on window for testability.
 *   • One RAF loop total (premium tab visualizers run their own internal loops,
 *     but only one is active at a time and we stop the previous on tab switch).
 * ─────────────────────────────────────────────────────────────────────────────
 */
(function (global) {
  'use strict';

  if (global.__VIP_VISUALS_BOOT__) return;
  global.__VIP_VISUALS_BOOT__ = true;

  const $ = (id) => document.getElementById(id);

  /* ── State ────────────────────────────────────────────────────────────── */
  let _rafId = 0;
  let _running = false;
  let _activeTab = 'spectrogram';
  let _activePremium = null;   // { stop() } handle for aura/topo/swarm/liquid
  let _activePremiumTab = null;
  // Rolling spectrogram scroll position
  let _specX = 0;
  // LUFS rolling state
  let _lufsShortBuf = []; // last ~400 ms of mean-square per RAF tick
  let _lufsIntBuf   = []; // last ~3 s

  /* ── Static waveform render ───────────────────────────────────────────── */
  function _drawWaveformOnto(canvas, audioBuf, color) {
    if (!canvas || !audioBuf || !audioBuf.getChannelData) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const cssH = parseInt(getComputedStyle(canvas).height, 10) || 0;
    const bw = rect.width  > 0 ? rect.width  : (canvas.offsetWidth  || 800);
    const bh = rect.height > 0 ? rect.height : (cssH || canvas.offsetHeight || 70);
    canvas.width  = Math.floor(bw);
    canvas.height = Math.floor(bh);
    const w = canvas.width  || 800;
    const h = canvas.height || 70;
    ctx.fillStyle = '#030306';
    ctx.fillRect(0, 0, w, h);

    const data = audioBuf.getChannelData(0);
    const step = Math.max(1, Math.floor(data.length / w));
    const mid  = h / 2;

    ctx.strokeStyle = color || '#22d3ee';
    ctx.fillStyle   = (color || '#22d3ee') + '33';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let x = 0; x < w; x++) {
      let min = 1.0, max = -1.0;
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

    // Zero line
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
  }

  function drawStaticVisuals() {
    const app = global._vipApp;
    if (!app) return;
    const inBuf  = app.inputBuffer || app.origBuffer;
    const outBuf = app.outputBuffer || app.procBuffer;
    _drawWaveformOnto($('waveCanvas'), inBuf, '#22d3ee');
    _drawWaveformOnto($('waveOrigCanvas'), inBuf,  '#22d3ee');
    _drawWaveformOnto($('waveProcCanvas'), outBuf, '#69ff47');
  }

  /* ── 2D scrolling spectrogram using Inferno LUT (or fallback ramp) ────── */
  function _resizeCanvas(canvas, fallbackH) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const baseW = rect.width  > 0 ? rect.width  : (canvas.offsetWidth  || canvas.clientWidth  || 800);
    const baseH = rect.height > 0 ? rect.height : (parseInt(getComputedStyle(canvas).height, 10) || canvas.clientHeight || fallbackH || 240);
    const w = Math.round(baseW * dpr);
    const h = Math.round(baseH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    return { w, h };
  }

  function _drawSpectro2DColumn(canvas, freqBytes) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = _resizeCanvas(canvas, 240);
    try {
      ctx.drawImage(canvas, 1, 0, w - 1, h, 0, 0, w - 1, h);
    } catch (_) { ctx.clearRect(0, 0, w, h); }
    const colX = w - 1;
    const N = freqBytes.length;
    const lut = global.VIP_INFERNO_LUT;
    const colImg = ctx.createImageData(1, h);
    for (let y = 0; y < h; y++) {
      const t = 1 - (y / h);
      const idx = Math.min(N - 1, Math.floor(Math.pow(t, 2.0) * (N - 1)));
      const v = freqBytes[idx] / 255;
      let r = 0; let g = 0; let b = 0;
      if (lut) {
        const li = Math.min(255, Math.floor(v * 255)) * 3;
        r = lut[li]; g = lut[li + 1]; b = lut[li + 2];
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

  /* ── Frequency bars ───────────────────────────────────────────────────── */
  function _drawFreqBars(canvas, freqBytes) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w, h } = _resizeCanvas(canvas, 80);
    // Trail for motion blur
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
      // Color: cyan → red as frequency rises
      const hue = 180 - (b / bars) * 160;
      ctx.fillStyle = 'hsla(' + hue.toFixed(0) + ',95%,55%,0.9)';
      ctx.fillRect(b * barW + 1, h - barH, Math.max(1, barW - 2), barH);
    }
  }

  /* ── LUFS rolling estimate + header peak/RMS ──────────────────────────── */
  function _updateLufs(timeBytes, _freqBytes) {
    // K-weighted LUFS is expensive — approximate with un-weighted RMS scaled to
    // BS.1770 style ~−0.691 LU offset so the readouts feel familiar to ENGs.
    let sumSq = 0;
    let peak  = 0;
    for (let i = 0; i < timeBytes.length; i++) {
      const s = (timeBytes[i] - 128) / 128;
      const a = Math.abs(s);
      if (a > peak) peak = a;
      sumSq += s * s;
    }
    const ms = sumSq / timeBytes.length;
    _lufsShortBuf.push(ms);
    _lufsIntBuf.push(ms);
    if (_lufsShortBuf.length > 24) _lufsShortBuf.shift(); // ~400 ms @ 60 fps
    if (_lufsIntBuf.length > 180) _lufsIntBuf.shift();    // ~3 s

    const meanShort = _lufsShortBuf.reduce((a, b) => a + b, 0) / Math.max(1, _lufsShortBuf.length);
    const meanInt   = _lufsIntBuf.reduce((a, b) => a + b, 0) / Math.max(1, _lufsIntBuf.length);

    const lufsShort = meanShort > 1e-12 ? 10 * Math.log10(meanShort) - 0.691 : -70;
    const lufsInt   = meanInt   > 1e-12 ? 10 * Math.log10(meanInt)   - 0.691 : -70;

    const sEl = $('lufsS'); if (sEl) sEl.textContent = lufsShort.toFixed(1);
    const iEl = $('lufsI'); if (iEl) iEl.textContent = lufsInt.toFixed(1);

    // Header peak / rms
    const peakDb = peak > 1e-6 ? 20 * Math.log10(peak) : -60;
    const rmsDb  = meanShort > 1e-12 ? 10 * Math.log10(meanShort) : -60;
    const fmt = (v) => (v >= 0 ? '+' : '') + v.toFixed(1) + ' dB';
    const hPeak = $('hPeak'); if (hPeak) hPeak.textContent = fmt(peakDb);
    const hRMS  = $('hRMS');  if (hRMS)  hRMS.textContent  = fmt(rmsDb);

    // VU meters defined in static HTML — drive the first two as IN / OUT
    const meters = document.querySelectorAll('#panel-vu-meters .vu-meter');
    const toLevel = (db) => Math.max(0, ((db + 60) / 60) * 100).toFixed(1) + '%';
    if (meters.length >= 1) meters[0].style.setProperty('--vu-level', toLevel(rmsDb));
    if (meters.length >= 2) meters[1].style.setProperty('--vu-level', toLevel(peakDb));
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
    } catch (_) { return; }

    // Always update LUFS / header — cheap and informative across tabs
    _updateLufs(timeBytes, freqBytes);

    // Tab-targeted draws — only redraw the active tab to keep RAF light
    if (_activeTab === 'spectrogram') {
      const spec2d = $('spectro2DCanvas');
      if (spec2d) {
        if (spec2d.style.display === 'none') spec2d.style.display = '';
        _drawSpectro2DColumn(spec2d, freqBytes);
      }
      const freq = $('freqCanvas');
      if (freq) _drawFreqBars(freq, freqBytes);
    } else if (_activeTab === 'waveform') {
      // Live playhead overlay on the static waveform
      const wave = $('waveCanvas');
      const app  = global._vipApp;
      if (wave && app) {
        const buf = app.inputBuffer || app.origBuffer;
        if (buf) {
          const ctx = wave.getContext('2d');
          // Redraw static then overlay playhead (cheap — buffer is decoded once)
          _drawWaveformOnto(wave, buf, '#22d3ee');
          const playOffset = (app._fixPlayState && typeof app._fixPlayState.elapsed === 'function')
            ? app._fixPlayState.elapsed()
            : 0;
          const dur = buf.duration || 1;
          const px = (playOffset / dur) * wave.width;
          ctx.strokeStyle = '#ff2a2a';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(px, 0);
          ctx.lineTo(px, wave.height);
          ctx.stroke();
        }
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
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = 0; }
  }

  /* ── Premium visualizer lazy init on tab activation ───────────────────── */
  function _stopPremium() {
    if (_activePremium && typeof _activePremium.stop === 'function') {
      try { _activePremium.stop(); } catch (_) {}
    }
    _activePremium = null;
    _activePremiumTab = null;
  }
  function _initPremium(tabName) {
    if (_activePremiumTab === tabName && _activePremium) return; // already running
    _stopPremium();
    _activePremiumTab = tabName;
    const an = global._vipPlayAnalyser;
    if (!an) return; // analyser will appear when play() starts; we'll re-init then
    if (tabName === 'aura') {
      const c = $('auraCanvas');
      if (c && typeof global.VIP_initPulsingAura === 'function') {
        const r = c.getBoundingClientRect();
        if (r.width > 0)  c.width  = Math.floor(r.width);
        if (r.height > 0) c.height = Math.floor(r.height);
        _activePremium = global.VIP_initPulsingAura(an, c);
      }
    } else if (tabName === 'topo') {
      const cont = $('topoContainer');
      if (cont && typeof global.VIP_initTopographic3D === 'function') {
        _activePremium = global.VIP_initTopographic3D(an, cont);
      }
    } else if (tabName === 'swarm') {
      const cont = $('swarmContainer');
      if (cont && typeof global.VIP_initParticleSwarm === 'function') {
        _activePremium = global.VIP_initParticleSwarm(an, cont);
      }
    } else if (tabName === 'liquid') {
      const c = $('liquidCanvas');
      if (c && typeof global.VIP_initLiquidWaves === 'function') {
        const r = c.getBoundingClientRect();
        if (r.width > 0)  c.width  = Math.floor(r.width);
        if (r.height > 0) c.height = Math.floor(r.height);
        _activePremium = global.VIP_initLiquidWaves(an, c);
      }
    } else if (tabName === 'clusters' || tabName === 'lufs' || tabName === 'abcompare') {
      // No premium visualizer to spin up — main RAF loop already drives meters/lufs
    }
  }

  function _onTabActivated(tab) {
    _activeTab = tab;
    if (tab === 'aura' || tab === 'topo' || tab === 'swarm' || tab === 'liquid') {
      _initPremium(tab);
    } else if (tab === 'abcompare') {
      // Refresh the A/B waveform pair lazily — output buffer may have arrived
      drawStaticVisuals();
      _stopPremium();
    } else {
      _stopPremium();
    }
  }

  /* ── Listen for tab clicks via a delegated listener ───────────────────── */
  function _wireTabListener() {
    document.addEventListener('click', (e) => {
      const t = e.target && e.target.closest && e.target.closest('.tab-btn[data-tab]');
      if (!t) return;
      const tab = t.dataset.tab;
      if (!tab) return;
      _onTabActivated(tab);
    });
  }

  /* ── Event wiring ─────────────────────────────────────────────────────── */
  function _bindEvents() {
    window.addEventListener('vip:fileLoaded',     drawStaticVisuals);
    window.addEventListener('vip:processingDone', drawStaticVisuals);
    window.addEventListener('vip:playStarted', () => {
      _lufsShortBuf = [];
      _lufsIntBuf = [];
      start();
      if (_activePremiumTab) {
        _activePremium = null;
        _initPremium(_activePremiumTab);
      }
      const an = global._vipPlayAnalyser;
      if (an && global.NeonPulseViz && typeof global.NeonPulseViz.init === 'function') {
        try { global.NeonPulseViz.init(an); } catch (_) {}
      }
    });
    window.addEventListener('vip:playStopped', stop);

    // Synthesize vip:fileLoaded when buffers arrive — vip-fixes already dispatches it
    // but in case the legacy code path is used, poll briefly for first buffer.
    let polls = 0;
    const poll = setInterval(() => {
      polls++;
      const app = global._vipApp;
      if (app && (app.inputBuffer || app.origBuffer)) {
        clearInterval(poll);
        try { window.dispatchEvent(new CustomEvent('vip:fileLoaded')); } catch (_) {}
      } else if (polls > 600) { // ~60s
        clearInterval(poll);
      }
    }, 100);
  }

  function _init() {
    _wireTabListener();
    _bindEvents();
    if (global.NeonPulseViz && typeof global.NeonPulseViz.mount === 'function') {
      try { global.NeonPulseViz.mount('#neon-pulse-slot'); } catch (_) {}
    }
    // Initial render in case a file is already loaded (re-mount / hot reload)
    setTimeout(drawStaticVisuals, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
  } else {
    _init();
  }

  /* ── Export for tests / diagnostics ───────────────────────────────────── */
  global.VIP_VISUALS = {
    drawStatic: drawStaticVisuals,
    start, stop,
    onTabActivated: _onTabActivated,
    initPremium: _initPremium,
  };
})(typeof window !== 'undefined' ? window : this);
