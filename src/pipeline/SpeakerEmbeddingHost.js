/**
 * VoiceIsolate Pro — optional ECAPA speaker-embedding host (Layer 3)
 *
 * Spawns SpeakerEmbeddingWorker with the ecapa_tdnn entry from ModelManifest.
 * `ready()` resolves false (never throws) when the model is not installed,
 * fails its SHA-256 pin, or the worker cannot start, so callers fall back to
 * the local mel voiceprint. Every request carries a timeout.
 */
'use strict';

import { MODEL_MANIFEST } from '../core/ModelManifest.js';

const INIT_TIMEOUT_MS = 30_000;
/** Single-thread WASM scores ~90 ms of compute per second of audio; leave headroom. */
const requestTimeoutMs = (samples, sampleRate) => 30_000 + Math.ceil((samples.length / sampleRate) * 500);

/**
 * @param {{ entry?: object, workerUrl?: string, createWorker?: (url: string) => Worker }} [opts]
 */
export function createSpeakerEmbeddingHost(opts = {}) {
  const entry = opts.entry || MODEL_MANIFEST.ecapa_tdnn;
  const workerUrl = opts.workerUrl || '/src/workers/SpeakerEmbeddingWorker.js';
  const createWorker = opts.createWorker || ((url) => new Worker(url));
  let worker = null;
  let readyPromise = null;
  let unavailableReason = null;
  let seq = 0;
  const pending = new Map();

  function fail(reason) {
    unavailableReason = reason;
    for (const p of pending.values()) p.reject(new Error(reason));
    pending.clear();
  }

  function ready() {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve) => {
      try {
        worker = createWorker(workerUrl);
      } catch (err) {
        unavailableReason = `worker unavailable: ${err?.message || err}`;
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        unavailableReason = 'ECAPA init timed out';
        worker?.terminate?.();
        worker = null;
        resolve(false);
      }, INIT_TIMEOUT_MS);
      worker.onerror = (e) => {
        clearTimeout(timer);
        fail(`ECAPA worker error: ${e?.message || 'unknown'}`);
        resolve(false);
      };
      worker.onmessage = (event) => {
        const m = event.data || {};
        if (m.type === 'ready') { clearTimeout(timer); resolve(true); return; }
        if (m.type === 'unavailable') { clearTimeout(timer); unavailableReason = m.reason; resolve(false); return; }
        const p = pending.get(m.requestId);
        if (!p) return;
        if (m.type === 'progress') { p.onProgress?.(m.done, m.total); return; }
        clearTimeout(p.timer);
        pending.delete(m.requestId);
        if (m.type === 'error') p.reject(new Error(`[VIP] ECAPA: ${m.message}`));
        else p.resolve(m);
      };
      worker.postMessage({ type: 'init', entry });
    });
    return readyPromise;
  }

  async function request(type, samples, sampleRate, extra = {}, onProgress) {
    if (!(await ready())) throw new Error(`[VIP] ECAPA unavailable: ${unavailableReason}`);
    const requestId = `spk-${++seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`[VIP] ECAPA ${type} timed out`));
      }, requestTimeoutMs(samples, sampleRate));
      pending.set(requestId, { resolve, reject, timer, onProgress });
      // Copy: callers keep their (possibly shared, read-only) PCM.
      const copy = new Float32Array(samples);
      worker.postMessage({ type, requestId, samples: copy, sampleRate, ...extra }, [copy.buffer]);
    });
  }

  return {
    ready,
    get unavailableReason() { return unavailableReason; },
    /** Unit-length embedding for an enrollment segment. */
    async embed(samples, sampleRate) {
      return (await request('embed', samples, sampleRate)).embedding;
    },
    /** Cosine similarity of each [start, end) window (input samples) to `target`. */
    async scoreWindows(samples, sampleRate, target, windows, onProgress) {
      return (await request('score', samples, sampleRate, { target: Array.from(target), windows }, onProgress)).sims;
    },
    /** Mean unit embedding per diarization speaker. */
    async clusterEmbeddings(samples, sampleRate, segments, onProgress) {
      return (await request('cluster', samples, sampleRate, { segments }, onProgress)).clusters;
    },
    dispose() {
      fail('disposed');
      readyPromise = Promise.resolve(false);
      worker?.terminate?.();
      worker = null;
    },
  };
}

export default { createSpeakerEmbeddingHost };
