/**
 * VoiceIsolate Pro — one-shot USM worker client (Layer 3: Pipeline)
 *
 * Runs classical separateUniversal in a dedicated module worker
 * (src/workers/USMWorker.js) for callers that must never compute on the main
 * thread, such as prompted isolation. Each call owns its worker and terminates
 * it when the job settles, is aborted or times out: the STFT/NMF pass is
 * synchronous inside the worker, so terminate() is the only bounded cancel.
 */
'use strict';

const WORKER_PATH = '/src/workers/USMWorker.js';
const DEFAULT_TIMEOUT_MS = 180000;

function abortError() {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Separation cancelled', 'AbortError')
    : Object.assign(new Error('Separation cancelled'), { name: 'AbortError' });
}

/**
 * @param {Float32Array} samples mono PCM (copied; the caller's array is untouched)
 * @param {number} sampleRate
 * @param {object} config separateUniversal config
 * @param {{ signal?: AbortSignal|null, onProgress?: (percent: number, stage: string) => void, timeoutMs?: number }} [opts]
 * @returns {Promise<{ sources: Array<{ id: string, label: string, pcm: Float32Array, mask: Float32Array|null, confidence: number, quality: string, method: string }>, shape: { frames: number, bins: number }, method: string }>}
 */
export function separateUniversalInWorker(samples, sampleRate, config, opts = {}) {
  const { signal = null, onProgress = null, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  if (signal?.aborted) return Promise.reject(abortError());
  if (typeof Worker === 'undefined') {
    return Promise.reject(new Error('[VIP][USM] Web Workers are unavailable; separation will not run on the UI thread.'));
  }
  const url = new URL(WORKER_PATH, globalThis.location?.href || 'http://localhost/').href;
  const worker = new Worker(url, { type: 'module', name: 'vip-usm-oneshot' });
  const copy = new Float32Array(samples);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      worker.terminate();
      fn(value);
    };
    const onAbort = () => finish(reject, abortError());
    const timer = setTimeout(() => finish(reject, new Error('[VIP][USM] separation timed out')), timeoutMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.requestId !== 1) return;
      if (m.type === 'progress' || m.type === 'heartbeat') {
        try { onProgress?.(m.percent || 0, m.stage || 'usm'); } catch { /* UI callback */ }
      } else if (m.type === 'result') {
        finish(resolve, m.result);
      } else if (m.type === 'error') {
        finish(reject, new Error(m.message || '[VIP][USM] separation failed'));
      }
    };
    worker.onerror = (e) => finish(reject, new Error(e?.message || '[VIP][USM] worker failed'));
    worker.onmessageerror = () => finish(reject, new Error('[VIP][USM] worker result could not be deserialized'));
    worker.postMessage({ type: 'separate', requestId: 1, samples: copy, sampleRate, config }, [copy.buffer]);
  });
}

export default { separateUniversalInWorker };
