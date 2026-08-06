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
  UPDATE_CHECK: 'vip:update-check',
  UPDATE_DOWNLOAD: 'vip:update-download',
  UPDATE_INSTALL: 'vip:update-install',
  UPDATE_STATUS: 'vip:update-status',
  // Local SAM-Audio worker (Option B) — main process only spawns localhost worker
  SAM_WORKER_STATUS: 'vip:sam-worker-status',
  SAM_WORKER_START: 'vip:sam-worker-start',
  SAM_WORKER_STOP: 'vip:sam-worker-stop',
  SAM_WORKER_CAPABILITIES: 'vip:sam-worker-capabilities',
});

module.exports = { IPC };