/**
 * VAD worker cancellation regression.
 */
'use strict';

describe('VadAnalysis lifecycle', () => {
  let originalWorker;

  beforeEach(() => {
    originalWorker = global.Worker;
  });

  afterEach(() => {
    if (originalWorker) global.Worker = originalWorker;
    else delete global.Worker;
  });

  test('abort rejects VAD and terminates its active worker', async () => {
    const listeners = new Map();
    const worker = {
      terminate: jest.fn(),
      addEventListener: jest.fn((type, listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
      }),
      removeEventListener: jest.fn((type, listener) => listeners.get(type)?.delete(listener)),
      postMessage: jest.fn((message) => {
        if (message.type === 'init') {
          queueMicrotask(() => {
            for (const listener of [...(listeners.get('message') || [])]) {
              listener({ data: { type: 'ready', backend: 'wasm' } });
            }
          });
        }
      }),
    };
    global.Worker = jest.fn(() => worker);
    const { runSileroVad } = await import('../src/pipeline/VadAnalysis.js');
    const controller = new AbortController();
    const pending = runSileroVad(new Float32Array([0.1, -0.1]), 48000, {
      signal: controller.signal,
      timeoutMs: 10000,
    });
    for (let attempt = 0; attempt < 50; attempt++) {
      if (worker.postMessage.mock.calls.some(([message]) => message.type === 'vad')) break;
      await Promise.resolve();
    }
    expect(worker.postMessage.mock.calls.some(([message]) => message.type === 'vad')).toBe(true);

    controller.abort('user');

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'cancel' }));
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
