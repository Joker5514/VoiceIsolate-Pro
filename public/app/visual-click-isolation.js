/**
 * visual-click-isolation.js
 * VoiceIsolate Pro — click-to-isolate on visual canvases
 *
 * 100% local. Reads frequency data from window._vipPlayAnalyser only.
 * Routes isolation changes via CustomEvents → vip-fixes.js / VIP_ISOLATION_BUS.
 */
(function visualClickIsolation(global) {
  'use strict';

  const NUM_BARS = 64;
  const STEM_CYCLE = ['vocals', 'accompaniment', 'drums', 'all'];
  const STEM_LABELS = {
    vocals: 'VOCALS SOLO',
    accompaniment: 'INSTRUMENTS SOLO',
    drums: 'DRUMS SOLO',
    all: 'ALL STEMS',
  };

  const _stemIdxByTarget = new WeakMap();
  let _tooltipEl = null;
  let _tooltipTimer = 0;

  if (!global.VIP_ISOLATION_BUS) {
    global.VIP_ISOLATION_BUS = {
      emit(type, detail) {
        try { global.dispatchEvent(new CustomEvent(type, { detail: detail || {} })); } catch (_) {}
      },
    };
  }

  function $(id) { return document.getElementById(id); }

  function getAnalyser() {
    return global._vipPlayAnalyser || null;
  }

  function getSampleRate() {
    const ctx = global._vipApp?.ctx || global._vipOrch?.ctx || global.audioCtx;
    return ctx?.sampleRate || 44100;
  }

  function hasAudioLoaded() {
    const app = global._vipApp;
    return !!(app && (app.inputBuffer || app.outputBuffer || app.origBuffer || app.procBuffer));
  }

  function canInteract() {
    return hasAudioLoaded() || !!getAnalyser();
  }

  function fmtHz(hz) {
    if (hz >= 1000) return (hz / 1000).toFixed(hz >= 10000 ? 0 : 1) + 'kHz';
    return Math.round(hz) + 'Hz';
  }

  function binToHz(bin, binCount) {
    const nyquist = getSampleRate() / 2;
    return (bin / Math.max(1, binCount)) * nyquist;
  }

  function showTooltip(target, message) {
    if (!_tooltipEl) {
      _tooltipEl = document.createElement('div');
      _tooltipEl.className = 'viz-iso-tooltip';
      _tooltipEl.setAttribute('role', 'status');
      document.body.appendChild(_tooltipEl);
    }
    const rect = target.getBoundingClientRect();
    _tooltipEl.textContent = message;
    _tooltipEl.style.left = (rect.left + rect.width / 2) + 'px';
    _tooltipEl.style.top = (rect.top + 8) + 'px';
    _tooltipEl.classList.add('visible');
    clearTimeout(_tooltipTimer);
    _tooltipTimer = setTimeout(() => { _tooltipEl.classList.remove('visible'); }, 1800);
  }

  function ensureRelativeParent(el) {
    if (!el) return;
    const pos = getComputedStyle(el).position;
    if (pos === 'static' || !pos) el.style.position = 'relative';
  }

  function ensureOverlay(canvas) {
    if (!canvas || !canvas.id) return null;
    const parent = canvas.parentElement;
    if (!parent) return null;
    ensureRelativeParent(parent);
    const sel = '.viz-iso-overlay[data-for="' + canvas.id + '"]';
    let ov = parent.querySelector(sel);
    if (!ov) {
      ov = document.createElement('canvas');
      ov.className = 'viz-iso-overlay';
      ov.dataset.for = canvas.id;
      ov.setAttribute('aria-hidden', 'true');
      ov.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:3';
      parent.appendChild(ov);
    }
    return ov;
  }

  function syncOverlaySize(canvas, overlay) {
    if (!canvas || !overlay) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = global.devicePixelRatio || 1;
    const w = Math.max(1, Math.floor((canvas.width || rect.width * dpr)));
    const h = Math.max(1, Math.floor((canvas.height || rect.height * dpr)));
    overlay.width = w;
    overlay.height = h;
    overlay.style.width = rect.width + 'px';
    overlay.style.height = rect.height + 'px';
  }

  function clearOverlay(overlay) {
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, overlay.width, overlay.height);
  }

  function pointerCanvasX(canvas, e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = (e.touches && e.touches.length) ? e.touches[0].clientX : e.clientX;
    const scale = (canvas.width || rect.width) / Math.max(1, rect.width);
    return Math.max(0, Math.min(canvas.width || rect.width, (clientX - rect.left) * scale));
  }

  function logBinFromX(x, canvasWidth, logScale) {
    const an = getAnalyser();
    const binCount = an ? an.frequencyBinCount : 1024;
    const t = Math.max(0, Math.min(1, x / Math.max(1, canvasWidth)));
    if (logScale) {
      return Math.floor(Math.pow(t, 2.0) * binCount);
    }
    return Math.floor(t * binCount);
  }

  function linearBarFromX(x, canvasWidth) {
    const t = Math.max(0, Math.min(1, x / Math.max(1, canvasWidth)));
    return Math.floor(t * NUM_BARS);
  }

  function drawBandOverlay(overlay, x1, x2, label, color) {
    if (!overlay) return;
    const ctx = overlay.getContext('2d');
    if (!ctx) return;
    const w = overlay.width;
    const h = overlay.height;
    ctx.clearRect(0, 0, w, h);
    const left = Math.min(x1, x2);
    const width = Math.max(2, Math.abs(x2 - x1));
    const fill = color || 'rgba(0,255,231,0.18)';
    const stroke = color ? 'rgba(105,255,71,0.75)' : 'rgba(0,255,231,0.65)';
    ctx.fillStyle = fill;
    ctx.fillRect(left, 0, width, h);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.strokeRect(left + 0.5, 0.5, Math.max(0, width - 1), h - 1);
    if (label) {
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillStyle = color ? '#69ff47' : '#00ffe7';
      ctx.fillText(label, left + 4, 14);
    }
  }

  function updateSpecBadge(freqLow, freqHigh, active) {
    const badge = $('iso-badge-spec');
    if (!badge) return;
    if (!active) {
      badge.textContent = '';
      badge.classList.add('hidden');
      badge.classList.remove('active');
      return;
    }
    badge.textContent = 'ISO: ' + fmtHz(freqLow) + ' – ' + fmtHz(freqHigh);
    badge.classList.remove('hidden');
    badge.classList.add('active');
  }

  function bindSpectrogramCanvas(canvas, source) {
    if (!canvas) return;
    const overlay = ensureOverlay(canvas);
    let dragging = false;
    let startX = 0;
    let curX = 0;
    let lastDown = 0;
    let selLow = 0;
    let selHigh = 0;

    function redraw() {
      if (!dragging && selLow === selHigh && selLow === 0) {
        clearOverlay(overlay);
        return;
      }
      syncOverlaySize(canvas, overlay);
      const an = getAnalyser();
      const binCount = an ? an.frequencyBinCount : 1024;
      const lo = Math.min(selLow, selHigh);
      const hi = Math.max(selLow, selHigh);
      const freqLow = binToHz(lo, binCount);
      const freqHigh = binToHz(Math.max(lo + 1, hi), binCount);
      const label = 'ISO: ' + fmtHz(freqLow) + ' – ' + fmtHz(freqHigh);
      drawBandOverlay(overlay, lo / binCount * canvas.width, hi / binCount * canvas.width, label);
    }

    function onDown(e) {
      if (!canInteract()) {
        showTooltip(canvas, 'Load audio first');
        return;
      }
      const now = Date.now();
      if (now - lastDown < 320) {
        selLow = 0;
        selHigh = 0;
        clearOverlay(overlay);
        updateSpecBadge(0, 0, false);
        global.dispatchEvent(new CustomEvent('vip:isolationBandClear'));
        lastDown = 0;
        return;
      }
      lastDown = now;
      dragging = true;
      const w = canvas.width || canvas.getBoundingClientRect().width;
      startX = pointerCanvasX(canvas, e);
      curX = startX;
      const bin = logBinFromX(startX, w, true);
      selLow = bin;
      selHigh = bin;
      syncOverlaySize(canvas, overlay);
      drawBandOverlay(overlay, startX, startX, null);
      if (e.type === 'touchstart') e.preventDefault();
    }

    function onMove(e) {
      if (!dragging) return;
      curX = pointerCanvasX(canvas, e);
      const w = canvas.width || canvas.getBoundingClientRect().width;
      const b1 = logBinFromX(startX, w, true);
      const b2 = logBinFromX(curX, w, true);
      selLow = Math.min(b1, b2);
      selHigh = Math.max(b1, b2);
      syncOverlaySize(canvas, overlay);
      const an = getAnalyser();
      const binCount = an ? an.frequencyBinCount : 1024;
      const freqLow = binToHz(selLow, binCount);
      const freqHigh = binToHz(Math.max(selLow + 1, selHigh), binCount);
      drawBandOverlay(overlay,
        (selLow / binCount) * w,
        (selHigh / binCount) * w,
        'ISO: ' + fmtHz(freqLow) + ' – ' + fmtHz(freqHigh));
      if (e.type === 'touchmove') e.preventDefault();
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      const an = getAnalyser();
      const binCount = an ? an.frequencyBinCount : 1024;
      const freqLow = binToHz(selLow, binCount);
      const freqHigh = binToHz(Math.max(selLow + 1, selHigh), binCount);
      updateSpecBadge(freqLow, freqHigh, true);
      global.dispatchEvent(new CustomEvent('vip:isolationBandSet', {
        detail: { freqLow, freqHigh, source: source },
      }));
      global.VIP_ISOLATION_BUS.emit('vip:isolationBandSet', { freqLow, freqHigh, source: source });
    }

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', () => { if (dragging) onUp(); });
    canvas.addEventListener('touchstart', onDown, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onUp, { passive: true });
    canvas.addEventListener('dblclick', () => {
      selLow = 0;
      selHigh = 0;
      clearOverlay(overlay);
      updateSpecBadge(0, 0, false);
      global.dispatchEvent(new CustomEvent('vip:isolationBandClear'));
    });
  }

  function bindFreqCanvas(canvas) {
    if (!canvas) return;
    const overlay = ensureOverlay(canvas);
    let dragging = false;
    let startX = 0;
    let barLo = 0;
    let barHi = 0;
    let lastDown = 0;
    const nyquist = () => getSampleRate() / 2;

    function barsToHz(lo, hi) {
      const n = nyquist();
      return {
        freqLow: (lo / NUM_BARS) * n,
        freqHigh: (Math.max(lo + 1, hi) / NUM_BARS) * n,
      };
    }

    function drawFreqSelection() {
      syncOverlaySize(canvas, overlay);
      const w = canvas.width || overlay.width;
      const barW = w / NUM_BARS;
      const ctx = overlay.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      const lo = Math.min(barLo, barHi);
      const hi = Math.max(barLo, barHi);
      for (let b = lo; b <= hi; b++) {
        const x = b * barW;
        const grad = ctx.createLinearGradient(x, overlay.height, x, 0);
        grad.addColorStop(0, 'rgba(255,255,255,0.05)');
        grad.addColorStop(1, 'rgba(255,255,255,0.55)');
        ctx.fillStyle = grad;
        ctx.fillRect(x + 1, 0, Math.max(1, barW - 2), overlay.height);
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(x + 1, 0, Math.max(1, barW - 2), 3);
      }
      const hz = barsToHz(lo, hi);
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillStyle = '#00ffe7';
      ctx.fillText('ISO: ' + fmtHz(hz.freqLow) + ' – ' + fmtHz(hz.freqHigh), lo * barW + 4, 14);
    }

    function onDown(e) {
      if (!canInteract()) {
        showTooltip(canvas, 'Load audio first');
        return;
      }
      dragging = true;
      startX = pointerCanvasX(canvas, e);
      const w = canvas.width || canvas.getBoundingClientRect().width;
      const b = linearBarFromX(startX, w);
      barLo = b;
      barHi = b;
      drawFreqSelection();
      if (e.type === 'touchstart') e.preventDefault();
    }

    function onMove(e) {
      if (!dragging) return;
      const w = canvas.width || canvas.getBoundingClientRect().width;
      const x = pointerCanvasX(canvas, e);
      const b1 = linearBarFromX(startX, w);
      const b2 = linearBarFromX(x, w);
      barLo = Math.min(b1, b2);
      barHi = Math.max(b1, b2);
      drawFreqSelection();
      if (e.type === 'touchmove') e.preventDefault();
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      const hz = barsToHz(barLo, barHi);
      updateSpecBadge(hz.freqLow, hz.freqHigh, true);
      global.dispatchEvent(new CustomEvent('vip:isolationBandSet', {
        detail: { freqLow: hz.freqLow, freqHigh: hz.freqHigh, source: 'freq-bars' },
      }));
    }

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', () => { if (dragging) onUp(); });
    canvas.addEventListener('touchstart', onDown, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onUp, { passive: true });
    canvas.addEventListener('dblclick', () => {
      barLo = 0;
      barHi = 0;
      clearOverlay(overlay);
      updateSpecBadge(0, 0, false);
      global.dispatchEvent(new CustomEvent('vip:isolationBandClear'));
    });
  }

  function bindWaveCanvas(canvas) {
    if (!canvas) return;
    const overlay = ensureOverlay(canvas);
    let dragging = false;
    let startX = 0;
    let loopStart = null;
    let loopEnd = null;

    function drawLoop() {
      syncOverlaySize(canvas, overlay);
      if (loopStart == null || loopEnd == null) {
        clearOverlay(overlay);
        return;
      }
      const w = canvas.width || overlay.width;
      const x1 = Math.min(loopStart, loopEnd) * w;
      const x2 = Math.max(loopStart, loopEnd) * w;
      drawBandOverlay(overlay, x1, x2, null, 'rgba(105,255,71,0.22)');
    }

    function onDown(e) {
      if (!canInteract()) {
        showTooltip(canvas, 'Load audio first');
        return;
      }
      const w = canvas.width || canvas.getBoundingClientRect().width;
      const x = pointerCanvasX(canvas, e);
      const ratio = x / Math.max(1, w);

      if (!dragging && !(e.shiftKey || e.altKey)) {
        global.dispatchEvent(new CustomEvent('vip:seekRequest', { detail: { ratio } }));
      }

      dragging = true;
      startX = ratio;
      loopStart = ratio;
      loopEnd = ratio;
      drawLoop();
      if (e.type === 'touchstart') e.preventDefault();
    }

    function onMove(e) {
      if (!dragging) return;
      const w = canvas.width || canvas.getBoundingClientRect().width;
      loopEnd = pointerCanvasX(canvas, e) / Math.max(1, w);
      drawLoop();
      if (e.type === 'touchmove') e.preventDefault();
    }

    function onUp() {
      if (!dragging) return;
      dragging = false;
      if (loopStart != null && loopEnd != null && Math.abs(loopEnd - loopStart) > 0.01) {
        const startRatio = Math.min(loopStart, loopEnd);
        const endRatio = Math.max(loopStart, loopEnd);
        global.dispatchEvent(new CustomEvent('vip:loopRegionSet', {
          detail: { startRatio, endRatio },
        }));
      }
    }

    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseup', onUp);
    canvas.addEventListener('mouseleave', () => { if (dragging) onUp(); });
    canvas.addEventListener('touchstart', onDown, { passive: false });
    canvas.addEventListener('touchmove', onMove, { passive: false });
    canvas.addEventListener('touchend', onUp, { passive: true });
    canvas.addEventListener('dblclick', () => {
      loopStart = null;
      loopEnd = null;
      clearOverlay(overlay);
      global.dispatchEvent(new CustomEvent('vip:loopRegionClear', { detail: {} }));
    });
  }

  function setStemBadge(badge, stem) {
    if (!badge) return;
    if (!stem || stem === 'all') {
      badge.textContent = '';
      badge.classList.add('hidden');
      badge.classList.remove('active');
      return;
    }
    badge.textContent = STEM_LABELS[stem] || (stem.toUpperCase() + ' SOLO');
    badge.classList.remove('hidden');
    badge.classList.add('active');
  }

  function bindStemClick(target, badge) {
    if (!target) return;
    ensureRelativeParent(target);

    function onClick(e) {
      if (!canInteract()) {
        showTooltip(target, 'Load audio first');
        return;
      }
      let idx = _stemIdxByTarget.get(target) || 0;
      idx = (idx + 1) % STEM_CYCLE.length;
      _stemIdxByTarget.set(target, idx);
      const stem = STEM_CYCLE[idx];
      setStemBadge(badge, stem === 'all' ? null : stem);
      global.dispatchEvent(new CustomEvent('vip:stemToggle', { detail: { stem } }));
      global.VIP_ISOLATION_BUS.emit('vip:stemToggle', { stem });
      if (e.type === 'touchstart') e.preventDefault();
    }

    target.addEventListener('click', onClick);
    target.addEventListener('touchstart', onClick, { passive: false });
  }

  function init() {
    bindSpectrogramCanvas($('spectro2DCanvas'), 'spectrogram');
    bindSpectrogramCanvas($('spectroCanvas'), 'spectrogram-3d');
    bindFreqCanvas($('freqCanvas'));
    bindWaveCanvas($('waveCanvas'));

    bindStemClick($('auraCanvas'), $('iso-badge-aura'));
    bindStemClick($('liquidCanvas'), $('iso-badge-liquid'));
    bindStemClick($('topoContainer'), $('iso-badge-topo'));
    bindStemClick($('swarmContainer'), $('iso-badge-swarm'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  global.VIP_CLICK_ISOLATION = { init, STEM_CYCLE, NUM_BARS };
})(typeof window !== 'undefined' ? window : this);