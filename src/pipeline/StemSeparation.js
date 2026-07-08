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

function getWorker() {
  if (_worker) return _worker;
  _worker = createMLWorker();
  return _worker;
}

function ensureReady() {
  if (_ready) return _ready;
  const w = getWorker();
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
  getWorker().postMessage({ type: 'warmup', modelIds });
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
  const copies = channelData.map((c) => c.slice());
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
  clearStemCache();
}

export { clearStemCache };

export default { ensureReady, warmupModels, separateStems, stemsToAudioBuffer, resetStemSeparation, clearStemCache };