'use strict';
/**
 * Runs src/workers/SpeakerEmbeddingWorker.js (a classic worker) in a vm
 * sandbox with browser-like globals. `ort` is injected: pass a stub, or
 * realOrt() for the vendored onnxruntime-web under Node.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '../../..');

function realOrt() {
  const ort = require(path.join(ROOT, 'node_modules/onnxruntime-web'));
  ort.env.wasm.numThreads = 1;
  // The worker sets the browser's wasmPaths ('/lib/'); keep Node's own resolution.
  const wasm = new Proxy(ort.env.wasm, { set: (t, k, v) => (k === 'wasmPaths' ? true : Reflect.set(t, k, v)) });
  return { ...ort, env: { ...ort.env, wasm }, Tensor: ort.Tensor, InferenceSession: ort.InferenceSession };
}

/** Pinned ecapa_tdnn entry, read from ModelManifest.js without ESM. */
function ecapaEntry() {
  const src = fs.readFileSync(path.join(ROOT, 'src/core/ModelManifest.js'), 'utf8');
  const block = src.slice(src.indexOf('ecapa_tdnn: Object.freeze('));
  return {
    url: /url: '([^']+)'/.exec(block)[1],
    sha256: /sha256: '([0-9a-f]{64})'/.exec(block)[1],
    io: {
      input: /input: '([^']+)'/.exec(block)[1],
      output: /output: '([^']+)'/.exec(block)[1],
    },
    embeddingDims: Number(/embeddingDims: (\d+)/.exec(block)[1]),
  };
}

function createSpeakerWorker(ort) {
  const posted = [];
  const fetched = [];
  const sandbox = {
    console, crypto: crypto.webcrypto, Math, Promise, Error, Object, Array, Map, Set, JSON, Number, String, Boolean,
    Float32Array, Float64Array, Uint8Array, Uint16Array, Int16Array, ArrayBuffer,
    crossOriginIsolated: false,
    ort,
    postMessage: (m) => posted.push(m),
    async fetch(url) {
      fetched.push(String(url));
      const file = path.join(ROOT, 'public', String(url).replace(/^\//, ''));
      if (!fs.existsSync(file)) return { ok: false, status: 404 };
      const buf = fs.readFileSync(file);
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    },
    importScripts(...urls) {
      for (const u of urls) {
        if (/ort(\.min)?\.js$/.test(u)) continue; // injected above
        vm.runInContext(fs.readFileSync(path.join(ROOT, u.replace(/^\//, '')), 'utf8'), sandbox);
      }
    },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/workers/SpeakerEmbeddingWorker.js'), 'utf8'), sandbox);
  /** Send one message; resolves with everything the worker posted in reply. */
  const send = async (data) => {
    const before = posted.length;
    await sandbox.onmessage({ data });
    return posted.slice(before);
  };
  return { send, posted, fetched };
}

module.exports = { createSpeakerWorker, realOrt, ecapaEntry, ROOT };
