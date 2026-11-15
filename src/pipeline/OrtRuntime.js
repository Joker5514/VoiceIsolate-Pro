/**
 * VoiceIsolate Pro — page-level ONNX Runtime loader.
 *
 * Workers already import /lib/ort.min.js for stem inference. Speaker detection
 * runs on the page and needs the same vendored runtime. Loading the script is
 * not the same as an execution provider: WebGPU is reported only after
 * InferenceSession.create succeeds with that provider alone.
 */
'use strict';

import { getOrtStatus, setOrtStatus } from '../core/OrtStatus.js';

const ORT_SRC = '/lib/ort.min.js';
const WASM_PATH = '/lib/';
/** A script that never fires load or error must not stall speaker detection. */
const SCRIPT_LOAD_MS = 12000;
/** One provider attempt. A hung WebGPU create must still reach the WASM attempt. */
const SESSION_CREATE_MS = 12000;

/** @type {Map<string, Promise<object>>} */
const _sessions = new Map();
let _loadPromise = null;
let _readyPromise = null;
let _readyOrt = null;
let _webgpuCandidate = null;

function publish(patch) {
  const snap = setOrtStatus(patch);
  if (typeof globalThis !== 'undefined') {
    globalThis.__vipOrtStatus = snap;
  }
  return snap;
}

/**
 * @param {object} ort
 */
function configureOrt(ort) {
  if (ort?.env?.wasm) {
    ort.env.wasm.wasmPaths = WASM_PATH;
    const isolated = globalThis.crossOriginIsolated === true
      && typeof SharedArrayBuffer === 'function';
    const cores = globalThis.navigator?.hardwareConcurrency || 1;
    ort.env.wasm.numThreads = isolated ? Math.min(4, Math.max(1, cores - 1)) : 1;
  }
}

/**
 * Adapter presence only. Does not create a session and does not mark WebGPU active.
 * @returns {Promise<boolean>}
 */
export async function probeWebGpuCandidate() {
  if (_webgpuCandidate != null) return _webgpuCandidate;
  try {
    const gpu = globalThis.navigator?.gpu;
    if (!gpu || typeof gpu.requestAdapter !== 'function') {
      _webgpuCandidate = false;
    } else {
      _webgpuCandidate = Boolean(await gpu.requestAdapter());
    }
  } catch {
    _webgpuCandidate = false;
  }
  const current = getOrtStatus();
  if (current.provider !== 'webgpu' && current.provider !== 'wasm') {
    publish({
      webgpuAvailable: _webgpuCandidate,
      provider: current.provider === 'unknown' ? 'probing' : current.provider,
      providerVerified: false,
      detail: _webgpuCandidate
        ? 'WebGPU adapter present; provider not initialized'
        : 'No WebGPU adapter; WASM is the candidate provider',
    });
  } else {
    publish({ webgpuAvailable: _webgpuCandidate || current.webgpuAvailable });
  }
  return _webgpuCandidate;
}

/**
 * Load the vendored onnxruntime-web build. Safe to call more than once.
 * @returns {Promise<{ ort: object|null, error: string|null, webgpuCandidate: boolean }>}
 */
export function loadOrtRuntime() {
  if (globalThis.ort?.InferenceSession) {
    if (_readyPromise && _readyOrt === globalThis.ort) return _readyPromise;
    _readyOrt = globalThis.ort;
    configureOrt(globalThis.ort);
    _readyPromise = probeWebGpuCandidate().then((webgpuCandidate) => {
      const current = getOrtStatus();
      const verified = current.providerVerified === true;
      publish({
        runtimeLoaded: true,
        provider: verified ? current.provider : 'probing',
        providerVerified: verified,
        detail: verified ? current.detail : 'ONNX runtime loaded; session not created',
        webgpuAvailable: webgpuCandidate,
      });
      return { ort: globalThis.ort, error: null, webgpuCandidate };
    });
    return _readyPromise;
  }
  if (_loadPromise) return _loadPromise;

  let pending = null;
  pending = new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let script = null;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error || !globalThis.ort?.InferenceSession) {
        try { script?.remove(); } catch { /* the tag may already be gone */ }
        // Null on a microtask so a synchronous failure still returns this promise.
        queueMicrotask(() => {
          if (_loadPromise === pending) _loadPromise = null;
        });
        const detail = error || 'onnxruntime-web not loaded';
        publish({
          runtimeLoaded: false,
          provider: 'error',
          providerVerified: false,
          detail,
        });
        resolve({ ort: null, error: detail, webgpuCandidate: false });
        return;
      }
      configureOrt(globalThis.ort);
      probeWebGpuCandidate().then((webgpuCandidate) => {
        publish({
          runtimeLoaded: true,
          provider: 'probing',
          providerVerified: false,
          webgpuAvailable: webgpuCandidate,
          detail: 'ONNX runtime loaded; session not created',
        });
        resolve({ ort: globalThis.ort, error: null, webgpuCandidate });
      }).catch(() => {
        resolve({ ort: globalThis.ort, error: null, webgpuCandidate: false });
      });
    };
    timer = setTimeout(() => finish('Timed out loading /lib/ort.min.js'), SCRIPT_LOAD_MS);
    if (typeof document === 'undefined' || !document.head) {
      finish('onnxruntime-web not loaded');
      return;
    }
    const existing = document.querySelector('script[data-vip-ort="1"]');
    if (existing && globalThis.ort?.InferenceSession) {
      finish(null);
      return;
    }
    // A failed or timed-out tag does not fire load/error again. Replace it.
    if (existing) existing.remove();
    script = document.createElement('script');
    script.src = ORT_SRC;
    script.async = true;
    script.dataset.vipOrt = '1';
    script.onload = () => finish(null);
    script.onerror = () => {
      script.remove();
      finish('Failed to load /lib/ort.min.js');
    };
    document.head.appendChild(script);
  });
  _loadPromise = pending;
  return pending;
}

function createSessionAttempt(ort, source, providers) {
  let timer = null;
  const attempt = ort.InferenceSession.create(source, { executionProviders: providers });
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`ONNX ${providers[0]} session timed out after ${SESSION_CREATE_MS}ms`));
    }, SESSION_CREATE_MS);
  });
  const guarded = Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
  guarded.catch(() => {
    attempt.then((session) => {
      if (session && typeof session.release === 'function') {
        Promise.resolve(session.release()).catch(() => {});
      }
    }).catch(() => {});
  });
  return guarded;
}

/**
 * Create one session. WebGPU is attempted only when an adapter exists, and
 * only by itself. A failed or timed-out WebGPU create falls back to WASM.
 * The cached session is reused for the same cacheKey.
 *
 * @param {string|ArrayBuffer} source
 * @param {{ cacheKey?: string }} [options]
 */
export async function createOrtSession(source, options = {}) {
  const cacheKey = options.cacheKey || null;
  if (cacheKey && _sessions.has(cacheKey)) return _sessions.get(cacheKey);

  const pending = (async () => {
    const loaded = await loadOrtRuntime();
    if (!loaded.ort?.InferenceSession) {
      throw new Error(loaded.error || 'onnxruntime-web not loaded');
    }
    const candidate = await probeWebGpuCandidate();
    let session = null;
    let provider = 'wasm';
    let detail = null;
    if (candidate) {
      try {
        session = await createSessionAttempt(loaded.ort, source, ['webgpu']);
        provider = 'webgpu';
      } catch (err) {
        detail = err?.message || String(err);
        session = null;
      }
    }
    if (!session) {
      session = await createSessionAttempt(loaded.ort, source, ['wasm']);
      provider = 'wasm';
    }
    publish({
      runtimeLoaded: true,
      provider,
      providerVerified: true,
      webgpuAvailable: candidate,
      detail: provider === 'webgpu' ? null : (detail || null),
    });
    try {
      globalThis.VIP_liveDiagnostics?.log?.(
        provider === 'webgpu' ? 'info' : 'warn',
        'ort.session',
        { provider, providerVerified: true, cacheKey, detail },
      );
    } catch { /* diagnostics must not affect inference */ }
    return session;
  })();

  if (cacheKey) _sessions.set(cacheKey, pending);
  try {
    return await pending;
  } catch (err) {
    if (cacheKey) _sessions.delete(cacheKey);
    publish({
      provider: 'error',
      providerVerified: false,
      detail: err?.message || String(err),
    });
    throw err;
  }
}

export function getOrtRuntimeStatus() {
  return getOrtStatus();
}

export default {
  loadOrtRuntime,
  createOrtSession,
  probeWebGpuCandidate,
  getOrtRuntimeStatus,
};
