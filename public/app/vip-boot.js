/**
 * vip-boot.js — VoiceIsolate Pro v22.1 bootstrap shim
 *
 * Loaded as the LAST script tag in index.html (after app.js and
 * pipeline-orchestrator.js).  Its only job:
 *
 *   1. Instantiate VoiceIsolatePro and expose it on window._vipApp
 *      (pipeline-orchestrator.js polls for this).
 *
 *   2. Call app.initMLWorker() so the ONNX VAD model starts loading
 *      immediately on page open instead of waiting for the first file drop.
 *
 * Why a separate file instead of editing app.js?
 *   app.js is 109 KB and currently ends mid-class with a corrupt finally
 *   block.  Patching it inline risks a merge conflict that breaks the whole
 *   file.  This shim is the minimal, safe approach.
 */
(function () {
  'use strict';

  function boot() {
    // Guard: VoiceIsolatePro must be defined by app.js
    if (typeof VoiceIsolatePro === 'undefined') {
      console.error('[vip-boot] VoiceIsolatePro class not found — is app.js loaded?');
      return;
    }

    // Already booted (e.g. hot-reload in dev)
    if (window._vipApp) return;

    try {
      const app = new VoiceIsolatePro();

      // Expose globally BEFORE pipeline-orchestrator.js bootstrap runs
      window._vipApp = app;

      // Kick off ONNX VAD load eagerly (non-blocking)
      if (typeof app.initMLWorker === 'function') {
        try { app.initMLWorker(); } catch (e) {
          console.warn('[vip-boot] initMLWorker() threw synchronously:', e);
        }
      }

      console.info('[vip-boot] VoiceIsolatePro instantiated ✓  (window._vipApp set)');
    } catch (err) {
      console.error('[vip-boot] Failed to instantiate VoiceIsolatePro:', err);
    }
  }

  // app.js uses a DOMContentLoaded listener internally, so the class is
  // available synchronously by the time this script tag executes
  // (it's at the bottom of <body>).  Run immediately.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
