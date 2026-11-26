/**
 * VoiceIsolate Pro — ONNX Runtime provider status (Layer 1: Core)
 *
 * Tracks WebGPU vs WASM execution provider for UI and research logs.
 * Pure state holder — workers post updates via setOrtStatus().
 */
'use strict';

import { explainProviderReady } from './ProviderHandshake.js';
import { MODEL_MANIFEST } from './ModelManifest.js';
import { clearAttestationSnapshot, recordAttestationSnapshot } from './CapabilityRegistry.js';

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
 * @property {string|null} [workerInstanceId] id of the worker whose attestation is current
 * @property {object|null} [attestation] last validated worker attestation (read-only)
 * @property {string[]} [modelsReady] model ids whose attestation state is 'ready'
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
  workerInstanceId: null,
  attestation: null,
  modelsReady: [],
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
    modelsReady: [...(_status.modelsReady || [])],
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
    modelsReady: patch.modelsReady
      ? [...patch.modelsReady]
      : (_status.modelsReady || []),
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

/** Valid capability states in a worker attestation. */
export const ATTESTATION_CAPABILITY_STATES = Object.freeze(['pending', 'ready', 'degraded', 'unavailable']);

/**
 * ML-02: validate a worker attestation. Pure function (Node-testable).
 * The worker is the authority on its own model state; the browser only
 * checks the attestation's schema, freshness, instance, and that every
 * shipped model it claims matches its manifest pin. A failed validation
 * means the attestation is not trusted — it never marks a model ready.
 *
 * @param {object} attestation the worker's attestation object
 * @param {{ manifest?: object, expectedInstanceId?: string|null, now?: number, maxAgeMs?: number }} [options]
 * @returns {{ ok: boolean, errors: string[], readyModels: string[], degradedModels: string[], unavailableModels: string[], pendingModels: string[] }}
 */
export function validateWorkerAttestation(attestation, options = {}) {
  const {
    manifest = MODEL_MANIFEST,
    expectedInstanceId = null,
    now = Date.now(),
    maxAgeMs = 5 * 60 * 1000,
  } = options;
  const errors = [];
  const readyModels = [];
  const degradedModels = [];
  const unavailableModels = [];
  const pendingModels = [];
  if (!attestation || typeof attestation !== 'object') {
    return { ok: false, errors: ['attestation is missing or not an object'], readyModels, degradedModels, unavailableModels, pendingModels };
  }
  if (attestation.schemaVersion !== 1) {
    errors.push(`schemaVersion ${String(attestation.schemaVersion)} != 1`);
  }
  const instanceId = attestation.workerInstanceId;
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    errors.push('workerInstanceId is missing or not a string');
  } else if (expectedInstanceId != null && instanceId !== expectedInstanceId) {
    errors.push(`workerInstanceId '${instanceId}' != expected '${expectedInstanceId}' (worker restarted)`);
  }
  const issuedAt = attestation.issuedAt;
  if (!Number.isFinite(issuedAt)) {
    errors.push('issuedAt is missing or not a finite number');
  } else {
    if (issuedAt > now + 60 * 1000) errors.push('issuedAt is in the future (clock skew > 60 s)');
    if (now - issuedAt > maxAgeMs) errors.push(`issuedAt is stale (${Math.round((now - issuedAt) / 1000)} s old, max ${Math.round(maxAgeMs / 1000)} s)`);
  }
  const caps = attestation.capabilities;
  if (!caps || typeof caps !== 'object') {
    errors.push('capabilities is missing or not an object');
  } else {
    for (const [id, entry] of Object.entries(manifest || {})) {
      if (entry.shipped === false) continue;
      const cap = caps[id];
      if (!cap || typeof cap !== 'object') {
        errors.push(`shipped model '${id}' has no capability in the attestation`);
        continue;
      }
      if (!ATTESTATION_CAPABILITY_STATES.includes(cap.state)) {
        errors.push(`model '${id}' has invalid state '${String(cap.state)}'`);
        continue;
      }
      // A manifest entry with no string sha256 has no file pin to compare
      // (deepfilternet3 is a composite with no file of its own — its parts
      // carry the pins and its integrity evidence is the self-test output
      // hash). Skipping the comparison here is correct, not a hole; the
      // worker refuses to load any unpinned SHIPPED model (verifyIntegrity).
      if (typeof entry.sha256 === 'string' && entry.sha256.length === 64
        && typeof cap.sha256 === 'string' && cap.sha256 !== entry.sha256) {
        errors.push(`model '${id}' capability sha256 does not match the manifest pin`);
      }
      if (cap.state === 'ready') readyModels.push(id);
      else if (cap.state === 'degraded') degradedModels.push(id);
      else if (cap.state === 'unavailable') unavailableModels.push(id);
      else pendingModels.push(id);
    }
  }
  const st = attestation.selfTest;
  if (!st || typeof st !== 'object' || typeof st.passed !== 'boolean'
    || typeof st.testVersion !== 'string' || typeof st.fixtureId !== 'string') {
    errors.push('selfTest summary is missing or malformed');
  }
  if (!attestation.runtime || typeof attestation.runtime !== 'object'
    || typeof attestation.runtime.executionProvider !== 'string') {
    errors.push('runtime is missing or malformed');
  }
  return { ok: errors.length === 0, errors, readyModels, degradedModels, unavailableModels, pendingModels };
}

/**
 * Apply MLWorker `ready` / `error` / `warmed` messages.
 * @param {object} msg
 */
export function applyMlWorkerMessage(msg = {}) {
  if (msg.type === 'model-attestation' && msg.attestation) {
    const att = msg.attestation;
    // A different instance id means the worker was recycled: invalidate
    // everything the previous worker attested before adopting the new one.
    if (_status.workerInstanceId && att.workerInstanceId
      && att.workerInstanceId !== _status.workerInstanceId) {
      clearAttestationSnapshot();
      setOrtStatus({
        provider: 'probing',
        providerVerified: false,
        modelsLoaded: [],
        modelsReady: [],
        workerInstanceId: null,
        attestation: null,
        detail: 'ML worker restarted — previous attestation invalidated',
      });
    }
    const result = validateWorkerAttestation(att, { expectedInstanceId: _status.workerInstanceId });
    if (!result.ok) {
      setOrtStatus({ detail: `Worker attestation rejected: ${result.errors.join('; ')}` });
      return;
    }
    const snapshot = {};
    for (const [id, cap] of Object.entries(att.capabilities || {})) {
      snapshot[id] = {
        id,
        kind: 'model',
        enabled: cap.state === 'ready',
        status: cap.state,
        reason: cap.reason || null,
      };
    }
    recordAttestationSnapshot(snapshot);
    setOrtStatus({
      workerInstanceId: att.workerInstanceId,
      attestation: att,
      modelsReady: result.readyModels,
      detail: result.degradedModels.length || result.unavailableModels.length
        ? `Models degraded/unavailable: ${[...result.degradedModels, ...result.unavailableModels].join(', ')}`
        : null,
    });
    return;
  }
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
  validateWorkerAttestation,
  ATTESTATION_CAPABILITY_STATES,
};
