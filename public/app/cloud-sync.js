// VoiceIsolate Pro — Cloud Sync (DISABLED)
// BUG-H FIX: Replaced IIFE throw with silent no-op stub.
// The previous implementation threw on import, which would crash the page if this
// script was ever loaded. Now returns a safe stub object with no-op methods.
// Cloud sync violates the 100% local processing constraint — this module is permanently disabled.

const CloudSync = (() => {
  'use strict';

  const _disabled = () => { /* no-op: cloud sync disabled */ };

  return {
    sync: _disabled,
    push: _disabled,
    pull: _disabled,
    flush: _disabled,
    enable: _disabled,
    disable: _disabled,
    isEnabled: () => false,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CloudSync;
