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
    let _analyser    = null;  // FFT analyser tapped after worklet — drives visualizers
    let _workletWired = false; // sticky flag: once we route through worklet, stay routed
    let _chainBuilt  = false;  // downstream chain (gain → [worklet] → analyser → dest) wired once
    let _usingBridge = false;  // rt:true sliders route through EngineerModeBridge → PlaybackMixer
    let _bridge      = null;

    /* ── Helpers ── */
    function _fmt(sec) {
      const s = Math.max(0, Math.floor(sec || 0));
      return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    }

    function _getCtx() {
      return app.ctx || window._vipOrch?.ctx || window.audioCtx || null;
    }

    function _getBuffer() {
      if (typeof app._getPlaybackBuffer === 'function') return app._getPlaybackBuffer();
      const mode = app.abMode || 'original';
      if (mode === 'processed') {
        return app.outputBuffer || app.procBuffer || app.inputBuffer || app.origBuffer || null;
      }
      return app.inputBuffer || app.origBuffer || app.outputBuffer || null;
    }

    function _syncDuration() {
      const buf = _getBuffer();
      _duration = buf?.duration || 0;
      const dur = $('tpDur');
      if (dur) dur.textContent = _fmt(_duration);
      if (typeof app._updateTransportUI === 'function') app._updateTransportUI();
    }

    /* ── Video element sync ──
       For video files the <video> supplies the picture while the Web Audio
       graph above plays the *processed* (or A/B original) audio. The video is
       always muted; we just steer its currentTime / playbackRate to stay locked
       to the audio transport. */
    function _getVideoEl() {
      if (!app || !app.isVideo) return null;
      return (app.dom && app.dom.videoPlayer) || document.getElementById('videoPlayer') || null;
    }

    function _syncVideo(offsetSec, playing) {
      const v = _getVideoEl();
      if (!v) return;
      try {
        v.muted = true;
        const sp = $('tpSpeed');
        const rate = parseFloat(sp && sp.value ? sp.value : '1');
        if (Number.isFinite(rate) && rate > 0) v.playbackRate = rate;
        if (typeof offsetSec === 'number' && Number.isFinite(offsetSec)) {
          // Only hard-seek when drift exceeds ~250 ms to avoid visible stutter.
          if (Math.abs((v.currentTime || 0) - offsetSec) > 0.25) v.currentTime = offsetSec;
        }
        if (playing) { const pr = v.play && v.play(); if (pr && typeof pr.catch === 'function') pr.catch(() => {}); }
        else if (v.pause) v.pause();
      } catch { /* ignore */ }
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

    function _elapsedSeconds() {
      const ctx = _getCtx();
      if (_usingBridge && _bridge) {
        return _bridge.isPlaying() ? _bridge.currentTime() : _pauseOffset;
      }
      if (!ctx) return _pauseOffset;
      return _isPlaying ? (_pauseOffset + (ctx.currentTime - _startTime)) : _pauseOffset;
    }

    function _paintTransportFromApp() {
      if (typeof app._paintTransport !== 'function') return;
      const dur = (typeof app._getTransportDuration === 'function')
        ? app._getTransportDuration()
        : (_duration || 0);
      const cur = (typeof app._getTransportPosition === 'function')
        ? app._getTransportPosition()
        : _elapsedSeconds();
      app._paintTransport(cur, dur);
    }

    function _startTransportUi() {
      app.playOffset = _pauseOffset;
      app.isPlaying = true;
      if (typeof app._startTransportClock === 'function') {
        app._startTransportClock();
        return;
      }
      _paintTransportFromApp();
    }

    function _stopTransportUi() {
      app.playOffset = _pauseOffset;
      app.isPlaying = false;
      if (typeof app._stopTransportClock === 'function') app._stopTransportClock();
      _paintTransportFromApp();
    }

    function _stopSource() {
      if (_usingBridge && _bridge) {
        try { _bridge.pause(); } catch (_) {}
        return;
      }
      if (_source) {
        try { _source.onended = null; _source.stop(0); } catch (_) {}
        try { _source.disconnect(); } catch (_) {}
        _source = null;
      }
    }

    function _teardown(resetOffset) {
      cancelAnimationFrame(_rafId);
      if (_usingBridge && _bridge) {
        try {
          if (resetOffset) _bridge.stop();
          else _bridge.pause();
        } catch (_) {}
        _usingBridge = false;
        _bridge = null;
      }
      _stopSource();
      _isPlaying = false;
      if (resetOffset) _pauseOffset = 0;
      _setPlayIcon(false);
      const pause = $('tpPause');
      const stop  = $('tpStop');
      if (pause) pause.disabled = true;
      if (stop)  stop.disabled  = true;
      try { window.dispatchEvent(new CustomEvent('vip:playStopped')); } catch (_) {}
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
      _usingBridge = false;
      _bridge = null;

      _duration = buf.duration || 0;
      const dur = $('tpDur');
      const seek = $('tpSeek');
      if (dur)  dur.textContent = _fmt(_duration);
      if (seek) { seek.max = '1000'; seek.disabled = false; _paintTransportFromApp(); }

      const safeOffset = Math.min(Math.max(_pauseOffset, 0), Math.max(_duration - 0.01, 0));
      _pauseOffset = safeOffset;

      // Preferred path: Live-Mix bridge so every rt:true slider is a live AudioParam.
      try {
        if (typeof app.ensureCtx === 'function') await app.ensureCtx();
        const bridge = typeof app._ensureBridge === 'function' ? await app._ensureBridge() : null;
        if (bridge && typeof bridge.loadBuffer === 'function') {
          app.playOffset = safeOffset;
          if (app._bridgeBuf !== buf) {
            bridge.loadBuffer(buf);
            app._bridgeBuf = buf;
            if (typeof bridge.applyParams === 'function') {
              bridge.applyParams(window.VIP_PARAMS || {});
            }
          }
          await bridge.seek(safeOffset);
          await bridge.play();
          _usingBridge = true;
          _bridge = bridge;
          app._bridge = bridge;
          _analyser = bridge.getAnalyser ? bridge.getAnalyser() : null;
          if (_analyser) window._vipPlayAnalyser = _analyser;
          _startTime = ctx.currentTime;
          _isPlaying = true;
          app.isPlaying = true;
          _syncVideo(safeOffset, true);
          _setPlayIcon(true);
          const pauseBtn = $('tpPause');
          const stopBtn  = $('tpStop');
          if (pauseBtn) pauseBtn.disabled = false;
          if (stopBtn)  stopBtn.disabled  = false;
          _startTransportUi();
          try {
            window.dispatchEvent(new CustomEvent('vip:playStarted', {
              detail: { analyser: _analyser, bridgeRouted: true },
            }));
          } catch (_) {}
          log('play() started via Live-Mix bridge at offset', safeOffset);
          return;
        }
      } catch (e) {
        warn('Live-Mix bridge play failed; falling back to direct source', e);
        _usingBridge = false;
        _bridge = null;
      }

      _source = ctx.createBufferSource();
      _source.buffer = buf;
      const spSel = $('tpSpeed');
      _source.playbackRate.value = parseFloat(spSel?.value || '1');

      if (!_gainNode) { _gainNode = ctx.createGain(); _gainNode.gain.value = 1; }

      /* ── Analyser node — single shared FFT tap that drives every visualizer ── */
      if (!_analyser) {
        try {
          _analyser = ctx.createAnalyser();
          _analyser.fftSize = 2048;
          _analyser.smoothingTimeConstant = 0.82;
          window._vipPlayAnalyser = _analyser;
        } catch (e) { warn('Analyser create failed', e); _analyser = null; }
      }

      /* ── Routing chain ──
         Wired ONCE and reused across replays — each new source connects to
         the persistent _gainNode and the downstream chain takes care of the
         rest. Reconnecting downstream nodes per-play would tear down the
         worklet's connections to the orchestrator's other consumers.

         Chain layout (built on first play, kept until teardown):
           Source → Gain → [Worklet] → Analyser → ctx.destination
       */
      _source.connect(_gainNode);
      if (!_chainBuilt) {
        const orchWorklet = window._vipOrch?.workletNode;
        try {
          if (orchWorklet) {
            _gainNode.connect(orchWorklet);
            if (_analyser) {
              orchWorklet.connect(_analyser);
              _analyser.connect(ctx.destination);
            } else {
              orchWorklet.connect(ctx.destination);
            }
            _workletWired = true;
          } else if (_analyser) {
            _gainNode.connect(_analyser);
            _analyser.connect(ctx.destination);
          } else {
            _gainNode.connect(ctx.destination);
          }
          _chainBuilt = true;
        } catch (e) {
          warn('Chain build failed, falling back to direct gain → destination', e);
          try { _gainNode.connect(ctx.destination); } catch (_) {}
          _chainBuilt = true;
        }
      }

      _source.start(0, safeOffset);
      _startTime = ctx.currentTime;
      _isPlaying = true;

      /* Roll the muted video in sync with the audio transport. */
      _syncVideo(safeOffset, true);

      _source.onended = () => {
        if (!_isPlaying) return;
        _pauseOffset = 0;
        _teardown(false);
        _syncVideo(0, false);
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

      _startTransportUi();

      /* Announce playback so visualizers can hook in */
      try {
        window.dispatchEvent(new CustomEvent('vip:playStarted', {
          detail: { analyser: _analyser, workletRouted: _workletWired }
        }));
      } catch (_) {}

      log('play() started at offset', safeOffset, _workletWired ? '(worklet-routed)' : '(direct)');
    }

    function _pause() {
      if (!_isPlaying) return;
      if (_usingBridge && _bridge) {
        _pauseOffset = _bridge.currentTime();
      } else {
        const ctx = _getCtx();
        if (ctx) _pauseOffset += ctx.currentTime - _startTime;
      }
      _pauseOffset = (typeof app._getTransportPosition === 'function')
        ? app._getTransportPosition()
        : _pauseOffset;
      app.playOffset = _pauseOffset;
      _stopTransportUi();
      _teardown(false);
      _syncVideo(_pauseOffset, false);
      log('pause() at', _pauseOffset);
    }

    function _stop() {
      _pauseOffset = 0;
      _stopTransportUi();
      _teardown(true);
      _syncVideo(0, false);
      if (typeof app._paintTransport === 'function') {
        app._paintTransport(0, (typeof app._getTransportDuration === 'function') ? app._getTransportDuration() : _duration);
      }
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

    function _restartAtOffset() {
      app.playOffset = _pauseOffset;
      if (_usingBridge && _bridge) {
        _bridge.seek(_pauseOffset).catch(() => {});
        return;
      }
      _stopSource();
      _play();
    }

    if (rew) rew.addEventListener('click', () => {
      if (_isPlaying) _pauseOffset = _elapsedSeconds();
      _pauseOffset = Math.max(0, _pauseOffset - 5);
      if (_isPlaying) _restartAtOffset();
      else {
        const cur = $('tpCur');
        if (cur) cur.textContent = _fmt(_pauseOffset);
        _syncVideo(_pauseOffset, false);
      }
    });

    if (fwd) fwd.addEventListener('click', () => {
      if (_isPlaying) _pauseOffset = _elapsedSeconds();
      _pauseOffset = Math.min((_duration || 0) - 0.1, _pauseOffset + 5);
      if (_isPlaying) _restartAtOffset();
      else {
        const cur = $('tpCur');
        if (cur) cur.textContent = _fmt(_pauseOffset);
        _syncVideo(_pauseOffset, false);
      }
    });

    /* Seek scrubber — app.js owns input/change handlers; sync local offset only */
    if (seek) {
      seek.addEventListener('input', () => {
        const dur = (typeof app._getTransportDuration === 'function')
          ? app._getTransportDuration()
          : (_duration || 0);
        _pauseOffset = (parseFloat(seek.value) / 1000) * dur;
        app.playOffset = _pauseOffset;
        if (!_isPlaying) _syncVideo(_pauseOffset, false);
      });
      seek.addEventListener('change', () => {
        const dur = (typeof app._getTransportDuration === 'function')
          ? app._getTransportDuration()
          : (_duration || 0);
        _pauseOffset = (parseFloat(seek.value) / 1000) * dur;
        app.playOffset = _pauseOffset;
        if (_isPlaying) _restartAtOffset();
      });
      _syncDuration();
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
        const v = _getVideoEl();
        if (v) { try { v.playbackRate = parseFloat(spSel.value); } catch { /* ignore */ } }
      });
    }

    /* Space = play/pause keyboard shortcut */
    document.addEventListener('keydown', (e) => {
      const target = e.target;
      if (!target) return;
      const tag = (target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const inButtonOrTab = tag === 'BUTTON' || (typeof target.closest === 'function' && target.closest('[role="tablist"]'));
      if (inButtonOrTab) return;

      if (e.code === 'Space') { e.preventDefault(); if (_isPlaying) _pause(); else _play(); }
    });

    /* Expose internal state for A/B patch + visualizer playhead */
    app._fixPlayState = {
      get isPlaying() { return _isPlaying; },
      resetOffset()   { _pauseOffset = 0; },
      restart()       { if (_isPlaying) { _stopSource(); _play(); } },
      elapsed() {
        return _elapsedSeconds();
      },
      get analyser() { return _analyser; },
    };

    /* Enable play button when buffer lands */
    function _checkEnable() {
      const btn = $('tpPlay');
      if (btn) btn.disabled = !(app.inputBuffer || app.outputBuffer);
    }
    const _poll = setInterval(() => { _checkEnable(); if (app.inputBuffer) clearInterval(_poll); }, 300);
    setTimeout(() => clearInterval(_poll), 30000);
    window.addEventListener('vip:fileLoaded', () => { _checkEnable(); _syncDuration(); });
    window.addEventListener('vip:processingDone', () => { _checkEnable(); _syncDuration(); });

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
      const target = e.target;
      if (!target) return;
      const tag = (target.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const inButtonOrTab = tag === 'BUTTON' || (typeof target.closest === 'function' && target.closest('[role="tablist"]'));
      if (inButtonOrTab) return;

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

        // Route through app.onSlider() so RT-flagged params hit the Live-Mix
        // bridge's AudioParams in real time (CLAUDE.md §1).
        if (app && typeof app.onSlider === 'function') {
          app.onSlider(id, v);
          return; // onSlider handles orchestrator/worklet routing
        }

        // Fallback: direct orchestrator/worklet dispatch if app.onSlider unavailable
        const orch = window._vipOrch;
        if (orch?.updateParams) { orch.updateParams(orch._normalizeRawParams({ [id]: v })); return; }
        if (app.workletNode) {
          const valMapped = (id === 'nrAmount' || id === 'dryWet') ? v / 100 : v;
          try { app.workletNode.port.postMessage({ type: 'params', payload: { [id]: valMapped } }); } catch (_) {}
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

  /* ═══════════════════════════════════════════════════════════════
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
   * 8. VISUAL CLICK-ISOLATION → DSP pipeline
   * ═══════════════════════════════════════════════════════════════ */
  function patchClickIsolation() {
    if (window._vipClickIsoPatched) return;
    window._vipClickIsoPatched = true;

    function _syncVoiceFocusSliders(lo, hi) {
      document.querySelectorAll('.sr-row[data-slider-id="voiceFocusLo"] input[type="range"]').forEach((sl) => {
        sl.value = String(lo);
        sl.dispatchEvent(new Event('input', { bubbles: true }));
      });
      document.querySelectorAll('.sr-row[data-slider-id="voiceFocusHi"] input[type="range"]').forEach((sl) => {
        sl.value = String(hi);
        sl.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    window.addEventListener('vip:isolationBandSet', (e) => {
      const { freqLow, freqHigh } = e.detail || {};
      const app = window._vipApp;
      if (!app) return;
      app.dspParams = app.dspParams || {};
      app.dspParams.isolationFreqLow = freqLow;
      app.dspParams.isolationFreqHigh = freqHigh;
      app.dspParams.isolationActive = true;
      window.VIP_PARAMS = window.VIP_PARAMS || {};
      const lo = Math.max(80, Math.round(freqLow || 120));
      const hi = Math.min(8000, Math.round(freqHigh || 3400));
      window.VIP_PARAMS.voiceFocusLo = lo;
      window.VIP_PARAMS.voiceFocusHi = Math.max(lo + 10, hi);
      _syncVoiceFocusSliders(lo, window.VIP_PARAMS.voiceFocusHi);
      if (typeof app.runPipeline === 'function') app.runPipeline();
      else if (typeof app.reprocess === 'function') app.reprocess();
    });

    window.addEventListener('vip:isolationBandClear', () => {
      const app = window._vipApp;
      if (!app || !app.dspParams) return;
      app.dspParams.isolationActive = false;
    });

    window.addEventListener('vip:stemToggle', (e) => {
      const stem = (e.detail && e.detail.stem) || 'all';
      const app = window._vipApp;
      if (app && typeof app.setStemSolo === 'function') {
        app.setStemSolo(stem);
      } else {
        window.dispatchEvent(new CustomEvent('vip:stemSoloChanged', { detail: { stem } }));
      }
    });

    window.addEventListener('vip:seekRequest', (e) => {
      const ratio = (e.detail && e.detail.ratio) || 0;
      const app = window._vipApp;
      if (!app) return;
      const buf = app.inputBuffer || app.outputBuffer || app.origBuffer;
      const dur = buf?.duration || 0;
      if (typeof app.seekTo === 'function') {
        app.seekTo(Math.max(0, Math.min(1, ratio)));
      } else if (typeof app.seek === 'function') {
        app.seek(ratio * dur);
      } else {
        const seek = $('tpSeek');
        const cur = $('tpCur');
        const off = ratio * dur;
        const fmtSec = (sec) => {
          const s = Math.max(0, Math.floor(sec || 0));
          return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
        };
        if (seek) {
          seek.value = String(ratio * 1000);
          seek.dispatchEvent(new Event('input', { bubbles: true }));
          seek.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          if (cur) cur.textContent = fmtSec(off);
          app.playOffset = off;
        }
      }
    });

    log('Click-isolation DSP patch OK');
  }

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
    patchClickIsolation();
    console.info('[VIP-FIX] All patches applied. Call VIP_DEBUG_REPORT() in DevTools for a full snapshot.');
  }

  function init() {
    patchClickIsolation();
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
