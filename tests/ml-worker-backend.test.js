'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBackendHarness({ adapter = {}, create, runtime = true } = {}) {
  const messages = [];
  const source = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8') + `
    self.__backendTest = { resolveBackend, createSessionFromBytes, classifyWebGpuFailure };
  `;
  const sandbox = {
    importScripts() {},
    console: { warn() {}, log() {}, error() {} },
    self: {
      navigator: adapter === null ? {} : { gpu: { requestAdapter: async () => adapter }, hardwareConcurrency: 4 },
      postMessage: (message) => messages.push(message),
    },
    ort: runtime ? { env: { wasm: {} }, InferenceSession: { create: create || (async () => ({})) } } : undefined,
    Promise, Error, Object, Set, Map, Float32Array, Uint8Array, Uint32Array,
    setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  return { api: sandbox.self.__backendTest, messages, onmessage: sandbox.self.onmessage };
}

const entry = (id) => ({ id });
const bytes = new ArrayBuffer(8);

describe('canonical MLWorker backend fallback', () => {
  test('uses deterministic WASM when WebGPU is unavailable', async () => {
    const calls = [];
    const { api } = loadBackendHarness({ adapter: null, create: async (_b, opts) => { calls.push(opts.executionProviders); return {}; } });
    await api.createSessionFromBytes(entry('a'), bytes, 'a');
    expect(calls).toEqual([['wasm']]);
  });

  test('uses WebGPU when its probe and graph compile succeed', async () => {
    const calls = [];
    const { api } = loadBackendHarness({ adapter: {}, create: async (_b, opts) => { calls.push(opts.executionProviders); return {}; } });
    await api.createSessionFromBytes(entry('a'), bytes, 'a');
    expect(calls).toEqual([['webgpu']]);
  });

  test('pins only a failed graph to WASM and lets another graph try WebGPU', async () => {
    const calls = [];
    const { api, messages } = loadBackendHarness({
      adapter: {},
      create: async (_b, opts) => {
        calls.push(opts.executionProviders);
        if (calls.length === 1) throw new Error('WebGPU graph compile failed');
        return {};
      },
    });
    await api.createSessionFromBytes(entry('a'), bytes, 'a');
    await api.createSessionFromBytes(entry('a'), bytes, 'a');
    await api.createSessionFromBytes(entry('b'), bytes, 'b');
    expect(calls).toEqual([['webgpu'], ['wasm'], ['wasm'], ['webgpu']]);
    expect(messages.find((m) => m.stage === 'ort-fallback')).toMatchObject({ modelId: 'a', reason: 'session-compile' });
  });

  test('a GPU adapter does not verify the provider before a session exists', async () => {
    const { messages, onmessage } = loadBackendHarness({ adapter: {} });
    await onmessage({ data: { type: 'init', manifest: [] } });
    const ready = messages.find((message) => message.type === 'ready');
    expect(ready).toMatchObject({
      backend: 'wasm',
      gpuCandidate: true,
      providerVerified: false,
      sessionCreated: false,
      reason: 'session-not-created',
    });
    expect(messages.some((message) => message.providerVerified === true)).toBe(false);
  });

  test('a missing WASM runtime fails closed instead of reporting ready', async () => {
    const { messages, onmessage } = loadBackendHarness({ adapter: null, runtime: false });
    await onmessage({ data: { type: 'init', manifest: [] } });
    expect(messages).toEqual([
      expect.objectContaining({
        type: 'error',
        code: 'PROVIDER_INIT_FAILED',
        providerVerified: false,
        runtimePresent: false,
      }),
    ]);
  });

  test('device loss disables further WebGPU attempts worker-wide', async () => {
    const calls = [];
    const { api } = loadBackendHarness({
      adapter: {},
      create: async (_b, opts) => {
        calls.push(opts.executionProviders);
        if (calls.length === 1) throw new Error('GPU device lost');
        return {};
      },
    });
    await api.createSessionFromBytes(entry('a'), bytes, 'a');
    await api.createSessionFromBytes(entry('b'), bytes, 'b');
    expect(calls).toEqual([['webgpu'], ['wasm'], ['wasm']]);
  });
});
