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

let _worker = null;
let _ready = null;
let _seq = 0;
/** @type {Set<string>} */
const _warmedModels = new Set();
/** @type {Array<{ resolve: Function, reject: Function, timer: *, ids: string[] }>} */
let _warmupWaiters = [];
let _warmupHooked = false;

const WARMUP_TIMEOUT_MS = 120000;
const COPY_CHUNK_SAMPLES = 48000 * 2; // ~2 s @ 48 kHz — yield between chunks to keep UI alive

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
      else {
        // Partial warmup — wait for a later warmed message.
        _warmupWaiters.push(waiter);
      }
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

/** Yield-friendly typed-array copy so large files don't freeze the main thread. */
async function copyChannelChunked(src) {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += COPY_CHUNK_SAMPLES) {
    const end = Math.min(src.length, i + COPY_CHUNK_SAMPLES);
    out.set(src.subarray(i, end), i);
    if (end < src.length) await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}

/**
 * Run offline inference on decoded channel data.
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @param {{ modelIds?: string[], modelId?: string, onProgress?: (event: object) => void }} options
 * @returns {Promise<{ clean: Float32Array[], noise: Float32Array[], sampleRate: number, passthrough: boolean }>}
 */
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
  // Transferable copies — originals stay intact for cache keys / reprocess.
  const copies = [];
  for (let ch = 0; ch < channelData.length; ch++) {
    copies.push(await copyChannelChunked(channelData[ch]));
  }
  const msg = { type: 'process', requestId, channelData: copies, sampleRate, modelIds };

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('[VIP][StemSeparation] processing timeout'));
    }, 600000);
    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.requestId !== requestId) return;
      if (m.type === 'progress' || m.type === 'stage') {
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
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
    };
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage(msg, copies.map((c) => c.buffer));
  });
}

/** Build an AudioBuffer from separated mono/stereo clean stem. */
export async function stemsToAudioBuffer(ctx, clean, sampleRate) {
  const nCh = clean.length;
  const len = clean[0].length;
  const buf = ctx.createBuffer(nCh, len, sampleRate);
  for (let ch = 0; ch < nCh; ch++) {
    const data = clean[ch];
    const dst = buf.getChannelData(ch);
    for (let i = 0; i < len; i += COPY_CHUNK_SAMPLES) {
      const end = Math.min(len, i + COPY_CHUNK_SAMPLES);
      dst.set(data.subarray(i, end), i);
      if (end < len) await new Promise((r) => setTimeout(r, 0));
    }
  }
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