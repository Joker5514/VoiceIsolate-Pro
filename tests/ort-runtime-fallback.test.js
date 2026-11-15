/**
 * ONNX provider selection: WebGPU is active only after its own session create.
 */
'use strict';

describe('OrtRuntime provider fallback', () => {
  afterEach(() => {
    delete globalThis.ort;
    delete globalThis.__vipOrtStatus;
  });

  test('a present WebGPU adapter does not count until its session is created', async () => {
    const calls = [];
    globalThis.navigator = {
      gpu: { requestAdapter: async () => ({ name: 'adapter-only' }) },
      hardwareConcurrency: 4,
    };
    globalThis.ort = {
      env: { wasm: {} },
      InferenceSession: {
        create: async (_source, opts) => {
          calls.push(opts.executionProviders.slice());
          if (opts.executionProviders[0] === 'webgpu') {
            throw new Error('WebGPU graph compile failed');
          }
          return { provider: 'wasm' };
        },
      },
    };
    const { createOrtSession, getOrtRuntimeStatus } = await import('../src/pipeline/OrtRuntime.js');
    const session = await createOrtSession('/models/missing-speaker.onnx', { cacheKey: 'fallback-a' });
    expect(session.provider).toBe('wasm');
    expect(calls).toEqual([['webgpu'], ['wasm']]);
    const status = getOrtRuntimeStatus();
    expect(status.provider).toBe('wasm');
    expect(status.providerVerified).toBe(true);
    expect(status.provider).not.toBe('webgpu');
    const again = await createOrtSession('/models/missing-speaker.onnx', { cacheKey: 'fallback-a' });
    expect(again).toBe(session);
    expect(calls).toHaveLength(2);
  });
});
