/**
 * Behavioral tests for MLWorker WebGPU fallback ownership.
 *
 * A process-global preferred BACKEND must not drive batching, queueing, or
 * diagnostics for a session that locally fell back to WASM.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ENTRY_A = {
  id: 'bsrnn_vocals',
  name: 'BSRNN',
  maxBatchFrames: 128,
};
const ENTRY_B = {
  id: 'rnnoise',
  name: 'RNNoise',
  maxBatchFrames: 96,
};

function loadSandbox({ gpuOk = true, createImpl } = {}) {
  const posted = [];
  const creates = [];
  const sandbox = {
    importScripts: () => {},
    console,
    Math,
    self: {
      postMessage: (msg) => posted.push(msg),
      navigator: gpuOk
        ? { gpu: { requestAdapter: async () => ({}) }, hardwareConcurrency: 8 }
        : { hardwareConcurrency: 8 },
    },
    navigator: null,
    ort: {
      InferenceSession: {
        create: async (bytes, opts) => {
          creates.push({ providers: opts.executionProviders.slice(), opts });
          if (typeof createImpl === 'function') {
            return createImpl(bytes, opts, creates.length);
          }
          return { run: async () => ({}), _providers: opts.executionProviders.slice() };
        },
      },
      Tensor: class Tensor {
        constructor(type, data, dims) {
          this.type = type; this.data = data; this.dims = dims;
        }
      },
    },
    Float32Array,
    Uint32Array,
    Uint8Array,
    Object,
    Promise,
    Error,
    ArrayBuffer,
    JSON,
  };
  sandbox.navigator = sandbox.self.navigator;
  sandbox.self.ort = sandbox.ort;
  const src = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'MLWorker.js' });
  sandbox.__posted = posted;
  sandbox.__creates = creates;
  return sandbox;
}

function bytes() {
  return new ArrayBuffer(16);
}

function read(sb, expr) {
  return vm.runInContext(expr, sb);
}

describe('MLWorker WebGPU session ownership', () => {
  test('WebGPU unavailable produces WASM-only creation', async () => {
    const sb = loadSandbox({ gpuOk: false });
    const session = await sb.createSessionFromBytes(ENTRY_A, bytes(), ENTRY_A.id);
    expect(session._providers).toEqual(['wasm']);
    expect(sb.__creates).toHaveLength(1);
    expect(sb.__creates[0].providers).toEqual(['wasm']);
    expect(read(sb, `SESSION_BACKENDS[${JSON.stringify(ENTRY_A.id)}]`)).toBe('wasm');
    expect(read(sb, 'BACKEND')).toBe('wasm');
  });

  test('WebGPU probe success uses WebGPU only (no silent WASM provider list)', async () => {
    const sb = loadSandbox({ gpuOk: true });
    await sb.createSessionFromBytes(ENTRY_A, bytes(), ENTRY_A.id);
    expect(sb.__creates).toHaveLength(1);
    expect(sb.__creates[0].providers).toEqual(['webgpu']);
    expect(read(sb, `SESSION_BACKENDS[${JSON.stringify(ENTRY_A.id)}]`)).toBe('webgpu');
    expect(read(sb, 'BACKEND')).toBe('webgpu');
  });

  test('one graph compile failure retries exactly once on WASM', async () => {
    const sb = loadSandbox({
      gpuOk: true,
      createImpl: async (_bytes, opts) => {
        if (opts.executionProviders[0] === 'webgpu') {
          throw new Error('Failed to create WebGPU session: graph compile error');
        }
        return { run: async () => ({}), _providers: opts.executionProviders.slice() };
      },
    });
    const session = await sb.createSessionFromBytes(ENTRY_A, bytes(), ENTRY_A.id);
    expect(session._providers).toEqual(['wasm']);
    expect(sb.__creates.map((c) => c.providers)).toEqual([['webgpu'], ['wasm']]);
    expect(read(sb, `_wasmSessionKeys[${JSON.stringify(ENTRY_A.id)}]`)).toBe(true);
    expect(read(sb, '_webgpuDisabledReason')).toBe(null);
    expect(read(sb, 'BACKEND')).toBe('webgpu');
    expect(read(sb, `SESSION_BACKENDS[${JSON.stringify(ENTRY_A.id)}]`)).toBe('wasm');
  });

  test('the same session does not endlessly retry WebGPU', async () => {
    let webgpuTries = 0;
    const sb = loadSandbox({
      gpuOk: true,
      createImpl: async (_bytes, opts) => {
        if (opts.executionProviders[0] === 'webgpu') {
          webgpuTries += 1;
          throw new Error('Failed to create WebGPU session: OOM');
        }
        return { run: async () => ({}), _providers: opts.executionProviders.slice() };
      },
    });
    await sb.createSessionFromBytes(ENTRY_A, bytes(), ENTRY_A.id);
    sb.__creates.length = 0;
    await sb.createSessionFromBytes(ENTRY_A, bytes(), ENTRY_A.id);
    expect(webgpuTries).toBe(1);
    expect(sb.__creates.map((c) => c.providers)).toEqual([['wasm']]);
  });

  test('a different graph may still attempt WebGPU after another graph compiled to WASM', async () => {
    const sb = loadSandbox({
      gpuOk: true,
      createImpl: async (_bytes, opts, n) => {
        if (opts.executionProviders[0] === 'webgpu' && n === 1) {
          throw new Error('WebGPU graph compile error');
        }
        return { run: async () => ({}), _providers: opts.executionProviders.slice() };
      },
    });
    await sb.createSessionFromBytes(ENTRY_A, bytes(), ENTRY_A.id);
    await sb.createSessionFromBytes(ENTRY_B, bytes(), ENTRY_B.id);
    expect(read(sb, `SESSION_BACKENDS[${JSON.stringify(ENTRY_A.id)}]`)).toBe('wasm');
    expect(read(sb, `SESSION_BACKENDS[${JSON.stringify(ENTRY_B.id)}]`)).toBe('webgpu');
    expect(sb.__creates.map((c) => c.providers)).toEqual([
      ['webgpu'],
      ['wasm'],
      ['webgpu'],
    ]);
    expect(read(sb, 'BACKEND')).toBe('webgpu');
  });

  test('device loss disables subsequent WebGPU attempts worker-wide', async () => {
    const sb = loadSandbox({
      gpuOk: true,
      createImpl: async (_bytes, opts) => {
        if (opts.executionProviders[0] === 'webgpu') {
          throw new Error('GPUDevice was lost');
        }
        return { run: async () => ({}), _providers: opts.executionProviders.slice() };
      },
    });
    await sb.createSessionFromBytes(ENTRY_A, bytes(), ENTRY_A.id);
    expect(read(sb, '_webgpuDisabledReason')).toMatch(/lost/i);
    sb.__creates.length = 0;
    await sb.createSessionFromBytes(ENTRY_B, bytes(), ENTRY_B.id);
    expect(sb.__creates.map((c) => c.providers)).toEqual([['wasm']]);
    expect(read(sb, `SESSION_BACKENDS[${JSON.stringify(ENTRY_B.id)}]`)).toBe('wasm');
  });

  test('non-WebGPU errors are rethrown without fallback', async () => {
    const sb = loadSandbox({
      gpuOk: true,
      createImpl: async () => {
        throw new Error('invalid ONNX protobuf');
      },
    });
    await expect(sb.createSessionFromBytes(ENTRY_A, bytes(), ENTRY_A.id))
      .rejects.toThrow(/invalid ONNX protobuf/);
    expect(sb.__creates).toHaveLength(1);
    expect(sb.__creates[0].providers).toEqual(['webgpu']);
    expect(read(sb, `SESSION_BACKENDS[${JSON.stringify(ENTRY_A.id)}]`)).toBeUndefined();
  });

  test('WASM-fallback session uses the worker-global WASM run queue', async () => {
    const sb = loadSandbox({
      gpuOk: true,
      createImpl: async (_bytes, opts) => {
        if (opts.executionProviders[0] === 'webgpu') {
          throw new Error('Failed to create WebGPU session: graph compile error');
        }
        return { run: async () => ({}), _providers: opts.executionProviders.slice() };
      },
    });
    await sb.createSessionFromBytes(ENTRY_A, bytes(), ENTRY_A.id);
    expect(sb.inferenceQueueKey(ENTRY_A.id)).toBe('__wasm_global__');
  });

  test('WebGPU session retains its per-session run queue', async () => {
    const sb = loadSandbox({ gpuOk: true });
    await sb.createSessionFromBytes(ENTRY_A, bytes(), ENTRY_A.id);
    await sb.createSessionFromBytes(ENTRY_B, bytes(), ENTRY_B.id);
    expect(sb.inferenceQueueKey(ENTRY_A.id)).toBe(ENTRY_A.id);
    expect(sb.inferenceQueueKey(ENTRY_B.id)).toBe(ENTRY_B.id);
    expect(sb.inferenceQueueKey(ENTRY_A.id)).not.toBe(sb.inferenceQueueKey(ENTRY_B.id));
  });

  test('batch sizing is based on the actual session backend, not only the preferred backend', async () => {
    const sb = loadSandbox({
      gpuOk: true,
      createImpl: async (_bytes, opts) => {
        if (opts.executionProviders[0] === 'webgpu') {
          throw new Error('Failed to create WebGPU session: OOM');
        }
        return { run: async () => ({}), _providers: opts.executionProviders.slice() };
      },
    });
    await sb.createSessionFromBytes(ENTRY_A, bytes(), ENTRY_A.id);
    expect(read(sb, 'BACKEND')).toBe('webgpu');
    const wasmBatch = sb.effectiveBatchFrames(ENTRY_A, ENTRY_A.id);
    const preferredGpuBatch = sb.effectiveBatchFrames(ENTRY_A, 'never-compiled-gpu-key');
    // Preferred BACKEND is still webgpu, so an unpinned key follows WebGPU sizing.
    expect(preferredGpuBatch).toBeGreaterThan(wasmBatch);
    expect(wasmBatch).toBe(Math.min(384, Math.max(ENTRY_A.maxBatchFrames * 3, 192)));
  });

  test('result/diagnostic messages report the actual backend used', async () => {
    const sb = loadSandbox({
      gpuOk: true,
      createImpl: async (_bytes, opts) => {
        if (opts.executionProviders[0] === 'webgpu') {
          throw new Error('Failed to create WebGPU session: graph compile error');
        }
        return { run: async () => ({}), _providers: opts.executionProviders.slice() };
      },
    });
    await sb.createSessionFromBytes(ENTRY_A, bytes(), ENTRY_A.id);
    const fallback = sb.__posted.find((m) => m.type === 'stage' && m.stage === 'ort-fallback');
    expect(fallback).toBeDefined();
    expect(fallback.backend).toBe('wasm');
    expect(fallback.sessionKey).toBe(ENTRY_A.id);
    const reported = sb.actualBackendsFor([ENTRY_A.id]);
    expect(reported.preferredBackend).toBe('webgpu');
    expect(reported.backend).toBe('wasm');
    expect(reported.sessionBackends[ENTRY_A.id]).toBe('wasm');
  });
});
