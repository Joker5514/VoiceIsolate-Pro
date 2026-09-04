/**
 * VoiceIsolate Pro — VAD analysis bridge (Layer 3: Pipeline)
 *
 * Runs Silero VAD via MLWorker when available; returns soft scores for
 * FullAnalysis. Falls back to classical SoftVad (caller-side).
 */
'use strict';

import { createMLWorker, initMLWorker } from './MLWorkerHost.js';
import { softVadFromExtraction, alignVadToFrames, blendVadScores } from '../core/SoftVad.js';

let _worker = null;
let _ready = null;
let _rejectReady = null;
let _seq = 0;
const _pendingRequests = new Map();

function createAbortError() {
  return typeof DOMException !== 'undefined'
    ? new DOMException('VAD cancelled', 'AbortError')
    : Object.assign(new Error('VAD cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function recycleWorker(worker = _worker, error = new Error('[VIP][VadAnalysis] MLWorker reset')) {
  if (!worker || _worker !== worker) return;
  const pending = [..._pendingRequests.entries()];
  for (const [requestId, request] of pending) {
    if (request.worker !== worker) continue;
    _pendingRequests.delete(requestId);
    try { request.reject(error); } catch { /* request already settled */ }
  }
  try { worker.terminate(); } catch { /* worker already stopped */ }
  _worker = null;
  _ready = null;
  _rejectReady = null;
}

function getWorker() {
  if (_worker) return _worker;
  _worker = createMLWorker();
  return _worker;
}

function ensureReady(signal) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  if (_ready) {
    if (!signal) return _ready;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const error = createAbortError();
        _rejectReady?.(error);
        recycleWorker(_worker);
        reject(error);
      };
      signal.addEventListener?.('abort', onAbort, { once: true });
      _ready.then(resolve, reject).finally(() => {
        signal.removeEventListener?.('abort', onAbort);
      });
    });
  }
  const w = getWorker();
  const pending = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      _rejectReady = null;
      callback();
    };
    const fail = (error) => finish(() => {
      recycleWorker(w);
      reject(error);
    });
    const timer = setTimeout(() => {
      fail(new Error('[VIP][VadAnalysis] MLWorker init timeout'));
    }, 20000);
    const onMsg = (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'ready') finish(() => resolve(msg.backend || 'wasm'));
      else if (msg.type === 'error' && !msg.requestId) {
        fail(new Error(msg.message || 'MLWorker init failed'));
      }
    };
    const onErr = (e) => fail(new Error(e.message || 'MLWorker error'));
    const onMessageError = () => fail(new Error('[VIP][VadAnalysis] MLWorker message could not be deserialized'));
    const onAbort = () => fail(createAbortError());
    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      w.removeEventListener('messageerror', onMessageError);
      signal?.removeEventListener?.('abort', onAbort);
    };
    _rejectReady = fail;
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.addEventListener('messageerror', onMessageError);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      initMLWorker(w);
    } catch (error) {
      fail(error);
    }
  });
  const tracked = pending.catch((error) => {
    if (_ready === tracked) _ready = null;
    throw error;
  });
  _ready = tracked;
  return tracked;
}

/**
 * Run Silero VAD on mono samples.
 * @returns {Promise<{ scores: Float32Array, times: Float32Array, hopSec: number, source: string }|null>}
 */
export async function runSileroVad(samples, sampleRate, opts = {}) {
  const signal = opts.signal || null;
  try {
    await ensureReady(signal);
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    return null;
  }
  if (signal?.aborted) throw createAbortError();
  const w = getWorker();
  const requestId = ++_seq;
  const copy = samples instanceof Float32Array ? samples.slice() : new Float32Array(samples);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const timer = setTimeout(() => {
      finish(() => {
        recycleWorker(w);
        resolve(null);
      });
    }, opts.timeoutMs ?? 60000);
    const onAbort = () => {
      try { w.postMessage({ type: 'cancel', requestId }); } catch { /* worker may be gone */ }
      finish(() => {
        recycleWorker(w);
        reject(createAbortError());
      });
    };
    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.requestId !== requestId) return;
      if (m.type === 'vad-result') {
        finish(() => resolve({
          scores: m.scores instanceof Float32Array ? m.scores : new Float32Array(m.scores || []),
          times: m.times instanceof Float32Array ? m.times : new Float32Array(m.times || []),
          hopSec: m.hopSec || 0.032,
          source: m.source || 'silero',
        }));
      } else if (m.type === 'error') {
        finish(() => resolve(null));
      }
    };
    const onError = () => finish(() => {
      recycleWorker(w);
      resolve(null);
    });
    const onMessageError = onError;
    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onError);
      w.removeEventListener('messageerror', onMessageError);
      signal?.removeEventListener?.('abort', onAbort);
      if (_pendingRequests.get(requestId)?.reject === rejectForRecycle) {
        _pendingRequests.delete(requestId);
      }
    };
    const rejectForRecycle = (error) => finish(() => reject(error));
    _pendingRequests.set(requestId, { worker: w, reject: rejectForRecycle });
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onError);
    w.addEventListener('messageerror', onMessageError);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      w.postMessage({ type: 'vad', requestId, samples: copy, sampleRate }, [copy.buffer]);
    } catch {
      onError();
    }
  });
}

/**
 * Build mlHints for analyzeAudio from extraction + optional Silero.
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {object} extraction
 */
export async function buildVadHints(mono, sampleRate, extraction, opts = {}) {
  if (opts.signal?.aborted) throw createAbortError();
  const classical = softVadFromExtraction(extraction);
  let mlAligned = null;
  let source = 'classical';
  try {
    const ml = await runSileroVad(mono, sampleRate, opts);
    if (opts.signal?.aborted) throw createAbortError();
    if (ml && ml.scores.length && ml.source === 'silero') {
      const frameTimes = (extraction.frames || []).map((f) => f.t);
      mlAligned = alignVadToFrames(ml.times, ml.scores, frameTimes);
      source = 'silero+classical';
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    // classical only
  }
  const scores = blendVadScores(classical.scores, mlAligned, mlAligned ? 0.72 : 0);
  const threshold = classical.threshold;
  const active = Array.from(scores, (s) => s >= threshold);
  return {
    vadScores: scores,
    vadActive: active,
    vadSource: source,
    vadThreshold: threshold,
  };
}

export default { runSileroVad, buildVadHints };
