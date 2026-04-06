/* cloud-sync.js — VoiceIsolate Pro
   LOCAL-ONLY stub. 100% offline. No network calls are made.
   This module exists solely to prevent import/reference errors. */

const CloudSync = {
  init: () => Promise.resolve({ ok: true, local: true }),
  save: (_key, _data) => Promise.resolve({ ok: true, local: true }),
  load: (_key) => Promise.resolve(null),
  sync: () => Promise.resolve({ ok: true, synced: 0 }),
  push: (_data) => Promise.resolve({ ok: true }),
  pull: () => Promise.resolve([]),
  isAvailable: () => false,
  getStatus: () => ({ online: false, lastSync: null }),
  on: (_event, _cb) => {},
  off: (_event, _cb) => {},
};

// Support both ES module and global script usage
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CloudSync;
} else {
  window.CloudSync = CloudSync;
}
