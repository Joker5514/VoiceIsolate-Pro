/**
 * VoiceIsolate Pro — source hash host (Layer 3: Pipeline)
 *
 * VIP-011: hash the ORIGINAL source file (raw bytes — not decoded PCM) with
 * security-grade SHA-256. Runs in SourceHashWorker when workers exist; falls
 * back to cooperative main-thread streaming (Node/tests or blocked workers).
 *
 * The result feeds the forensic integrity record (Provenance.js sidecar and
 * the Forensic verification action). This is separate from the cache identity
 * (content-hash.js MurmurHash3 — explicitly not a security hash).
 */
'use strict';

import { hashBlobSha256 } from '../core/sha256.js';

export class HashAbortError extends Error {
  constructor() {
    super('[VIP][SourceHash] Hashing cancelled');
    this.name = 'AbortError';
    this.code = 'CANCELLED';
  }
}

function workerHash(blob, { signal, onProgress }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new HashAbortError()); return; }
    let worker;
    try {
      worker = new Worker('/src/workers/SourceHashWorker.js', { type: 'module', name: 'vip-source-hash' });
    } catch (err) {
      // Worker construction failed — caller falls back (handled by hashSourceBlob).
      reject(err);
      return;
    }
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      try { worker.terminate(); } catch { /* already terminated */ }
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new HashAbortError());
    // 120 s budget covers multi-GB files on slow devices; the fallback path
    // has no such ceiling because it yields cooperatively per chunk.
    const timer = setTimeout(() => finish(new Error('[VIP][SourceHash] Hashing timed out')), 120_000);
    signal?.addEventListener?.('abort', abort, { once: true });
    worker.onerror = (event) => finish(new Error(event?.message || '[VIP][SourceHash] worker failed'));
    worker.onmessage = ({ data }) => {
      if (!data || typeof data !== 'object') return;
      if (data.type === 'progress') {
        if (onProgress) {
          try { onProgress(data.done, data.total); } catch { /* advisory */ }
        }
        return;
      }
      if (data.type === 'done') finish(null, { hex: data.hex, bytes: data.bytes });
      else if (data.type === 'error') {
        finish(Object.assign(new Error(data.message || 'hash failed'), { name: data.name || 'Error' }));
      }
    };
    try {
      // Blob is cloned by reference into the worker — no full-size copy.
      worker.postMessage({ type: 'hash', requestId: 1, blob });
    } catch (err) {
      finish(err);
    }
  });
}

/**
 * @param {Blob} blob original source file bytes
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {(done:number,total:number)=>void} [opts.onProgress]
 * @returns {Promise<{hex: string, bytes: number, via: 'worker'|'main'}>}
 */
export async function hashSourceBlob(blob, opts = {}) {
  const { signal = null, onProgress = null } = opts;
  if (signal?.aborted) throw new HashAbortError();
  if (typeof Worker !== 'undefined') {
    try {
      const result = await workerHash(blob, { signal, onProgress });
      return { ...result, via: 'worker' };
    } catch (err) {
      if (err instanceof HashAbortError || err?.name === 'AbortError') throw err;
      // Worker unavailable/broken → cooperative fallback (never fails the
      // export just because the off-thread path is missing).
      console.warn('[VIP][SourceHash] worker path failed, hashing on main thread:', err?.message || err);
    }
  }
  const result = await hashBlobSha256(blob, {
    signal,
    onProgress,
    maybeYield: null,
  });
  return { ...result, via: 'main' };
}

export default { hashSourceBlob, HashAbortError };
