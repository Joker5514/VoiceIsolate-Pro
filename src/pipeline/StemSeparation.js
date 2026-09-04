/**
 * VoiceIsolate Pro — Shared offline stem separation (Layer 3)
 *
 * Single MLWorker lifecycle used by Landing and Engineer Mode so both surfaces
 * run the same model chains (Demucs → denoise, etc.).
 */
'use strict';

import { DEFAULT_ML_MODEL_IDS } from '../core/ml-defaults.js';
import { createMLWorker, initMLWorker } from './MLWorkerHost.js';
import { clearStemCache, getCachedStems, setCachedStems, stemCacheKey } from './MLStemCache.js';
import { copyFloat32Channel, createYieldBudget } from './ui-yield.js';

let _worker = null;
let _ready = null;
let _seq = 0;
let _activeRequestId = null;
let _activeCancel = null;
/** @type {Set<string>} */
const _warmedModels = new Set();
/** @type {Array<{ resolve: Function, reject: Function, timer: *, ids: string[] }>} */
let _warmupWaiters = [];
let _warmupHooked = false;

const WARMUP_TIMEOUT_MS = 120000;
/** Max wait for a single separation job before falling back to DSP. */
const PROCESS_TIMEOUT_MS = 180000;
/** If the worker stops posting progress for this long, treat as stall and fail fast. */
const PROGRESS_STALL_MS = 45000;

function createAbortError() {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Processing cancelled', 'AbortError')
    : Object.assign(new Error('Processing cancelled'), { name: 'AbortError' });
}

function rejectWarmupWaiters(error) {
  const pending = _warmupWaiters.splice(0);
  for (const waiter of pending) {
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }
}

function recycleWorker(worker, error) {
  if (worker && _worker !== worker) return;
  if (_worker) {
    try { _worker.terminate(); } catch { /* worker already stopped */ }
    _worker = null;
  }
  _ready = null;
  _activeRequestId = null;
  _activeCancel = null;
  _warmupHooked = false;
  _warmedModels.clear();
  rejectWarmupWaiters(error || new Error('[VIP][StemSeparation] MLWorker reset'));
}

function getWorker() {
  if (_worker) return _worker;
  _worker = createMLWorker();
  return _worker;
}

function hookWarmupListener(w) {
  if (_warmupHooked) return;
  _warmupHooked = true;
  w.addEventListener('message', (ev) => {
    const msg = ev.data || {};
    if (msg.type !== 'warmed') return;
    for (const id of msg.modelIds || []) _warmedModels.add(id);
    const pending = _warmupWaiters.splice(0);
    for (const waiter of pending) {
      clearTimeout(waiter.timer);
      const stillMissing = waiter.ids.filter((id) => !_warmedModels.has(id));
      if (stillMissing.length === 0) waiter.resolve(msg);
      else _warmupWaiters.push(waiter);
    }
  });
  w.addEventListener('error', (ev) => {
    recycleWorker(w, new Error(ev?.message || '[VIP][StemSeparation] MLWorker error'));
  });
  w.addEventListener('messageerror', () => {
    recycleWorker(w, new Error('[VIP][StemSeparation] worker message could not be deserialized'));
  });
}

function ensureReady() {
  if (_ready) return _ready;
  const w = getWorker();
  hookWarmupListener(w);
  let resolveReady;
  let rejectReady;
  const readyPromise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  _ready = readyPromise;

  let settled = false;
  let timer = null;
  const cleanup = () => {
    clearTimeout(timer);
    w.removeEventListener('message', onMsg);
    w.removeEventListener('error', onErr);
    w.removeEventListener('messageerror', onMessageError);
  };
  const succeed = (backend) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveReady(backend);
  };
  const fail = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    recycleWorker(w, error);
    rejectReady(error);
  };
  const onMsg = (ev) => {
    const msg = ev?.data;
    if (!msg || typeof msg !== 'object') {
      fail(new Error('[VIP][StemSeparation] Malformed MLWorker init message'));
      return;
    }
    if (msg.type === 'ready') {
      try {
        w.postMessage({ type: 'warmup', modelIds: [...DEFAULT_ML_MODEL_IDS] });
        succeed(msg.backend || 'wasm');
      } catch (error) {
        fail(error);
      }
    } else if (msg.type === 'error') {
      fail(new Error(msg.message || 'MLWorker init failed'));
    }
  };
  const onErr = (e) => fail(new Error(e?.message || 'MLWorker error'));
  const onMessageError = () => fail(new Error(
    '[VIP][StemSeparation] worker init message could not be deserialized',
  ));

  timer = setTimeout(() => {
    fail(new Error('[VIP][StemSeparation] MLWorker init timeout'));
  }, 30000);
  w.addEventListener('message', onMsg);
  w.addEventListener('error', onErr);
  w.addEventListener('messageerror', onMessageError);
  try {
    initMLWorker(w);
  } catch (error) {
    fail(error);
  }
  return readyPromise;
}

/** Prefetch + compile ONNX sessions while the user decodes a file. */
export async function warmupModels(modelIds = DEFAULT_ML_MODEL_IDS) {
  await ensureReady();
  const ids = (Array.isArray(modelIds) ? modelIds : []).filter((id) => typeof id === 'string' && id);
  const missing = ids.filter((id) => !_warmedModels.has(id));
  if (missing.length === 0) return { modelIds: ids };

  const w = getWorker();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = _warmupWaiters.findIndex((x) => x.resolve === resolve);
      if (idx >= 0) _warmupWaiters.splice(idx, 1);
      reject(new Error('[VIP][StemSeparation] ML warmup timeout'));
    }, WARMUP_TIMEOUT_MS);
    _warmupWaiters.push({ resolve, reject, timer, ids: missing });
    try {
      w.postMessage({ type: 'warmup', modelIds: missing });
    } catch (error) {
      recycleWorker(w, error);
    }
  });
}

export async function separateStems(channelData, sampleRate, options = {}) {
  const modelIds = options.modelIds?.length
    ? options.modelIds
    : options.modelId
      ? [options.modelId]
      : [...DEFAULT_ML_MODEL_IDS];
  const processingRevision = typeof options.processingConfig?.revision === 'string'
    ? options.processingConfig.revision
    : '';
  // Engineer spectral controls alter the reconstructed stems, so the result
  // cache must be keyed by their Process-time snapshot. Slider drags do not
  // reach this path; the key changes only when the user presses Process.
  const cacheKey = stemCacheKey(
    channelData,
    sampleRate,
    modelIds,
    options.sourceName,
    processingRevision,
  );
  const cached = getCachedStems(cacheKey);
  if (cached) {
    options.onProgress?.({ type: 'stage', stage: 'separate', percent: 100, label: 'Using cached stems…' });
    return {
      clean: cached.clean.map((c) => new Float32Array(c)),
      noise: cached.noise.map((c) => new Float32Array(c)),
      sampleRate: cached.sampleRate,
      passthrough: cached.passthrough,
      fromCache: true,
      appliedProcessingConfigRevision: processingRevision || null,
    };
  }

  const signal = options.signal || null;
  if (signal?.aborted) {
    throw createAbortError();
  }

  await ensureReady();
  if (signal?.aborted) throw createAbortError();
  const w = getWorker();
  const requestId = ++_seq;
  const { onProgress } = options;
  // transferOwned: channel buffers are exclusive copies the worker may detach.
  // Engineer mid-channel plan always allocates owned arrays — skip a second memcpy.
  let copies;
  if (options.transferOwned) {
    copies = channelData.map((ch) => (ch instanceof Float32Array ? ch : new Float32Array(ch)));
  } else {
    const yieldBudget = createYieldBudget();
    copies = [];
    for (let ch = 0; ch < channelData.length; ch++) {
      copies.push(await copyFloat32Channel(channelData[ch], { yieldBudget }));
      if (signal?.aborted) throw createAbortError();
    }
  }
  const msg = {
    type: 'process',
    requestId,
    channelData: copies,
    sampleRate,
    modelIds,
    processingConfig: options.processingConfig || null,
  };

  return new Promise((resolve, reject) => {
    _activeRequestId = requestId;
    let lastProgressAt = Date.now();
    let settled = false;
    let cancelPosted = false;
    let cancelGraceTimer = null;
    const timer = setTimeout(() => {
      finish(() => {
        resetStemSeparation();
        reject(new Error('[VIP][StemSeparation] processing timeout'));
      });
    }, PROCESS_TIMEOUT_MS);
    // Fail fast when the worker goes silent mid-job (common "stuck at ~55%" UX).
    const stallWatch = setInterval(() => {
      if (Date.now() - lastProgressAt < PROGRESS_STALL_MS) return;
      finish(() => {
        resetStemSeparation();
        reject(new Error('[VIP][StemSeparation] processing stalled (no progress)'));
      });
    }, 5000);
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const abortError = createAbortError;
    const postCancel = () => {
      if (cancelPosted || settled) return;
      cancelPosted = true;
      try {
        w.postMessage({ type: 'cancel', requestId });
      } catch { /* worker may already be gone */ }
    };
    const onAbort = () => {
      postCancel();
      // Do not wait forever for a cancelled ack — settle cleanly if silent.
      if (cancelGraceTimer != null) return;
      cancelGraceTimer = setTimeout(() => {
        cancelGraceTimer = null;
        if (settled) return;
        finish(() => {
          resetStemSeparation();
          reject(abortError());
        });
      }, 1500);
    };
    const onMsg = (ev) => {
      const m = ev?.data;
      // Ignore stale messages from a prior/cancelled requestId.
      if (!m || typeof m !== 'object' || m.requestId !== requestId) return;
      if (m.type === 'progress' || m.type === 'stage') {
        lastProgressAt = Date.now();
        try { onProgress?.(m); } catch { /* UI callbacks must not strand worker settlement */ }
      } else if (m.type === 'stems') {
        // Late stems after user cancel must not become a false "complete" output.
        if (signal?.aborted || cancelPosted) {
          finish(() => reject(abortError()));
          return;
        }
        finish(() => {
          const out = {
            clean: m.clean,
            noise: m.noise,
            sampleRate: m.sampleRate,
            passthrough: Boolean(m.passthrough),
            pipelineMode: m.pipelineMode || null,
            backend: m.backend || null,
            appliedProcessingConfigRevision: m.appliedProcessingConfigRevision || null,
          };
          if (!out.passthrough) setCachedStems(cacheKey, out);
          resolve(out);
        });
      } else if (m.type === 'cancelled') {
        finish(() => reject(abortError()));
      } else if (m.type === 'error') {
        finish(() => reject(new Error(m.message || 'Separation failed')));
      }
    };
    const onErr = (e) => {
      const error = new Error(e?.message || 'MLWorker error');
      finish(() => {
        recycleWorker(w, error);
        reject(error);
      });
    };
    const onMessageError = (e) => {
      const error = new Error(
        e?.message || '[VIP][StemSeparation] worker messageerror (deserialize failed)',
      );
      finish(() => {
        recycleWorker(w, error);
        reject(error);
      });
    };
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(stallWatch);
      if (cancelGraceTimer != null) {
        clearTimeout(cancelGraceTimer);
        cancelGraceTimer = null;
      }
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      w.removeEventListener('messageerror', onMessageError);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      if (_activeRequestId === requestId) {
        _activeRequestId = null;
        _activeCancel = null;
      }
    };
    _activeCancel = onAbort;
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.addEventListener('messageerror', onMessageError);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      w.postMessage(msg, copies.map((c) => c.buffer));
    } catch (error) {
      finish(() => {
        recycleWorker(w, error);
        reject(error);
      });
    }
  });
}

/** Ask the active ML job to cancel (terminal `cancelled` or host AbortError). */
export function cancelStemSeparation(requestId = _activeRequestId) {
  if (typeof _activeCancel === 'function'
    && (requestId == null || requestId === _activeRequestId)) {
    _activeCancel();
    return true;
  }
  if (!_worker || requestId == null) return false;
  try {
    _worker.postMessage({ type: 'cancel', requestId });
    return true;
  } catch {
    return false;
  }
}

/** Build an AudioBuffer from separated mono/stereo clean stem. */
export function stemsToAudioBuffer(ctx, clean, sampleRate) {
  const nCh = clean.length;
  const len = clean[0].length;
  const buf = ctx.createBuffer(nCh, len, sampleRate);
  for (let ch = 0; ch < nCh; ch++) buf.copyToChannel(clean[ch], ch);
  return buf;
}

/**
 * Recycle the ML worker after stall/timeout.
 * Does NOT clear MLStemCache — successful stem results must survive worker death
 * so reprocess can hit cache instead of re-burning ONNX.
 */
export function resetStemSeparation() {
  recycleWorker(_worker, new Error('[VIP][StemSeparation] MLWorker reset'));
  // Intentionally keep in-memory stem cache across worker recycle (audit P-03).
}

export { clearStemCache };

export default {
  ensureReady,
  warmupModels,
  separateStems,
  stemsToAudioBuffer,
  resetStemSeparation,
  cancelStemSeparation,
  clearStemCache,
};
