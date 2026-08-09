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
/** Resolve worker URL for browser / Capacitor / Electron vip:// (absolute same-origin). */
function resolveWorkerUrl(path) {
  try {
    const href = globalThis.location?.href;
    if (href && href !== 'about:blank') return new URL(path, href).href;
  } catch { /* fall through */ }
  return path;
}

export function createMLWorker() {
  // Absolute path required so Capacitor Android (https://voiceisolatepro.app/…)
  // and Electron vip://app resolve /src/workers correctly.
  const workerUrl = resolveWorkerUrl('/src/workers/MLWorker.js');
  const worker = new Worker(workerUrl, { name: 'vip-ml-worker' });
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
        if (el) {
          el.title = backend === 'webgpu'
            ? 'ONNX Runtime: WebGPU (preferred)'
            : backend === 'wasm'
              ? 'ONNX Runtime: WASM fallback'
              : `ONNX Runtime: ${backend || 'unknown'}`;
          el.textContent = backend === 'webgpu' ? 'WebGPU' : backend === 'wasm' ? 'WASM' : 'ORT';
        }
        const ml = globalThis.document?.getElementById?.('engMlPill');
        if (ml) ml.title = `Local ONNX ready (${backend || 'unknown'})`;
        const strip = globalThis.document?.getElementById?.('ortBackendLabel');
        if (strip) {
          strip.textContent = backend === 'webgpu' ? 'Backend: WebGPU' : backend === 'wasm' ? 'Backend: WASM' : 'Backend: —';
          strip.dataset.backend = backend || '';
        }
      } catch { /* ignore */ }
    } else if (msg.type === 'stems' && msg.modelChain) {
      try {
        const chainEl = globalThis.document?.getElementById?.('activeModelChain');
        if (chainEl) {
          chainEl.textContent = `Chain: ${(msg.modelChain || []).join(' → ') || '—'}`
            + (msg.pipelineMode === 'fused-spectral-single-stft' ? ' · single-STFT fuse' : '');
        }
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