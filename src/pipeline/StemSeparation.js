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
}

function ensureReady() {
  if (_ready) return _ready;
  const w = getWorker();
  hookWarmupListener(w);
  _ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('[VIP][StemSeparation] MLWorker init timeout'));
    }, 30000);
    const onMsg = (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'ready') {
        cleanup();
        w.postMessage({ type: 'warmup', modelIds: [...DEFAULT_ML_MODEL_IDS] });
        resolve(msg.backend || 'wasm');
      } else if (msg.type === 'error') { cleanup(); reject(new Error(msg.message || 'MLWorker init failed')); }
    };
    const onErr = (e) => { cleanup(); reject(new Error(e.message || 'MLWorker error')); };
    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    initMLWorker(w);
  });
  return _ready;
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
    w.postMessage({ type: 'warmup', modelIds: missing });
  });
}

export async function separateStems(channelData, sampleRate, options = {}) {
  const modelIds = options.modelIds?.length
    ? options.modelIds
    : options.modelId
      ? [options.modelId]
      : [...DEFAULT_ML_MODEL_IDS];
  const cacheKey = stemCacheKey(channelData, sampleRate, modelIds, options.sourceName);
  const cached = getCachedStems(cacheKey);
  if (cached) {
    options.onProgress?.({ type: 'stage', stage: 'separate', percent: 100, label: 'Using cached stems…' });
    return {
      clean: cached.clean.map((c) => new Float32Array(c)),
      noise: cached.noise.map((c) => new Float32Array(c)),
      sampleRate: cached.sampleRate,
      passthrough: cached.passthrough,
      fromCache: true,
    };
  }

  await ensureReady();
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
    }
  }
  const msg = { type: 'process', requestId, channelData: copies, sampleRate, modelIds };

  return new Promise((resolve, reject) => {
    let lastProgressAt = Date.now();
    const timer = setTimeout(() => {
      cleanup();
      resetStemSeparation();
      reject(new Error('[VIP][StemSeparation] processing timeout'));
    }, PROCESS_TIMEOUT_MS);
    // Fail fast when the worker goes silent mid-job (common "stuck at ~55%" UX).
    const stallWatch = setInterval(() => {
      if (Date.now() - lastProgressAt < PROGRESS_STALL_MS) return;
      cleanup();
      resetStemSeparation();
      reject(new Error('[VIP][StemSeparation] processing stalled (no progress)'));
    }, 5000);
    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.requestId !== requestId) return;
      if (m.type === 'progress' || m.type === 'stage') {
        lastProgressAt = Date.now();
        onProgress?.(m);
      } else if (m.type === 'stems') {
        cleanup();
        const out = {
          clean: m.clean,
          noise: m.noise,
          sampleRate: m.sampleRate,
          passthrough: Boolean(m.passthrough),
        };
        if (!out.passthrough) setCachedStems(cacheKey, out);
        resolve(out);
      } else if (m.type === 'error') {
        cleanup();
        reject(new Error(m.message || 'Separation failed'));
      }
    };
    const onErr = (e) => { cleanup(); reject(new Error(e.message || 'MLWorker error')); };
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(stallWatch);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage(msg, copies.map((c) => c.buffer));
  });
}

/** Build an AudioBuffer from separated mono/stereo clean stem. */
export function stemsToAudioBuffer(ctx, clean, sampleRate) {
  const nCh = clean.length;
  const len = clean[0].length;
  const buf = ctx.createBuffer(nCh, len, sampleRate);
  for (let ch = 0; ch < nCh; ch++) buf.copyToChannel(clean[ch], ch);
  return buf;
}

export function resetStemSeparation() {
  if (_worker) {
    _worker.terminate();
    _worker = null;
  }
  _ready = null;
  _warmupHooked = false;
  _warmedModels.clear();
  _warmupWaiters = [];
  clearStemCache();
}

export { clearStemCache };

export default { ensureReady, warmupModels, separateStems, stemsToAudioBuffer, resetStemSeparation, clearStemCache };