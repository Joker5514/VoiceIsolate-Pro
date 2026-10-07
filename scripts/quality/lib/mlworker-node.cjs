'use strict';
/**
 * Runs the production MLWorker.js source in a Node vm sandbox with the real
 * vendored onnxruntime-web (WASM, single thread) and the shipped ONNX models.
 *
 * Nothing in the worker is reimplemented here: the sandbox only supplies the
 * browser globals the classic worker expects (importScripts, fetch, self).
 * Model bytes are served from public/app/models and still pass the worker's
 * own SHA-256 check against ModelManifest.js.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { webcrypto } = require('crypto');

const ROOT = path.resolve(__dirname, '../../..');

async function loadManifest() {
  const mod = await import(path.join(ROOT, 'src/core/ModelManifest.js'));
  const m = mod.MODEL_MANIFEST || mod.default || mod;
  return Object.values(m).filter((e) => e && typeof e === 'object' && e.id);
}

function createSandbox(ort) {
  const messages = [];
  const listeners = new Set();
  const self = {
    navigator: { hardwareConcurrency: 1, userAgent: 'node-quality-harness X11' },
    crossOriginIsolated: false, // forces ort numThreads = 1 → deterministic
    crypto: webcrypto,
    postMessage(msg) {
      messages.push(msg);
      for (const fn of listeners) fn(msg);
    },
  };
  // init writes wasmPaths='/lib/' for the browser; keep Node's own resolution.
  const wasmEnv = ort.env.wasm;
  const ortProxy = new Proxy(ort, {
    get(target, key) {
      if (key === 'env') {
        return new Proxy(target.env, {
          get(t, k) {
            if (k === 'wasm') {
              return new Proxy(wasmEnv, {
                set(w, prop, value) {
                  if (prop === 'wasmPaths') return true;
                  w[prop] = value;
                  return true;
                },
              });
            }
            return t[k];
          },
        });
      }
      return target[key];
    },
  });
  const sandbox = {
    self,
    ort: ortProxy,
    console: { log() {}, info() {}, warn() {}, error: console.error, debug() {} },
    crypto: webcrypto,
    performance,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    Promise, Error, TypeError, Object, Array, Set, Map, WeakMap, Symbol, Math, Number, String, Boolean, JSON, Date, Proxy, Reflect,
    ArrayBuffer, SharedArrayBuffer: undefined, Atomics: undefined, DataView,
    Float32Array, Float64Array, Uint8Array, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array,
    TextEncoder, TextDecoder,
    async fetch(url) {
      const rel = String(url).replace(/^\//, '');
      const file = path.join(ROOT, 'public', rel);
      if (!fs.existsSync(file)) return { ok: false, status: 404 };
      const buf = fs.readFileSync(file);
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    },
    importScripts(...urls) {
      for (const u of urls) {
        if (/ort(\.min)?\.js$/.test(u)) continue; // real ort injected above
        const file = path.join(ROOT, String(u).replace(/^\//, ''));
        vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
      }
    },
  };
  return { sandbox, self, messages, listeners };
}

/**
 * @returns {Promise<{ separate: Function, close: Function, backend: string }>}
 */
async function createMlWorker({ patchSource } = {}) {
  const ort = require(path.join(ROOT, 'node_modules/onnxruntime-web'));
  ort.env.wasm.numThreads = 1;
  const manifest = await loadManifest();
  const { sandbox, self, listeners } = createSandbox(ort);
  vm.createContext(sandbox);
  const src = path.join(ROOT, 'src/workers/MLWorker.js');
  let code = fs.readFileSync(src, 'utf8');
  if (patchSource) code = patchSource(code);
  vm.runInContext(code, sandbox, { filename: src });

  const waitFor = (pred) => new Promise((resolve) => {
    const fn = (m) => { if (pred(m)) { listeners.delete(fn); resolve(m); } };
    listeners.add(fn);
  });

  const ready = waitFor((m) => m.type === 'ready');
  await self.onmessage({ data: { type: 'init', manifest } });
  const { backend } = await ready;

  let seq = 0;
  /**
   * @param {Float32Array[]} channelData
   * @param {{ modelIds?: string[], processingConfig?: object, sampleRate?: number }} opts
   */
  async function separate(channelData, opts = {}) {
    const requestId = `q-${++seq}`;
    const done = waitFor((m) => m.requestId === requestId && (m.type === 'stems' || m.type === 'error'));
    const t0 = performance.now();
    // Copy: the real host transfers, the harness keeps the reference intact.
    void self.onmessage({ data: {
      type: 'process',
      requestId,
      modelIds: opts.modelIds || ['bsrnn_vocals'],
      channelData: channelData.map((c) => new Float32Array(c)),
      sampleRate: opts.sampleRate || 48000,
      processingConfig: opts.processingConfig || null,
    } });
    const msg = await done;
    if (msg.type === 'error') throw new Error(msg.message);
    return { ...msg, elapsedMs: performance.now() - t0 };
  }

  return { separate, backend, manifest };
}

module.exports = { createMlWorker, ROOT };
