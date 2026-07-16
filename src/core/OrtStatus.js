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
 */

/** @type {OrtStatusSnapshot} */
let _status = {
  provider: 'unknown',
  detail: null,
  updatedAt: 0,
  modelsLoaded: [],
  webgpuAvailable: false,
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
  switch (s.provider) {
    case 'webgpu': return 'WebGPU active';
    case 'wasm': return 'WASM fallback';
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
  if (msg.type === 'ready') {
    const backend = String(msg.backend || '').toLowerCase();
    setOrtStatus({
      provider: backend === 'webgpu' ? 'webgpu' : backend === 'wasm' ? 'wasm' : 'unknown',
      detail: null,
      webgpuAvailable: backend === 'webgpu' || _status.webgpuAvailable,
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
