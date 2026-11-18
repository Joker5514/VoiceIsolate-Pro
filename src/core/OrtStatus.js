/**
 * VoiceIsolate Pro — ONNX Runtime provider status (Layer 1: Core)
 *
 * Tracks WebGPU vs WASM execution provider for UI and research logs.
 * Pure state holder — workers post updates via setOrtStatus().
 */
'use strict';

import { explainProviderReady } from './ProviderHandshake.js';

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

const PROVIDER_LABEL = Object.freeze({ webgpu: 'WebGPU', wasm: 'WASM' });

/**
 * The execution provider a stems result actually ran on, for logs.
 * MLWorker attaches backend / preferredBackend / sessionBackends to every
 * stems message (actualBackendsFor). preferredBackend is the adapter probe;
 * backend is what InferenceSession.create produced.
 * @param {{ backend?: string|null, preferredBackend?: string|null, sessionBackends?: object|null, fromCache?: boolean }} [result]
 * @returns {{ effectiveProvider: string, preferredProvider: string|null, webgpuFallback: boolean, sessionBackends: object|null, summary: string }}
 */
export function describeEffectiveProvider(result = {}) {
  const preferred = result?.preferredBackend ? String(result.preferredBackend).toLowerCase() : null;
  const sessions = result?.sessionBackends && typeof result.sessionBackends === 'object'
    ? { ...result.sessionBackends }
    : null;
  if (result?.fromCache && !result?.backend) {
    return { effectiveProvider: 'none', preferredProvider: preferred, webgpuFallback: false, sessionBackends: sessions, summary: 'no ONNX session (stems from cache)' };
  }
  const backend = result?.backend ? String(result.backend).toLowerCase() : 'unknown';
  const webgpuFallback = preferred === 'webgpu' && backend !== 'webgpu' && backend !== 'unknown';
  let summary;
  if (backend === 'webgpu') summary = 'WebGPU (session verified)';
  else if (backend === 'wasm') summary = webgpuFallback ? 'WASM (fell back from WebGPU)' : 'WASM (no WebGPU adapter)';
  else if (backend === 'mixed') {
    const parts = Object.entries(sessions || {}).map(([id, b]) => `${id}=${b}`);
    summary = `mixed (${parts.join(', ')})`;
  } else summary = 'unknown (worker did not report a backend)';
  return { effectiveProvider: backend, preferredProvider: preferred, webgpuFallback, sessionBackends: sessions, summary };
}

/** Provider label for UI strings. */
export function providerLabel(provider) {
  return PROVIDER_LABEL[provider] || String(provider || 'unknown');
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
  if (msg.type === 'ready' || msg.type === 'ort-provider') {
    const explained = explainProviderReady(msg);
    if (msg.type === 'ort-provider' && explained.providerVerified) {
      setOrtStatus({
        provider: explained.backend,
        providerVerified: true,
        runtimeLoaded: true,
        detail: null,
        webgpuAvailable: explained.backend === 'webgpu' || _status.webgpuAvailable,
      });
      return;
    }
    if (msg.type === 'ready') {
      setOrtStatus({
        provider: 'probing',
        providerVerified: false,
        runtimeLoaded: true,
        detail: explained.detail,
        webgpuAvailable: Boolean(msg.gpuCandidate) || _status.webgpuAvailable,
      });
    }
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
