/**
 * Explicit optional-model resolution and legacy spectral calibration.
 *
 * Demucs may load only when requested and checksum-pinned.
 * bsrnn_complex has no pin and must be rejected before any fetch.
 * Shipped BSRNN / RNNoise heads use frame-max input and the manifest exponents.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const workerCode = fs.readFileSync(path.join(ROOT, 'public/app/ml-worker.js'), 'utf8');
const registryCode = fs.readFileSync(path.join(ROOT, 'public/app/model-registry.generated.js'), 'utf8');

function readRegistry() {
  const context = {};
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(registryCode, context);
  return context.VIPModelRegistry;
}

const REGISTRY = readRegistry();

function hashBuffer(hex) {
  return Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16)).buffer;
}

function bootWorker(ort, fetchImpl) {
  const posted = [];
  const fetched = [];
  const context = {
    console,
    navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' },
  };
  context.self = context;
  context.globalThis = context;
  context.postMessage = (msg) => { posted.push(msg); };
  context.importScripts = (url) => {
    if (String(url).endsWith('model-registry.generated.js')) {
      vm.runInContext(registryCode, context);
      return;
    }
    throw new Error('unexpected importScripts ' + url);
  };
  context.fetch = async (url) => {
    fetched.push(String(url));
    return fetchImpl(String(url));
  };
  context.crypto = {
    subtle: {
      digest: async (_alg, _data) => {
        const url = fetched[fetched.length - 1] || '';
        const entry = Object.values(REGISTRY.models).find((m) => url.endsWith(m.filename));
        return hashBuffer(entry && entry.sha256 ? entry.sha256 : '00'.repeat(32));
      },
    },
  };
  if (ort) context.ort = ort;
  vm.createContext(context);
  vm.runInContext(registryCode, context);
  vm.runInContext(workerCode, context);
  return {
    posted,
    fetched,
    send: (data) => context.onmessage({ data }),
  };
}

function okFetch() {
  return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
}

function missingFetch() {
  return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
}

function ortWith(run) {
  return {
    env: { wasm: {}, logLevel: 'warning' },
    Tensor: class Tensor {
      constructor(type, data, dims) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    },
    InferenceSession: { create: jest.fn(async () => ({ run })) },
  };
}

describe('resolveModelEntry via loadModel', () => {
  test('explicit demucs with a pin is fetched and can load', async () => {
    const ort = ortWith(async () => ({ output: { data: new Float32Array(1) } }));
    const worker = bootWorker(ort, async () => okFetch());
    await worker.send({ type: 'loadModel', models: ['demucs'] });
    expect(worker.fetched.some((url) => url.includes('demucs_v4_quantized.onnx'))).toBe(true);
    const ready = worker.posted.find((m) => m.type === 'ready');
    expect(ready.models.demucs).toBe(true);
    expect(worker.posted.some((m) => m.type === 'model_loaded' && m.modelId === 'demucs')).toBe(true);
    expect(worker.posted.some((m) => m.type === 'model_fallback' || (m.type === 'model_status' && m.status === 'unsupported'))).toBe(false);
  });

  test('missing demucs file is unavailable and is not reported as loaded', async () => {
    const ort = ortWith(async () => ({ output: { data: new Float32Array(1) } }));
    const worker = bootWorker(ort, async () => missingFetch());
    await worker.send({ type: 'loadModel', models: ['demucs'] });
    expect(worker.fetched.some((url) => url.includes('demucs_v4_quantized.onnx'))).toBe(true);
    const ready = worker.posted.find((m) => m.type === 'ready');
    expect(ready.models.demucs).toBe(false);
    const status = worker.posted.find((m) => m.type === 'model_status' && m.modelId === 'demucs');
    expect(status.status).toBe('unavailable');
    expect(status.reason).toMatch(/404/);
    expect(worker.posted.some((m) => m.type === 'model_loaded')).toBe(false);
  });

  test('checksum mismatch is unsupported', async () => {
    const ort = ortWith(async () => ({ output: { data: new Float32Array(1) } }));
    const posted = [];
    const fetched = [];
    const context = { console, navigator: { userAgent: 'node-test' } };
    context.self = context;
    context.globalThis = context;
    context.postMessage = (msg) => { posted.push(msg); };
    context.importScripts = () => {};
    context.fetch = async (url) => { fetched.push(String(url)); return okFetch(); };
    context.crypto = { subtle: { digest: async () => hashBuffer('ab'.repeat(32)) } };
    context.ort = ort;
    vm.createContext(context);
    vm.runInContext(registryCode, context);
    vm.runInContext(workerCode, context);
    await context.onmessage({ data: { type: 'loadModel', models: ['demucs'] } });
    const status = posted.find((m) => m.type === 'model_status' && m.modelId === 'demucs');
    expect(status.status).toBe('unsupported');
    expect(status.reason).toMatch(/SHA-256 mismatch/);
    expect(posted.find((m) => m.type === 'ready').models.demucs).toBe(false);
    expect(posted.some((m) => m.type === 'model_loaded')).toBe(false);
    expect(fetched.some((url) => url.includes('demucs_v4_quantized.onnx'))).toBe(true);
  });

  test('unpinned bsrnn_complex is rejected before fetch', async () => {
    const ort = ortWith(async () => ({ output: { data: new Float32Array(1) } }));
    const worker = bootWorker(ort, async () => okFetch());
    await worker.send({ type: 'loadModel', models: ['bsrnn_complex'] });
    expect(worker.fetched).toEqual([]);
    expect(ort.InferenceSession.create).not.toHaveBeenCalled();
    const status = worker.posted.find((m) => m.type === 'model_status');
    expect(status.modelId).toBe('bsrnn_complex');
    expect(status.status).toBe('unsupported');
    expect(status.reason).toMatch(/checksum/i);
    const ready = worker.posted.find((m) => m.type === 'ready');
    expect(ready.models.bsrnn_complex).toBe(false);
  });

  test('unknown model id is unavailable', async () => {
    const ort = ortWith(async () => ({}));
    const worker = bootWorker(ort, async () => okFetch());
    await worker.send({ type: 'loadModel', models: ['not_a_model'] });
    const status = worker.posted.find((m) => m.type === 'model_status');
    expect(status.status).toBe('unavailable');
    expect(status.reason).toMatch(/unknown model/);
    expect(worker.fetched).toEqual([]);
  });
});

describe('legacy spectral mask calibration', () => {
  const VOCAL = 0.04;
  const RN = 0.01;

  function sessionOrt(handlers) {
    let created = 0;
    return {
      env: { wasm: {}, logLevel: 'warning' },
      Tensor: class Tensor {
        constructor(type, data, dims) {
          this.type = type;
          this.data = data;
          this.dims = dims;
        }
      },
      InferenceSession: {
        create: jest.fn(async () => {
          const run = handlers[created++] || handlers[handlers.length - 1];
          return { run };
        }),
      },
      feeds: [],
    };
  }

  async function runFrames(ort, models) {
    const worker = bootWorker(ort, async () => okFetch());
    await worker.send({
      type: 'init',
      payload: {
        allowedModels: models,
        allowedStages: 10,
        preferredProviders: ['wasm'],
        modelBasePath: '/app/models/',
        fftSize: 64,
        halfN: 4,
      },
    });
    const quiet = new Float32Array(4).fill(1e-4);
    for (let i = 0; i < 90; i++) {
      await worker.send({ type: 'process', payload: { magnitudes: quiet } });
    }
    const mags = new Float32Array([0.2, 0.5, 0.1, 0.4]);
    await worker.send({ type: 'process', payload: { magnitudes: mags } });
    const processed = worker.posted.filter((m) => m.type === 'processed');
    return { worker, output: processed[processed.length - 1].output, mags };
  }

  test('BSRNN input is frame-max normalised and the mask uses exponent 0.5', async () => {
    const seen = [];
    const ort = sessionOrt([
      async (feeds) => {
        seen.push(feeds.input.data);
        return { vocal_mask: { data: new Float32Array(feeds.input.data.length).fill(VOCAL) } };
      },
    ]);
    const { output } = await runFrames(ort, ['bsrnn']);
    const frame = seen.find((data) => data.length === 4 && data[1] === 1);
    expect(frame).toBeDefined();
    expect(frame[0]).toBeCloseTo(0.4, 5);
    expect(frame[1]).toBeCloseTo(1, 5);
    expect(frame[2]).toBeCloseTo(0.2, 5);
    expect(frame[3]).toBeCloseTo(0.8, 5);
    const expected = Math.sqrt(VOCAL);
    for (let i = 0; i < output.length; i++) expect(output[i]).toBeCloseTo(expected, 5);
    expect(output[0]).not.toBeCloseTo(VOCAL, 3);
  });

  test('RNNoise after BSRNN uses chain exponent 0.15, not 0.5', async () => {
    const seen = { bsrnn: null, rnnoise: null };
    const ort = sessionOrt([
      async (feeds) => {
        if (feeds.input.data.length === 4) seen.bsrnn = feeds.input.data;
        return { vocal_mask: { data: new Float32Array(feeds.input.data.length).fill(VOCAL) } };
      },
      async (feeds) => {
        if (feeds.input.data.length === 4) seen.rnnoise = feeds.input.data;
        return { output: { data: new Float32Array(feeds.input.data.length).fill(RN) } };
      },
    ]);
    const { output } = await runFrames(ort, ['bsrnn', 'rnnoise']);
    expect(seen.bsrnn[0]).toBeCloseTo(0.4, 5);
    expect(seen.bsrnn[1]).toBeCloseTo(1, 5);
    expect(seen.bsrnn[2]).toBeCloseTo(0.2, 5);
    expect(seen.bsrnn[3]).toBeCloseTo(0.8, 5);
    expect(seen.rnnoise[0]).toBeCloseTo(0.4, 5);
    expect(seen.rnnoise[1]).toBeCloseTo(1, 5);
    expect(seen.rnnoise[2]).toBeCloseTo(0.2, 5);
    expect(seen.rnnoise[3]).toBeCloseTo(0.8, 5);
    const expected = Math.sqrt(VOCAL) * Math.max(0.01, Math.pow(RN, 0.15));
    const wrongChain = Math.sqrt(VOCAL) * Math.sqrt(RN);
    for (let i = 0; i < output.length; i++) expect(output[i]).toBeCloseTo(expected, 4);
    expect(Math.abs(output[0] - wrongChain)).toBeGreaterThan(0.05);
  });
});
