/**
 * Separate module registry from the adapter-present fallback test.
 * probeWebGpuCandidate caches the first adapter result for the process.
 */
'use strict';

describe('OrtRuntime WASM-only path', () => {
  afterEach(() => {
    delete globalThis.ort;
    delete globalThis.__vipOrtStatus;
  });

  test('no WebGPU adapter creates a WASM session and marks it verified', async () => {
    const calls = [];
    globalThis.navigator = { hardwareConcurrency: 2 };
    globalThis.ort = {
      env: { wasm: {} },
      InferenceSession: {
        create: async (_source, opts) => {
          calls.push(opts.executionProviders.slice());
          return { provider: opts.executionProviders[0] };
        },
      },
    };
    const { createOrtSession, getOrtRuntimeStatus } = await import('../src/pipeline/OrtRuntime.js');
    const session = await createOrtSession('/models/missing-speaker.onnx', { cacheKey: 'wasm-only' });
    expect(calls).toEqual([['wasm']]);
    expect(session.provider).toBe('wasm');
    const status = getOrtRuntimeStatus();
    expect(status.provider).toBe('wasm');
    expect(status.providerVerified).toBe(true);
    expect(status.provider).not.toBe('webgpu');
  });
});
