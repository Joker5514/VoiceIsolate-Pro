/**
 * VoiceIsolate Pro — MLWorker Host (Layer 3: Pipeline)
 *
 * Creates the shared offline MLWorker with desktop model-cache bridging.
 */
'use strict';

import { MODEL_MANIFEST } from '../core/ModelManifest.js';
import { attachMLWorkerModelCache } from '../core/ModelCacheBridge.js';
import { applyMlWorkerMessage, setOrtStatus } from '../core/OrtStatus.js';

/**
 * @returns {Worker}
 */
export function createMLWorker() {
  const worker = new Worker('/src/workers/MLWorker.js');
  attachMLWorkerModelCache(worker);
  setOrtStatus({ provider: 'probing', detail: null });
  worker.addEventListener('message', (ev) => {
    applyMlWorkerMessage(ev.data || {});
    // Mirror ORT/ML cockpit pills when the worker reports provider/backend.
    const msg = ev.data || {};
    const setPill = globalThis._setVipEnginePill;
    if (typeof setPill !== 'function') return;
    if (msg.type === 'ready') {
      const backend = String(msg.backend || '').toLowerCase();
      setPill('engOrtPill', backend === 'webgpu' || backend === 'wasm' ? 'ready' : 'loading');
      setPill('engMlPill', 'ready');
      try {
        const el = globalThis.document?.getElementById?.('engOrtPill');
        if (el) el.title = `ORT provider: ${backend || 'unknown'}`;
      } catch { /* ignore */ }
    } else if (msg.type === 'error' && !msg.requestId) {
      setPill('engOrtPill', 'error');
      setPill('engMlPill', 'error');
    }
  });
  return worker;
}

/**
 * Send init manifest. Desktop cache bridge is only used in the Electron shell
 * (filesystem-backed model cache). Browser/Android use IndexedDB in-worker.
 * @param {Worker} worker
 */
export function initMLWorker(worker) {
  const useDesktopCache = Boolean(
    globalThis.vipDesktop?.readModelCache
    || globalThis.vipDesktop?.openFile
    || globalThis.__VIP_DESKTOP__
  );
  worker.postMessage({
    type: 'init',
    manifest: Object.values(MODEL_MANIFEST),
    useDesktopCache,
  });
}