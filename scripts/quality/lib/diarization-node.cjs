'use strict';

/**
 * Runs the product diarization path (public/app/ml-worker.js, 'diarize'
 * message → runDiarization: 200 ms windows, 100 ms hop, 3-dim frame
 * features [RMS, zero-crossing rate, flatness], k-means with k forced
 * to 2–4 by duration) in a vm sandbox with browser-like globals.
 *
 * The diarize path is pure JS (no ONNX): ort stays null because the
 * worker loads it lazily inside initialize(), which this harness never
 * calls. importScripts is stubbed to throw — the worker's loader
 * catches that gracefully (see its header comment).
 *
 * This harness exists so VIP-031 can measure the real shipped
 * diarization on the corpus and on fixtures with known turn
 * boundaries, instead of reimplementing the clustering in the test
 * (a reimplementation would measure itself, not the product).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '../../..');

function createDiarizationWorker() {
  const posted = [];
  const sandbox = {
    console,
    Math, Promise, Error, Object, Array, Map, Set, JSON, Number, String, Boolean,
    Float32Array, Float64Array, Uint8Array, Uint16Array, Int16Array, ArrayBuffer,
    setTimeout, clearTimeout,
    performance: { now: () => Date.now() },
    postMessage: (m) => posted.push(m),
    importScripts: () => { throw new Error('importScripts unavailable in Node harness'); },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/app/ml-worker.js'), 'utf8'), sandbox);
  /** @returns {Promise<{segments: Array, duration: number, speakerCount: number}>} */
  const diarize = async (pcm, sampleRate = 48000) => {
    const before = posted.length;
    await sandbox.onmessage({ data: { type: 'diarize', payload: { signal: pcm, sampleRate } } });
    const replies = posted.slice(before);
    const result = replies.find((m) => m.type === 'diarization');
    if (!result) {
      const err = replies.find((m) => m.type === 'error');
      throw new Error(`diarize produced no result${err ? `: ${err.msg}` : ` (replies: ${replies.map((r) => r.type).join(',') || 'none'})`}`);
    }
    return result;
  };
  return { diarize };
}

module.exports = { createDiarizationWorker, ROOT };
