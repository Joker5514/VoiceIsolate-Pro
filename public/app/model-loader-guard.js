/**
 * model-loader-guard.js — Singleton ONNX session guard
 * =====================================================
 * AUDIT FIX #8: Both model-loader.js and model-cdn-loader.js call
 * ort.InferenceSession.create() independently. If both are imported and
 * both attempt to initialize the same model, the second call races the
 * first and can cause:
 *   - Double memory allocation (2× model weights in GPU/WASM heap)
 *   - ORT internal state corruption on WebGPU backend
 *   - Silent inference errors from an incompletely-initialized session
 *
 * This module wraps ort.InferenceSession.create() in an idempotent
 * singleton. All model initialization — whether from model-loader.js
 * or model-cdn-loader.js — MUST go through getOrCreateSession().
 *
 * USAGE:
 *   import { getOrCreateSession } from './model-loader-guard.js';
 *   const session = await getOrCreateSession('demucs_v4', '/app/models/demucs_v4_quantized.onnx', ortOptions);
 */

'use strict';

/** @type {Map<string, Promise<ort.InferenceSession>>} */
const _sessionPromises = new Map();

/** @type {Map<string, ort.InferenceSession>} */
const _sessions = new Map();

/**
 * Returns an existing session for the given key, or creates one.
 * Concurrent callers with the same key all receive the same Promise —
 * ort.InferenceSession.create() is called exactly once per key.
 *
 * @param {string} key         Unique model identifier (e.g. 'demucs_v4').
 * @param {string} pathOrUrl   Path/URL passed to ort.InferenceSession.create().
 * @param {object} [ortOpts]   ORT session options (executionProviders, etc.).
 * @returns {Promise<ort.InferenceSession>}
 */
export async function getOrCreateSession(key, pathOrUrl, ortOpts = {}) {
  // Already resolved — return cached session immediately.
  if (_sessions.has(key)) {
    return _sessions.get(key);
  }

  // In-flight — return the existing promise so callers share the result.
  if (_sessionPromises.has(key)) {
    return _sessionPromises.get(key);
  }

  // First caller — initiate session creation.
  const defaultOpts = {
    executionProviders: [
      { name: 'webgpu' },
      { name: 'wasm' },
    ],
    graphOptimizationLevel: 'all',
    enableCpuMemArena: true,
    enableMemPattern: true,
    ...ortOpts,
  };

  const promise = (async () => {
    // ort must be available globally (loaded by index.html or imported upstream).
    if (typeof ort === 'undefined') {
      throw new Error('[model-loader-guard] onnxruntime-web (ort) is not loaded. Ensure the ORT script tag is present before this module runs.');
    }

    console.info(`[model-loader-guard] Creating session: ${key} from ${pathOrUrl}`);
    const session = await ort.InferenceSession.create(pathOrUrl, defaultOpts);
    _sessions.set(key, session);
    _sessionPromises.delete(key); // Clean up — session is resolved
    console.info(`[model-loader-guard] Session ready: ${key}`);
    return session;
  })();

  _sessionPromises.set(key, promise);

  // Propagate errors: remove stale promise so callers can retry.
  promise.catch((err) => {
    console.error(`[model-loader-guard] Session creation failed for ${key}:`, err);
    _sessionPromises.delete(key);
  });

  return promise;
}

/**
 * Returns the resolved session if available, or null.
 * Non-async — safe to call from synchronous code as a guard check.
 * @param {string} key
 * @returns {ort.InferenceSession|null}
 */
export function getSessionSync(key) {
  return _sessions.get(key) ?? null;
}

/**
 * Explicitly releases a session and removes it from the cache.
 * Call when the user closes the app or navigates away to free GPU memory.
 * @param {string} key
 */
export async function releaseSession(key) {
  const session = _sessions.get(key);
  if (session) {
    try { await session.release(); } catch (_) { /* best-effort */ }
    _sessions.delete(key);
    console.info(`[model-loader-guard] Session released: ${key}`);
  }
}

/**
 * Release all sessions. Call on page unload.
 */
export async function releaseAllSessions() {
  await Promise.allSettled([..._sessions.keys()].map(releaseSession));
}

// Auto-release on page unload to free WebGPU resources.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => releaseAllSessions(), { once: true });
}
