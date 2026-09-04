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

  test('recycling for one aborted request settles every overlapping request', async () => {
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
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = runSileroVad(new Float32Array([0.1]), 48000, {
      signal: firstController.signal,
      timeoutMs: 10000,
    });
    const second = runSileroVad(new Float32Array([0.2]), 48000, {
      signal: secondController.signal,
      timeoutMs: 10000,
    });
    const firstRejection = expect(first).rejects.toThrow('MLWorker reset');
    const secondRejection = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    for (let attempt = 0; attempt < 50; attempt++) {
      const vadCalls = worker.postMessage.mock.calls.filter(([message]) => message.type === 'vad');
      if (vadCalls.length === 2) break;
      await Promise.resolve();
    }
    expect(worker.postMessage.mock.calls.filter(([message]) => message.type === 'vad')).toHaveLength(2);

    secondController.abort('user');

    await Promise.all([firstRejection, secondRejection]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
