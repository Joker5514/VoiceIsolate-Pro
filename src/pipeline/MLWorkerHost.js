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

function diag(level, event, detail) {
  try { globalThis.VIP_liveDiagnostics?.log?.(level, event, detail); } catch { /* diagnostics must not affect inference */ }
}

/**
 * Put the worker's provider facts in the session log. `ready` comes before
 * any session; ort-provider follows InferenceSession.create; ort-fallback
 * means WebGPU failed and a WASM retry is starting.
 * @param {object} msg
 */
function logProviderMessage(msg) {
  if (msg.type === 'ready') {
    diag('info', 'ort.worker-ready', {
      effectiveProvider: 'none (no session yet)',
      webgpuCandidate: msg.gpuCandidate === true,
      providerVerified: false,
    });
  } else if (msg.type === 'ort-provider' && msg.providerVerified === true) {
    diag('info', 'ort.provider-verified', {
      provider: String(msg.backend || '').toLowerCase() || null,
      providerVerified: true,
      sessionKey: msg.sessionKey || null,
    });
  } else if (msg.type === 'stage' && msg.stage === 'ort-fallback') {
    diag('warn', 'ort.webgpu-fallback', {
      modelId: msg.modelId || null,
      sessionKey: msg.sessionKey || null,
      reason: msg.reason || null,
      detail: msg.detail || msg.label || null,
      retry: 'wasm',
    });
  }
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
    logProviderMessage(ev.data || {});
    // Mirror ORT/ML cockpit pills when the worker reports provider/backend.
    const msg = ev.data || {};
    const setPill = globalThis._setVipEnginePill;
    if (typeof setPill !== 'function') return;
    if (msg.type === 'ready' || msg.type === 'ort-provider') {
      const backend = String(msg.backend || '').toLowerCase();
      // A ready handshake is not a verified provider. Only ort-provider, posted
      // after InferenceSession.create, may set providerVerified === true.
      const verified = msg.type === 'ort-provider' && msg.providerVerified === true && (backend === 'webgpu' || backend === 'wasm');
      setPill('engOrtPill', verified ? 'ready' : 'loading');
      setPill('engMlPill', verified ? 'ready' : 'loading');
      try {
        const el = globalThis.document?.getElementById?.('engOrtPill');
        if (el) {
          el.title = verified && backend === 'webgpu'
            ? 'ONNX Runtime: WebGPU session initialized'
            : verified
              ? 'ONNX Runtime: WASM session initialized'
              : 'ONNX Runtime loaded; execution provider not verified';
          el.textContent = verified && backend === 'webgpu' ? 'WebGPU' : verified ? 'WASM' : 'ORT';
        }
        const ml = globalThis.document?.getElementById?.('engMlPill');
        if (ml) ml.title = verified ? `Local ONNX session (${backend})` : 'Local ONNX runtime loaded';
        const strip = globalThis.document?.getElementById?.('ortBackendLabel');
        if (strip) {
          strip.textContent = verified && backend === 'webgpu'
            ? 'Backend: WebGPU'
            : verified
              ? 'Backend: WASM'
              : 'Backend: unverified';
          strip.dataset.backend = verified ? backend : 'unverified';
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