'use strict';

/**
 * Typed IPC channel names — shared contract between main and preload.
 * Renderer must never call ipcRenderer directly; only preload exposes these.
 */
const IPC = Object.freeze({
  PLATFORM: 'vip:platform',
  APP_VERSION: 'vip:app-version',
  OPEN_FILE: 'vip:open-file',
  SAVE_FILE: 'vip:save-file',
  MODEL_CACHE_PATH: 'vip:model-cache-path',
  READ_MODEL_CACHE: 'vip:read-model-cache',
  WRITE_MODEL_CACHE: 'vip:write-model-cache',
});

module.exports = { IPC };