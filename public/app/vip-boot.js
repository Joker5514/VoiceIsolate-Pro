/**
 * vip-boot.js — VoiceIsolate Pro v22.1 bootstrap shim (fixed)
 */
(function () {
  'use strict';

  function aliasOrCreate() {
    if (typeof VoiceIsolatePro === 'undefined') {
      console.error('[vip-boot] VoiceIsolatePro class not found — is app.js loaded?');
      return;
    }
    if (window._vipApp) {
      if (!window.vip) window.vip = window._vipApp;
      return;
    }
    if (window.vip instanceof VoiceIsolatePro) {
      window._vipApp = window.vip;
      console.info('[vip-boot] Aliased window.vip → window._vipApp ✓');
      return;
    }
    try {
      const app = new VoiceIsolatePro();
      window.vip = app;
      window._vipApp = app;
      console.info('[vip-boot] VoiceIsolatePro instantiated ✓');
    } catch (err) {
      console.error('[vip-boot] Failed to instantiate VoiceIsolatePro:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', aliasOrCreate, { once: true });
  } else {
    aliasOrCreate();
  }
})();
