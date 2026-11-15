/**
 * VoiceIsolate Pro — ONNX Runtime provider status (Layer 1: Core)
 *
 * Tracks WebGPU vs WASM execution provider for UI and research logs.
 * Pure state holder — workers post updates via setOrtStatus().
 */
'use strict';

/** @typedef {'unknown'|'probing'|'webgpu'|'wasm'|'error'} OrtProviderState */

/**
 * @typedef {object} OrtStatusSnapshot
 * @property {OrtProviderState} provider
 * @property {string|null} detail
 * @property {number} updatedAt
 * @property {string[]} modelsLoaded
 * @property {boolean} webgpuAvailable
 * @property {boolean} providerVerified true only after InferenceSession.create succeeds
 * @property {boolean} [runtimeLoaded]
 */

/** @type {OrtStatusSnapshot} */
let _status = {
  provider: 'unknown',
  detail: null,
  updatedAt: 0,
  modelsLoaded: [],
  webgpuAvailable: false,
  providerVerified: false,
  runtimeLoaded: false,
};

/** @type {Set<(s: OrtStatusSnapshot) => void>} */
const _listeners = new Set();

/**
 * @returns {OrtStatusSnapshot}
 */
export function getOrtStatus() {
  return {
    ..._status,
    modelsLoaded: [..._status.modelsLoaded],
  };
}

/**
 * @param {Partial<OrtStatusSnapshot>} patch
 */
export function setOrtStatus(patch = {}) {
  _status = {
    ..._status,
    ...patch,
    modelsLoaded: patch.modelsLoaded
      ? [...patch.modelsLoaded]
      : _status.modelsLoaded,
    updatedAt: Date.now(),
  };
  const snap = getOrtStatus();
  for (const fn of _listeners) {
    try { fn(snap); } catch { /* ignore listener errors */ }
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.__vipOrtStatus = snap;
  }
  return snap;
}

/**
 * @param {(s: OrtStatusSnapshot) => void} fn
 * @returns {() => void}
 */
export function subscribeOrtStatus(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Human-readable label for UI pills.
 * @param {OrtStatusSnapshot} [s]
 * @returns {string}
 */
export function formatOrtProviderLabel(s = getOrtStatus()) {
  if (s.provider === 'webgpu' && s.providerVerified !== true) return 'Probing GPU…';
  switch (s.provider) {
    case 'webgpu': return 'WebGPU active';
    case 'wasm': return s.providerVerified === true ? 'WASM fallback' : 'ORT idle';
    case 'probing': return 'Probing GPU…';
    case 'error': return s.detail ? `ORT error: ${s.detail}` : 'ORT error';
    default: return 'ORT idle';
  }
}

/**
 * Probe WebGPU availability on the main thread (does not init ORT).
 * @returns {Promise<boolean>}
 */
export async function probeWebGpuAvailable() {
  try {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu?.requestAdapter) {
      setOrtStatus({ webgpuAvailable: false });
      return false;
    }
    const adapter = await gpu.requestAdapter();
    const ok = Boolean(adapter);
    setOrtStatus({ webgpuAvailable: ok });
    return ok;
  } catch {
    setOrtStatus({ webgpuAvailable: false });
    return false;
  }
}

/**
 * Apply MLWorker `ready` / `error` / `warmed` messages.
 * @param {object} msg
 */
export function applyMlWorkerMessage(msg = {}) {
  if (msg.type === 'ort-provider' && msg.providerVerified === true) {
    const backend = String(msg.backend || '').toLowerCase();
    if (backend === 'webgpu' || backend === 'wasm') {
      setOrtStatus({
        provider: backend,
        providerVerified: true,
        runtimeLoaded: true,
        detail: null,
        webgpuAvailable: backend === 'webgpu' || _status.webgpuAvailable,
      });
    }
    return;
  }
  if (msg.type === 'stage' && msg.stage === 'ort-fallback') {
    // Posted before the WASM session exists. Verification arrives later
    // as ort-provider, and only after InferenceSession.create succeeds.
    setOrtStatus({
      provider: 'probing',
      providerVerified: false,
      detail: msg.detail || msg.label || 'WebGPU failed — local WASM retry',
      webgpuAvailable: _status.webgpuAvailable,
    });
    return;
  }
  if (msg.type === 'ready') {
    const backend = String(msg.backend || '').toLowerCase();
    const verified = msg.providerVerified === true && (backend === 'webgpu' || backend === 'wasm');
    setOrtStatus({
      provider: verified ? backend : 'probing',
      providerVerified: verified,
      runtimeLoaded: true,
      detail: verified
        ? null
        : (msg.gpuCandidate
          ? 'WebGPU adapter present; provider not initialized'
          : 'ONNX runtime loaded; execution provider not verified'),
      webgpuAvailable: Boolean(msg.gpuCandidate) || _status.webgpuAvailable,
    });
    return;
  }
  if (msg.type === 'warmed' && Array.isArray(msg.modelIds)) {
    const set = new Set([..._status.modelsLoaded, ...msg.modelIds]);
    setOrtStatus({ modelsLoaded: [...set] });
    return;
  }
  if (msg.type === 'error' && msg.message) {
    setOrtStatus({ provider: 'error', detail: String(msg.message).slice(0, 200) });
  }
}

export default {
  getOrtStatus,
  setOrtStatus,
  subscribeOrtStatus,
  formatOrtProviderLabel,
  probeWebGpuAvailable,
  applyMlWorkerMessage,
};
