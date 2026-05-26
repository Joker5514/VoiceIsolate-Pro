/**
 * VoiceIsolate Pro — vip-fixes.js  v1.0.0
 *
 * Comprehensive runtime patch:
 *   1. Play/Pause/Stop — correct state machine, icon toggle, offset math,
 *      AudioContext auto-resume, no double-source stacking
 *   2. A/B switcher — finally-block enable guard, safe _setABLabel
 *      (no textContent nuke), X-key shortcut
 *   3. Slider search — .includes() typo fix
 *   4. Speed ± buttons — step through <select> options + live playbackRate
 *   5. Accordion groups — click-to-expand wired correctly
 *   6. Preset <select> — wired to applyPreset()
 *   7. window.VIP_DEBUG_REPORT() — full JSON snapshot from DevTools
 *
 * Import LAST in index.html (after vip-enhancements.js).
 * Zero external dependencies.
 */
(function vipFixes() {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function log(msg, data) {
    if (window.VIP_DEBUG) console.log('[VIP-FIX]', msg, data !== undefined ? data : '');
  }
  function warn(msg, data) {
    console.warn('[VIP-FIX]', msg, data !== undefined ? data : '');
  }

  /* ═══════════════════════════════════════════════════════════════
   * 1. TRANSPORT — play / pause / stop / seek
   * ═══════════════════════════════════════════════════════════════ */
  function patchTransport(app) {
    if (!app || app._fixTransportPatched) return;
    app._fixTransportPatched = true;
    log('Patching transport');

    /* ── State ── */
    let _isPlaying   = false;
    let _startTime   = 0;    // audioCtx.currentTime when play() called
    let _pauseOffset = 0;    // accumulated seconds before last pause
    let _duration    = 0;
    let _rafId       = 0;
    let _seeking     = false;
    let _source      = null;
    let _gainNode    = null;

    /* ── Helpers ── */
    function _fmt(sec) {
      const s = Math.max(0, Math.floor(sec || 0));
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    function _getCtx() {
      return app.ctx || window._vipOrch?.ctx || window.audioCtx || null;
    }

    function _getBuffer() {
      const mode = app.abMode || 'original';
      if (mode === 'processed' && app.outputBuffer) return app.outputBuffer;
      return app.inputBuffer || app.outputBuffer || null;
    }

    function _setPlayIcon(playing) {
      const btn = $('tpPlay');
      if (!btn) return;
      btn.innerHTML = playing
        ? '<span aria-hidden="true">&#9646;&#9646;</span>'
        : '<span aria-hidden="true">&#9654;</span>';
      btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      btn.title = playing ? 'Pause' : 'Play';
    }

    function _updateUI() {
      const ctx = _getCtx();
      if (!ctx) return;
      const elapsed = _isPlaying
        ? _pauseOffset + (ctx.currentTime - _startTime)
        : _pauseOffset;
      const clamped = Math.min(elapsed, _duration || 0);
      const cur = $('tpCur');
      const seek = $('tpSeek');
      if (cur) cur.textContent = _fmt(clamped);
      if (seek && !_seeking && _duration > 0) seek.value = String((clamped / _duration) * 1000);
      if (_isPlaying) _rafId = requestAnimationFrame(_updateUI);
    }

    function _stopSource() {
      if (_source) {
        try { _source.onended = null; _source.stop(0); } catch (_) {}
        try { _source.disconnect(); } catch (_) {}
        _source = null;
      }
    }

    function _teardown(resetOffset) {
      cancelAnimationFrame(_rafId);
      _stopSource();
      _isPlaying = false;
      if (resetOffset) _pauseOffset = 0;
      _setPlayIcon(false);
      const pause = $('tpPause');
      const stop  = $('tpStop');
      if (pause) pause.disabled = true;
      if (stop)  stop.disabled  = true;
    }

    /* ── Core play ── */
    async function _play() {
      const ctx = _getCtx();
      const buf = _getBuffer();
      if (!ctx) { warn('No AudioContext'); return; }
      if (!buf) { warn('No buffer loaded'); return; }

      if (ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (e) { warn('ctx.resume failed', e); }
      }

      _stopSource();

      _duration = buf.duration || 0;
      const dur = $('tpDur');
      const seek = $('tpSeek');
      if (dur)  dur.textContent = _fmt(_duration);
      if (seek) { seek.max = '1000'; seek.disabled = false; }

      _source = ctx.createBufferSource();
      _source.buffer = buf;
      const spSel = $('tpSpeed');
      _source.playbackRate.value = parseFloat(spSel?.value || '1');

      if (!_gainNode) { _gainNode = ctx.createGain(); _gainNode.gain.value = 1; }
      _source.connect(_gainNode);
      _gainNode.connect(ctx.destination);

      const safeOffset = Math.min(Math.max(_pauseOffset, 0), Math.max(_duration - 0.01, 0));
      _pauseOffset = safeOffset;

      _source.start(0, safeOffset);
      _startTime = ctx.currentTime;
      _isPlaying = true;

      _source.onended = () => {
        if (!_isPlaying) return;
        _pauseOffset = 0;
        _teardown(false);
        const seek2 = $('tpSeek');
        const cur2  = $('tpCur');
        if (seek2) seek2.value = '0';
        if (cur2)  cur2.textContent = _fmt(0);
      };

      _setPlayIcon(true);
      const pause = $('tpPause');
      const stop  = $('tpStop');
      if (pause) pause.disabled = false;
      if (stop)  stop.disabled  = false;

      cancelAnimationFrame(_rafId);
      _updateUI();
      log('play() started at offset', safeOffset);
    }

    function _pause() {
      if (!_isPlaying) return;
      const ctx = _getCtx();
      if (ctx) _pauseOffset += ctx.currentTime - _startTime;
      _teardown(false);
      log('pause() at', _pauseOffset);
    }

    function _stop() {
      _pauseOffset = 0;
      _teardown(true);
      const seek = $('tpSeek');
      const cur  = $('tpCur');
      if (seek) seek.value = '0';
      if (cur)  cur.textContent = _fmt(0);
      log('stop()');
    }

    /* ── Clone buttons to wipe old listeners ── */
    function _clone(id) {
      const el = $(id);
      if (!el) return null;
      const c = el.cloneNode(true);
      el.parentNode.replaceChild(c, el);
      return c;
    }

    const play  = _clone('tpPlay');
    const pause = _clone('tpPause');
    const stop  = _clone('tpStop');
    const rew   = _clone('tpRew');
    const fwd   = _clone('tpFwd');
    const spUp  = _clone('tpSpeedUp');
    const spDn  = _clone('tpSpeedDown');
    const spSel = $('tpSpeed');
    const seek  = $('tpSeek');

    if (play)  play.addEventListener('click',  () => { if (_isPlaying) _pause(); else _play(); });
    if (pause) { pause.addEventListener('click', () => _pause()); pause.disabled = true; }
    if (stop)  { stop.addEventListener('click',  () => _stop());  stop.disabled  = true; }

    if (rew) rew.addEventListener('click', () => {
      _pauseOffset = Math.max(0, _pauseOffset - 5);
      if (_isPlaying) { _stopSource(); _play(); }
      else { const cur = $('tpCur'); if (cur) cur.textContent = _fmt(_pauseOffset); }
    });

    if (fwd) fwd.addEventListener('click', () => {
      _pauseOffset = Math.min((_duration || 0) - 0.1, _pauseOffset + 5);
      if (_isPlaying) { _stopSource(); _play(); }
      else { const cur = $('tpCur'); if (cur) cur.textContent = _fmt(_pauseOffset); }
    });

    /* Seek scrubber */
    if (seek) {
      seek.addEventListener('mousedown',  () => { _seeking = true; });
      seek.addEventListener('touchstart', () => { _seeking = true; }, { passive: true });
      seek.addEventListener('input', () => {
        _pauseOffset = (parseFloat(seek.value) / 1000) * (_duration || 0);
        const cur = $('tpCur'); if (cur) cur.textContent = _fmt(_pauseOffset);
      });
      seek.addEventListener('change', () => {
        _seeking = false;
        _pauseOffset = (parseFloat(seek.value) / 1000) * (_duration || 0);
        if (_isPlaying) { _stopSource(); _play(); }
      });
    }

    /* Speed ± buttons — step <select> + update playbackRate live */
    if (spUp && spSel) {
      spUp.addEventListener('click', () => {
        if (spSel.selectedIndex < spSel.options.length - 1) {
          spSel.selectedIndex++;
          spSel.dispatchEvent(new Event('change', { bubbles: true }));
          if (_source) _source.playbackRate.value = parseFloat(spSel.value);
        }
      });
    }
    if (spDn && spSel) {
      spDn.addEventListener('click', () => {
        if (spSel.selectedIndex > 0) {
          spSel.selectedIndex--;
          spSel.dispatchEvent(new Event('change', { bubbles: true }));
          if (_source) _source.playbackRate.value = parseFloat(spSel.value);
        }
      });
    }
    if (spSel) {
      spSel.addEventListener('change', () => {
        if (_source) _source.playbackRate.value = parseFloat(spSel.value);
      });
    }

    /* Space = play/pause keyboard shortcut */
    document.addEventListener('keydown', (e) => {
      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') { e.preventDefault(); if (_isPlaying) _pause(); else _play(); }
    });

    /* Expose internal state for A/B patch */
    app._fixPlayState = {
      get isPlaying() { return _isPlaying; },
      resetOffset()   { _pauseOffset = 0; },
      restart()       { if (_isPlaying) { _stopSource(); _play(); } },
    };

    /* Enable play button when buffer lands */
    function _checkEnable() {
      const btn = $('tpPlay');
      if (btn) btn.disabled = !(app.inputBuffer || app.outputBuffer);
    }
    const _poll = setInterval(() => { _checkEnable(); if (app.inputBuffer) clearInterval(_poll); }, 300);
    setTimeout(() => clearInterval(_poll), 30000);
    window.addEventListener('vip:fileLoaded',     () => { _checkEnable(); _duration = app.inputBuffer?.duration || 0; const dur = $('tpDur'); if (dur) dur.textContent = _fmt(_duration); });
    window.addEventListener('vip:processingDone', _checkEnable);

    log('Transport patch OK');
  }

  /* ═══════════════════════════════════════════════════════════════
   * 2. A/B SWITCHER
   * ═══════════════════════════════════════════════════════════════ */
  function patchAB(app) {
    if (!app || app._fixABPatched) return;
    app._fixABPatched = true;
    log('Patching A/B');

    /* Safe label writer — never nukes child spans */
    function _setABLabel(version) {
      const lbl = $('tpABLabel');
      if (!lbl) return;
      const isB  = (version === 'B' || version === 'processed');
      const tag  = isB ? 'B' : 'A';
      const name = isB ? 'Processed' : 'Original';

      lbl.dataset.version = tag;
      lbl.setAttribute('aria-label', tag + ' ' + name);

      let tagEl  = lbl.querySelector('.tp-ab-tag');
      let nameEl = lbl.querySelector('.tp-ab-name');

      if (!tagEl || !nameEl) {
        while (lbl.firstChild) lbl.removeChild(lbl.firstChild);
        tagEl  = document.createElement('span'); tagEl.className  = 'tp-ab-tag';
        nameEl = document.createElement('span'); nameEl.className = 'tp-ab-name';
        lbl.appendChild(tagEl); lbl.appendChild(nameEl);
      }

      tagEl.textContent  = tag;
      nameEl.textContent = name;

      const btn = $('tpAB');
      if (btn) { btn.dataset.abVersion = tag; btn.setAttribute('aria-pressed', String(isB)); }
    }

    function _toggleAB() {
      if (!app.outputBuffer) {
        /* Flash label to signal no processed output yet */
        const lbl = $('tpABLabel');
        if (lbl) { lbl.classList.add('tp-ab-no-output'); setTimeout(() => lbl.classList.remove('tp-ab-no-output'), 600); }
        return;
      }
      const next = (app.abMode === 'processed') ? 'original' : 'processed';
      app.abMode = next;
      _setABLabel(next === 'processed' ? 'B' : 'A');
      if (app._fixPlayState?.isPlaying) { app._fixPlayState.resetOffset(); app._fixPlayState.restart(); }
      log('A/B toggled to', next);
    }

    /* Replace AB button to clear stale listeners */
    const origAB = $('tpAB');
    let freshAB = origAB;
    if (origAB) {
      freshAB = origAB.cloneNode(true);
      origAB.parentNode.replaceChild(freshAB, origAB);
    }
    if (freshAB) freshAB.addEventListener('click', _toggleAB);

    /* X key shortcut */
    document.addEventListener('keydown', (e) => {
      const tag = (e.target?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'KeyX') _toggleAB();
    });

    /* Always re-enable AB button (fixes try-only bug in runPipeline) */
    function _refreshAB() {
      const btn = $('tpAB');
      if (btn) btn.disabled = !(app.inputBuffer || app.outputBuffer);
    }
    window.addEventListener('vip:processingDone', _refreshAB);
    window.addEventListener('vip:fileLoaded',     _refreshAB);

    /* Wrap runPipeline with a finally guard */
    if (typeof app.runPipeline === 'function' && !app._fixRunPipelineWrapped) {
      const orig = app.runPipeline.bind(app);
      app.runPipeline = async function (...args) {
        try {
          return await orig(...args);
        } finally {
          _refreshAB();
          const pb = $('processBtn');   if (pb) pb.disabled = false;
          const rb = $('reprocessBtn'); if (rb) rb.disabled = false;
          window.dispatchEvent(new CustomEvent('vip:processingDone'));
        }
      };
      app._fixRunPipelineWrapped = true;
      log('runPipeline finally-guard wrapped');
    }

    _setABLabel(app.abMode === 'processed' ? 'B' : 'A');
    _refreshAB();
    app._fixSetABLabel = _setABLabel;
    log('A/B patch OK');
  }

  /* ═══════════════════════════════════════════════════════════════
   * 3. SLIDER DISPATCH — double-binding guard + VIP_PARAMS sync
   * ═══════════════════════════════════════════════════════════════ */
  function patchSliders(app) {
    if (!app || app._fixSlidersPatched) return;
    app._fixSlidersPatched = true;
    log('Patching sliders');

    function bindRow(row) {
      const id     = row.dataset.sliderId;
      const slider = row.querySelector('input[type="range"]');
      if (!slider || !id || slider.dataset.vipFixBound === '1') return;
      slider.dataset.vipFixBound = '1';

      slider.addEventListener('input', () => {
        const v = parseFloat(slider.value);
        if (!Number.isFinite(v)) return;
        window.VIP_PARAMS = window.VIP_PARAMS || {};
        window.VIP_PARAMS[id] = v;
        if (app.params) app.params[id] = v;
        
        // Apply transforms for specific parameters (nrAmount, dryWet need 0-100 → 0-1)
        let transformedVal = v;
        if (id === 'nrAmount' || id === 'dryWet') {
          transformedVal = v / 100;
        }
        
        const orch = window._vipOrch;
        if (orch?.updateParams) { orch.updateParams({ [id]: transformedVal }); return; }
        if (app.workletNode) {
          try { app.workletNode.port.postMessage({ type: 'params', payload: { [id]: transformedVal } }); } catch (_) {}
        }
      });
    }

    document.querySelectorAll('.sr-row[data-slider-id]').forEach(bindRow);

    /* Re-bind whenever panels are dynamically populated */
    const mo = new MutationObserver(() => {
      document.querySelectorAll('.sr-row[data-slider-id]').forEach(bindRow);
    });
    document.querySelectorAll('.slider-panel, .slider-group-content').forEach(p =>
      mo.observe(p, { childList: true, subtree: true })
    );

    log('Sliders patch OK');
  }

  /* ═════════════════════════���═════════════════════════════════════
   * 4. SLIDER SEARCH — fix .include typo → .includes()
   * ═══════════════════════════════════════════════════════════════ */
  function patchSliderSearch() {
    const el = $('sliderSearch');
    if (!el || el.dataset.vipFixSearch === '1') return;
    el.dataset.vipFixSearch = '1';
    el.addEventListener('input', () => {
      const q = el.value.trim().toLowerCase();
      document.querySelectorAll('.sr-row, .slider-row').forEach(row => {
        const lbl = row.querySelector('.sr-label, .slider-label');
        row.style.display = (!q || (lbl && lbl.textContent.toLowerCase().includes(q))) ? '' : 'none';
      });
    });
    log('Slider search patch OK');
  }

  /* ═══════════════════════════════════════════════════════════════
   * 5. PRESET <select> — wire change → applyPreset()
   * ═══════════════════════════════════════════════════════════════ */
  function patchPresetSelect(app) {
    if (!app || app._fixPresetPatched) return;
    app._fixPresetPatched = true;
    const sel = $('presetSel');
    if (!sel) return;
    sel.addEventListener('change', () => {
      const name = sel.value;
      if (typeof app.applyPreset === 'function') app.applyPreset(name);
      else if (typeof app.loadPreset === 'function') app.loadPreset(name);
      log('Preset selected', name);
    });
    log('Preset select patch OK');
  }

  /* ═══════════════════════════════════════════════════════════════
   * 6. ACCORDION GROUPS — click-to-expand
   * ═══════════════════════════════════════════════════════════════ */
  function patchAccordions() {
    document.querySelectorAll('.slider-group-header').forEach(btn => {
      if (btn.dataset.vipFixAcc === '1') return;

      // Clone the button to remove the original listener registered in app.js
      const newBtn = btn.cloneNode(true);
      newBtn.dataset.vipFixAcc = '1';
      btn.parentNode.replaceChild(newBtn, btn);

      newBtn.addEventListener('click', () => {
        const group   = newBtn.closest('.slider-group');
        const content = $(newBtn.getAttribute('aria-controls'));
        if (!group || !content) return;
        const open = group.classList.toggle('active');
        newBtn.setAttribute('aria-expanded', String(open));
        content.style.display = open ? '' : 'none';
      });
      /* Sync initial display state with class */
      const isActive = newBtn.closest('.slider-group')?.classList.contains('active');
      const content  = $(newBtn.getAttribute('aria-controls'));
      if (content) content.style.display = isActive ? '' : 'none';
    });
    log('Accordions patch OK');
  }

  /* ═══════════════════════════════════════════════════════════════
   * 7. DEBUG REPORT — call window.VIP_DEBUG_REPORT() in DevTools
   * ═══════════════════════════════════════════════════════════════ */
  function buildReport() {
    const app  = window._vipApp;
    const orch = window._vipOrch;
    const ctx  = app?.ctx || orch?.ctx || window.audioCtx;
    const sliderAudit = {};
    document.querySelectorAll('.sr-row[data-slider-id]').forEach(row => {
      const id = row.dataset.sliderId;
      const sl = row.querySelector('input[type="range"]');
      if (sl) sliderAudit[id] = { value: sl.value, fixBound: sl.dataset.vipFixBound === '1', originalBound: sl.dataset.vipBound === '1' };
    });
    const report = {
      ts:          new Date().toISOString(),
      audioCtx:    ctx ? { state: ctx.state, sr: ctx.sampleRate, time: ctx.currentTime } : null,
      buffers:     { input: app?.inputBuffer ? { dur: app.inputBuffer.duration, ch: app.inputBuffer.numberOfChannels } : null, output: app?.outputBuffer ? { dur: app.outputBuffer.duration, ch: app.outputBuffer.numberOfChannels } : null },
      abMode:      app?.abMode,
      isPlaying:   app?._fixPlayState?.isPlaying,
      transport:   { play: { disabled: $('tpPlay')?.disabled, label: $('tpPlay')?.getAttribute('aria-label') }, pause: { disabled: $('tpPause')?.disabled }, stop: { disabled: $('tpStop')?.disabled }, ab: { disabled: $('tpAB')?.disabled, version: $('tpABLabel')?.dataset?.version }, seek: { value: $('tpSeek')?.value }, speed: { value: $('tpSpeed')?.value } },
      buttons:     { process: $('processBtn')?.disabled, reprocess: $('reprocessBtn')?.disabled, saveOrig: $('saveOrigBtn')?.disabled, saveProc: $('saveProcBtn')?.disabled },
      sliders:     sliderAudit,
      vipParams:   window.VIP_PARAMS || {},
      workers:     { ml: !!(app?.mlWorker || orch?.mlWorker), worklet: !!(app?.workletNode || orch?.workletNode) },
      modules:     { DSPCore: !!window.DSPCore, VIPOverlay: !!window.VIPOverlay, _vipApp: !!window._vipApp, _vipOrch: !!window._vipOrch, THREE: !!window.THREE },
      recentLogs:  (window._vipLogs || []).slice(-20),
    };
    console.group('%c[VIP-DEBUG-REPORT]', 'color:#ff3b3b;font-weight:bold');
    console.log(JSON.stringify(report, null, 2));
    console.groupEnd();
    return report;
  }
  window.VIP_DEBUG_REPORT = buildReport;

  /* ═══════════════════════════════════════════════════════════════
   * INIT
   * ═══════════════════════════════════════════════════════════════ */
  function applyAll(app) {
    patchTransport(app);
    patchAB(app);
    patchSliders(app);
    patchSliderSearch();
    patchPresetSelect(app);
    patchAccordions();
    console.info('[VIP-FIX] All patches applied. Call VIP_DEBUG_REPORT() in DevTools for a full snapshot.');
  }

  function init() {
    if (window._vipApp) { applyAll(window._vipApp); return; }
    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      if (window._vipApp) { clearInterval(poll); applyAll(window._vipApp); }
      else if (tries > 100) {
        clearInterval(poll);
        warn('_vipApp never appeared — applying DOM-only patches');
        patchSliderSearch();
        patchAccordions();
      }
    }, 100);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

})();
