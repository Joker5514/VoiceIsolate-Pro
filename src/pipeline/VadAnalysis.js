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
      reject(new Error('[VIP][VadAnalysis] MLWorker init timeout'));
    }, 20000);
    const onMsg = (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'ready') { cleanup(); resolve(msg.backend || 'wasm'); }
      else if (msg.type === 'error' && !msg.requestId) {
        cleanup();
        reject(new Error(msg.message || 'MLWorker init failed'));
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
    initMLWorker(w);
  }).catch((err) => {
    _ready = null;
    throw err;
  });
  return _ready;
}

/**
 * Run Silero VAD on mono samples.
 * @returns {Promise<{ scores: Float32Array, times: Float32Array, hopSec: number, source: string }|null>}
 */
export async function runSileroVad(samples, sampleRate, opts = {}) {
  try {
    await ensureReady();
  } catch {
    return null;
  }
  const w = getWorker();
  const requestId = ++_seq;
  const copy = samples instanceof Float32Array ? samples.slice() : new Float32Array(samples);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, opts.timeoutMs ?? 60000);
    const onMsg = (ev) => {
      const m = ev.data || {};
      if (m.requestId !== requestId) return;
      if (m.type === 'vad-result') {
        cleanup();
        resolve({
          scores: m.scores instanceof Float32Array ? m.scores : new Float32Array(m.scores || []),
          times: m.times instanceof Float32Array ? m.times : new Float32Array(m.times || []),
          hopSec: m.hopSec || 0.032,
          source: m.source || 'silero',
        });
      } else if (m.type === 'error') {
        cleanup();
        resolve(null);
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
    };
    w.addEventListener('message', onMsg);
    w.postMessage({ type: 'vad', requestId, samples: copy, sampleRate }, [copy.buffer]);
  });
}

/**
 * Build mlHints for analyzeAudio from extraction + optional Silero.
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {object} extraction
 */
export async function buildVadHints(mono, sampleRate, extraction) {
  const classical = softVadFromExtraction(extraction);
  let mlAligned = null;
  let source = 'classical';
  try {
    const ml = await runSileroVad(mono, sampleRate);
    if (ml && ml.scores.length && ml.source === 'silero') {
      const frameTimes = (extraction.frames || []).map((f) => f.t);
      mlAligned = alignVadToFrames(ml.times, ml.scores, frameTimes);
      source = 'silero+classical';
    }
  } catch {
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
