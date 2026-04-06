// DISABLED: This module is intentionally non-functional. VoiceIsolate Pro processes all audio locally.
// FIX: Issue #1 — Remove all external fetch() calls; cloud sync violates 100% local constraint.
// All _flushToServer(), _apiCall(), and enableServerReporting() have been removed.
// If cloud sync is needed as a future feature, re-enable only after a full security review.

const CloudSync = (() => {
  'use strict';

  throw new Error('Cloud sync disabled — VoiceIsolate Pro runs 100% locally');
})();

if (typeof module !== 'undefined' && module.exports) module.exports = CloudSync;
