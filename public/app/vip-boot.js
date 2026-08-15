/**
 * vip-boot.js — VoiceIsolate Pro bootstrap shim
 *
 * Responsibilities:
 *   1. Instantiate VoiceIsolatePro and alias window.vip ↔ window._vipApp.
 *   2. Drive the engine status pills (CTX / Worklet / ML / SAB) by polling
 *      capability flags and live module state.
 *   3. Show the #vip-startup-banner ONLY for genuinely fatal conditions.
 *
 * Banner policy:
 *   FATAL  -> show banner
 *     - location.protocol === 'file:'         (no server)
 *     - AudioContext API unavailable          (browser too old)
 *     - VoiceIsolatePro class never appeared  (critical script load failure)
 *   NOT FATAL -> never block the app
 *     - SharedArrayBuffer / crossOriginIsolated missing
 *         Desktop browser: usually COOP/COEP misconfig → soft console + SAB pill
 *         Android WebView / Capacitor: often unsupported even with headers →
 *         message-port / single-thread WASM fallback (upload + ML still work)
 *     - ONNX models not yet downloaded
 *     - Three.js 3D init fails
 *     - Service worker registration pending
 *
 * A 2-second grace period lets async pills resolve before the check runs.
 */
(function () {
  'use strict';

  // -- Engine pill helper (exposed on window so other modules can update) --
  function setEnginePill(id, state) {
    var el = document.getElementById(id);
    if (!el) return;
    if (el.getAttribute('data-state') === state) return;
    el.setAttribute('data-state', state);
  }
  if (typeof window !== 'undefined') {
    window._setVipEnginePill = setEnginePill;
  }

  // -- Startup banner helper -----------------------------------------------
  function showBanner(html) {
    var el  = document.getElementById('vip-startup-banner');
    var msg = document.getElementById('vip-startup-msg');
    if (!el || !msg) return;
    msg.innerHTML = html;
    el.style.display = 'flex';
    console.warn('[VIP] startup:', msg.textContent);
  }

  // -- Capability checks (synchronous, no fetch) ---------------------------
  function hasSAB() {
    if (typeof SharedArrayBuffer === 'undefined' || typeof Atomics === 'undefined') return false;
    if (typeof self !== 'undefined' && self.crossOriginIsolated === false) return false;
    return true;
  }
  function isAndroidWebViewShell() {
    try {
      var ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
      // Capacitor Android WebView (product UA) or generic Android WebView tokens.
      if (/VoiceIsolatePro\/|Capacitor/i.test(ua) && /Android/i.test(ua)) return true;
      if (/; wv\)/i.test(ua)) return true; // Chrome WebView marker
      if (typeof window !== 'undefined' && window.Capacitor && /Android/i.test(ua)) return true;
    } catch (e) { /* ignore */ }
    return false;
  }
  function hasAudioContext() {
    return typeof AudioContext !== 'undefined' ||
           (typeof window !== 'undefined' && typeof window.webkitAudioContext !== 'undefined');
  }
  function hasAudioWorklet() {
    if (!hasAudioContext()) return false;
    var Ctor = (typeof AudioContext !== 'undefined') ? AudioContext : window.webkitAudioContext;
    return !!(Ctor && Ctor.prototype && 'audioWorklet' in Ctor.prototype);
  }

  // -- Master diagnostics: capability-based, never probes models -----------
  function runDiagnostics() {
    // A. file:// protocol -- no server running
    if (location.protocol === 'file:') {
      showBanner(
        '&#x1F5A5;&#xFE0F; <b>No local server detected.</b> ' +
        'Run <code style="background:#111;padding:1px 4px;border-radius:3px">pnpm dev</code> ' +
        'or open the installed Android / Desktop app. ' +
        'Do not open index.html via file://.'
      );
      return false;
    }

    // B. SharedArrayBuffer / cross-origin isolation — NOT fatal.
    // Upload-only isolation uses OfflineAudioContext + workers; SAB is optional
    // (legacy live ring-buffer / multi-thread WASM). Android WebView often
    // cannot enable SAB even when MainActivity injects COOP/COEP.
    if (!hasSAB()) {
      var sabNote = isAndroidWebViewShell()
        ? '[vip-boot] SharedArrayBuffer unavailable in Android WebView — using single-thread WASM / message-port path (normal).'
        : '[vip-boot] SharedArrayBuffer unavailable (page not cross-origin isolated). ' +
          'Upload + local ML still work. For desktop Chrome, ensure COOP/COEP headers then hard-reload.';
      console.info(sabNote);
      // Soft status only — never block Process/Upload.
      setEnginePill('engSabPill', 'unavailable');
      setPillTitle('engSabPill', isAndroidWebViewShell()
        ? 'SAB optional on Android WebView — app uses fallback path'
        : 'SAB missing — optional; isolation still works without multi-thread WASM');
    }

    // C. AudioContext API surface
    if (!hasAudioContext()) {
      showBanner(
        '&#x1F3A7; <b>Web Audio API unavailable.</b> ' +
        'This browser does not support AudioContext. Use a current Chromium, Firefox, or Safari build.'
      );
      return false;
    }

    // D. Critical script load -- VoiceIsolatePro class must exist
    if (typeof VoiceIsolatePro === 'undefined') {
      showBanner(
        '&#x1F4DC; <b>Core script failed to load.</b> ' +
        '<code style="background:#111;padding:1px 4px;border-radius:3px">app.js</code> did not register VoiceIsolatePro. ' +
        'Check the Network tab for blocked scripts and reload.'
      );
      return false;
    }

    return true;
  }

  /**
   * Map PlaybackMixer load states → pill states.
   * loaded→ready, pending→loading, failed→error, bypassed→unavailable
   */
  function mapWorkletLoadState(s) {
    if (s === 'loaded') return 'ready';
    if (s === 'pending') return 'loading';
    if (s === 'failed') return 'error';
    if (s === 'bypassed') return 'unavailable';
    return 'pending';
  }

  /** Read gate/de-esser status from Engineer bridge, landing mixer, or global. */
  function readPlaybackWorkletStatus() {
    try {
      var app = window._vipApp;
      var bridge = app && app._bridge;
      if (bridge && typeof bridge.getWorkletStatus === 'function') {
        return bridge.getWorkletStatus();
      }
      if (bridge && bridge.mixer && typeof bridge.mixer.getWorkletStatus === 'function') {
        return bridge.mixer.getWorkletStatus();
      }
      var landing = window.__vipDiagnostics && window.__vipDiagnostics.mixer;
      if (landing && typeof landing.getWorkletStatus === 'function') {
        return landing.getWorkletStatus();
      }
      if (window.__vipWorkletStatus) return window.__vipWorkletStatus;
    } catch (e) { /* ignore */ }
    return null;
  }

  function setPillTitle(id, title) {
    var el = document.getElementById(id);
    if (el && title) el.title = title;
  }

  // -- Pill driver: keeps ALL cockpit pills (CTX/WORKLET/GATE/DEESS/SAB/ML/ORT/NET) fresh --
  function startPillDriver() {
    var awOk = hasAudioWorklet();
    var sabOk0 = hasSAB();
    setEnginePill('engSabPill', sabOk0 ? 'ready' : 'unavailable');
    setPillTitle('engSabPill', sabOk0
      ? 'SharedArrayBuffer available (cross-origin isolated)'
      : (isAndroidWebViewShell()
        ? 'SAB optional on Android WebView — fallback path active'
        : 'SAB missing — optional for upload isolation; check COOP/COEP on desktop'));
    setEnginePill('engNetPill', getInitialNetworkState() ? 'ready' : 'error');
    setEnginePill('engCtxPill', hasAudioContext() ? 'loading' : 'error');
    setPillTitle('engCtxPill', 'AudioContext awaits first user gesture');
    setEnginePill('engWorkletPill', awOk ? 'loading' : 'error');
    setEnginePill('engGatePill', awOk ? 'loading' : 'error');
    setEnginePill('engDeessPill', awOk ? 'loading' : 'error');
    setEnginePill('engMlPill', 'loading');
    setEnginePill('engOrtPill', 'loading');

    // Desktop: 250ms. Mobile/Android: slower so cold open / Process stay responsive.
    var mobileShell = (function () {
      try {
        var ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
        if (/Android|iPhone|iPad|Mobile|Capacitor/i.test(ua)) return true;
        if (typeof window !== 'undefined' && window.Capacitor && window.Capacitor.isNativePlatform
          && window.Capacitor.isNativePlatform()) return true;
      } catch (e) { /* ignore */ }
      return false;
    })();
    var POLL_MS = mobileShell ? 1000 : 250;
    // Keep polling long enough that late ensureCtx()/worklet boot still paints pills.
    // (~10 min). Stops early once every pill has left pending/loading where possible.
    var MAX_TICKS = 2400;
    var ticks = 0;
    var workletsSettled = false;

    var iv = setInterval(function () {
      ticks += 1;

      // SAB — re-check isolation (headers can matter after nav). Never fatal.
      var sabOk = hasSAB();
      setEnginePill('engSabPill', sabOk ? 'ready' : 'unavailable');

      // NET
      var online = (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean')
        ? navigator.onLine : true;
      setEnginePill('engNetPill', online ? 'ready' : 'error');

      // CTX
      var app = window._vipApp;
      if (app && app.ctx && typeof app.ctx.state === 'string') {
        if (app.ctx.state === 'closed') {
          setEnginePill('engCtxPill', 'error');
          setPillTitle('engCtxPill', 'AudioContext closed');
        } else {
          setEnginePill('engCtxPill', 'ready');
          setPillTitle('engCtxPill', 'AudioContext ' + app.ctx.state);
        }
      } else if (hasAudioContext()) {
        setEnginePill('engCtxPill', 'loading');
        setPillTitle('engCtxPill', 'Click or press a key to unlock Web Audio');
      } else {
        setEnginePill('engCtxPill', 'error');
      }

      // GATE / DEESS / WORKLET from live mixer status
      if (awOk) {
        var st = readPlaybackWorkletStatus();
        if (st && st.gate && st.deEsser) {
          var gState = st.gate.state || 'pending';
          var dState = st.deEsser.state || 'pending';
          setEnginePill('engGatePill', mapWorkletLoadState(gState));
          setEnginePill('engDeessPill', mapWorkletLoadState(dState));
          setPillTitle('engGatePill', 'vip-gate — ' + gState + (st.gate.node ? ' (node active)' : ''));
          setPillTitle('engDeessPill', 'vip-deesser — ' + dState + (st.deEsser.node ? ' (node active)' : ''));

          var gBad = gState === 'failed';
          var dBad = dState === 'failed';
          var gOk = gState === 'loaded' || gState === 'bypassed';
          var dOk = dState === 'loaded' || dState === 'bypassed';
          if (gBad || dBad) setEnginePill('engWorkletPill', 'error');
          else if (gOk && dOk) {
            setEnginePill('engWorkletPill', 'ready');
            workletsSettled = true;
          } else {
            setEnginePill('engWorkletPill', 'loading');
          }
          setPillTitle('engWorkletPill', 'Playback worklets gate=' + gState + ' deess=' + dState);
        } else if (app && app._workletReady === true) {
          setEnginePill('engWorkletPill', 'ready');
          setEnginePill('engGatePill', 'ready');
          setEnginePill('engDeessPill', 'ready');
          workletsSettled = true;
        } else {
          // API present but modules not loaded yet (await user gesture / ensureCtx)
          setEnginePill('engWorkletPill', 'loading');
          setPillTitle('engWorkletPill', 'Worklets load after first click unlocks audio');
        }
      }

      // ML + ORT — prefer live worker/provider status over a stale VIP_ML_AVAILABLE=false
      // (app.js may set false before ort.min.js finishes evaluating on window).
      var ortGlobal = window.ort || (typeof globalThis !== 'undefined' && globalThis.ort);
      var ortSt = window.__vipOrtStatus;
      var providerLive = ortSt && (ortSt.provider === 'webgpu' || ortSt.provider === 'wasm');
      var ortApi = !!(ortGlobal && ortGlobal.InferenceSession);
      var orchReady = !!(window._vipOrch && window._vipOrch.mlReady === true);

      if (providerLive || orchReady || window.VIP_ML_AVAILABLE === true || ortApi) {
        setEnginePill('engMlPill', 'ready');
        setPillTitle('engMlPill', 'Local ONNX inference ready'
          + (providerLive ? (' (' + ortSt.provider + ')') : ''));
        if (window.VIP_ML_AVAILABLE !== true) window.VIP_ML_AVAILABLE = true;
      } else if (window.VIP_ML_AVAILABLE === false && !ortSt) {
        setEnginePill('engMlPill', 'unavailable');
        setPillTitle('engMlPill', 'ONNX Runtime not loaded — classical DSP fallback');
      } else {
        setEnginePill('engMlPill', 'loading');
      }

      // ORT provider pill
      if (providerLive) {
        setEnginePill('engOrtPill', 'ready');
        setPillTitle('engOrtPill', 'ORT provider: ' + ortSt.provider
          + (ortSt.modelsLoaded && ortSt.modelsLoaded.length
            ? ' · models: ' + ortSt.modelsLoaded.join(',')
            : ''));
      } else if (ortSt && ortSt.provider === 'error') {
        setEnginePill('engOrtPill', 'error');
        setPillTitle('engOrtPill', ortSt.detail || 'ORT error');
      } else if (ortSt && ortSt.provider === 'probing') {
        setEnginePill('engOrtPill', 'loading');
        setPillTitle('engOrtPill', 'Probing WebGPU / WASM…');
      } else if (ortApi) {
        setEnginePill('engOrtPill', 'loading');
        setPillTitle('engOrtPill', 'Waiting for MLWorker provider (WebGPU/WASM)');
      } else if (window.VIP_ML_AVAILABLE === false && !ortSt) {
        setEnginePill('engOrtPill', 'unavailable');
      } else {
        setEnginePill('engOrtPill', 'loading');
      }

      // Stop only when worklets settled (or API missing) and we have polled enough
      // to cover late ensureCtx — never abandon GATE/DEESS as permanent "loading"
      // after 30s the way the old driver did.
      if (ticks >= MAX_TICKS) {
        clearInterval(iv);
      } else if (workletsSettled && ticks > 40) {
        // Slow down after worklets are up (still refresh NET/SAB occasionally)
        if (ticks % 8 !== 0) return;
      }
    }, POLL_MS);

    if (typeof window !== 'undefined') window._vipPillDriverIv = iv;
  }

  // -- VoiceIsolatePro alias (original boot logic) -------------------------
  function aliasOrCreate() {
    if (typeof VoiceIsolatePro === 'undefined') {
      console.error('[vip-boot] VoiceIsolatePro class not found - is app.js loaded?');
      return;
    }
    if (window._vipApp) {
      if (!window.vip) window.vip = window._vipApp;
      _callAuthInit();
      return;
    }
    if (window.vip instanceof VoiceIsolatePro) {
      window._vipApp = window.vip;
      if (typeof window._vipApp.init === 'function' && !window._vipApp._initCalled) {
        try { window._vipApp.init(); } catch(e){ console.warn('[vip-boot] app.init() error:', e); }
      }
      window._vipApp._initCalled = true;
      console.info('[vip-boot] Aliased window.vip \u2192 window._vipApp \u2713');
      _callAuthInit();
      return;
    }
    try {
      var app = new VoiceIsolatePro();
      if (typeof app.init === 'function') {
        try { app.init(); } catch(e){ console.warn('[vip-boot] app.init() error:', e); }
      }
      app._initCalled = true;
      window.vip     = app;
      window._vipApp = app;
      console.info('[vip-boot] VoiceIsolatePro instantiated + init() called \u2713');
    } catch (err) {
      console.error('[vip-boot] Failed to instantiate VoiceIsolatePro:', err);
    }
    _callAuthInit();
  }

  function _callAuthInit() {
    if (typeof Auth !== 'undefined' && typeof Auth.init === 'function' && !Auth.isLoggedIn && Auth.currentUser === null) {
      Auth.init().catch(function(e){ console.warn('[vip-boot] Auth.init error:', e); });
    } else {
      console.warn('[vip-boot] Auth module not loaded - login modal skipped');
    }
  }

  function wireDismissBtn() {
    var btn = document.getElementById('vip-startup-close');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var banner = document.getElementById('vip-startup-banner');
      if (banner) banner.style.display = 'none';
    });
    btn.addEventListener('mouseover', function () { btn.style.color = '#dc2626'; });
    btn.addEventListener('mouseout',  function () { btn.style.color = '#666'; });
  }

  // -- Network connectivity monitor ----------------------------------------
  function getInitialNetworkState() {
    return (typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean')
      ? navigator.onLine
      : true;
  }

  function updateNetPill(online) {
    setEnginePill('engNetPill', online ? 'ready' : 'error');
  }

  function resetProviderHealth() {
    if (typeof window === 'undefined' || !window.ModelCDNLoader || !window.ModelCDNLoader.providerHealth) {
      return false;
    }
    Object.keys(window.ModelCDNLoader.providerHealth).forEach(function (k) {
      window.ModelCDNLoader.providerHealth[k] = true;
    });
    // Re-probe so Local Model Health flips off "unknown" after reconnect
    if (typeof window.ModelCDNLoader.probeSameOriginHealth === 'function') {
      try { window.ModelCDNLoader.probeSameOriginHealth(); } catch (e) { /* ignore */ }
    }
    return true;
  }

  function applyNetworkState(online) {
    updateNetPill(online);
    if (online) {
      console.info('[vip-boot] Network connected.');
      // Reset any degraded same-origin model sources so the loader retries from the top
      if (resetProviderHealth()) {
        console.info('[vip-boot] Local model source health reset after reconnect.');
      }
    } else {
      console.warn('[vip-boot] Network disconnected.');
    }
  }

  function startNetworkMonitor() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    // Set initial state immediately
    applyNetworkState(getInitialNetworkState());

    window.addEventListener('online', function () {
      applyNetworkState(true);
    });

    window.addEventListener('offline', function () {
      applyNetworkState(false);
    });
  }

  if (typeof window !== 'undefined') {
    window._vipBootTestHooks = window._vipBootTestHooks || {};
    window._vipBootTestHooks.getInitialNetworkState = getInitialNetworkState;
    window._vipBootTestHooks.updateNetPill = updateNetPill;
    window._vipBootTestHooks.resetProviderHealth = resetProviderHealth;
    window._vipBootTestHooks.applyNetworkState = applyNetworkState;
    window._vipBootTestHooks.startNetworkMonitor = startNetworkMonitor;
  }

  // -- Boot sequence -------------------------------------------------------
  function boot() {
    wireDismissBtn();
    aliasOrCreate();
    startPillDriver();
    startNetworkMonitor();
    // 2-second grace period for capability checks
    setTimeout(function () {
      try { runDiagnostics(); }
      catch (e) { console.warn('[vip-boot] runDiagnostics error:', e); }
    }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
