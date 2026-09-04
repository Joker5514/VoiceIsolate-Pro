/**
 * Shared StemSeparation worker lifecycle regression tests.
 */
'use strict';

let StemSeparation;

beforeAll(async () => {
  StemSeparation = await import('../src/pipeline/StemSeparation.js');
});

describe('StemSeparation worker lifecycle', () => {
  let workers;

  function createWorker() {
    const listeners = new Map();
    return {
      postMessage: jest.fn(),
      terminate: jest.fn(),
      addEventListener: jest.fn((type, listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(listener);
      }),
      removeEventListener: jest.fn((type, listener) => listeners.get(type)?.delete(listener)),
      dispatch(type, event = {}) {
        for (const listener of [...(listeners.get(type) || [])]) listener(event);
      },
    };
  }

  beforeEach(() => {
    workers = [];
    global.Worker = jest.fn(() => {
      const worker = createWorker();
      workers.push(worker);
      return worker;
    });
    StemSeparation.clearStemCache();
    StemSeparation.resetStemSeparation();
  });

  afterEach(() => {
    StemSeparation.resetStemSeparation();
    delete global.Worker;
  });

  async function readyWorker() {
    const ready = StemSeparation.default.ensureReady();
    const worker = workers.at(-1);
    worker.dispatch('message', { data: { type: 'ready', backend: 'wasm' } });
    await ready;
    return worker;
  }

  async function waitForPost(worker, type) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const call = worker.postMessage.mock.calls.find(([message]) => message.type === type);
      if (call) return call;
      await Promise.resolve();
    }
    throw new Error(`Worker never posted ${type}`);
  }

  test('recycles a failed init and permits a clean retry', async () => {
    const first = StemSeparation.default.ensureReady();
    const failedWorker = workers[0];
    failedWorker.dispatch('error', { message: 'init crashed' });

    await expect(first).rejects.toThrow('init crashed');
    expect(failedWorker.terminate).toHaveBeenCalledTimes(1);

    const retry = StemSeparation.default.ensureReady();
    const replacement = workers[1];
    replacement.dispatch('message', { data: { type: 'ready', backend: 'wasm' } });
    await expect(retry).resolves.toBe('wasm');
  });

  test('reset rejects warmup waiters instead of abandoning their timers', async () => {
    await readyWorker();
    const pending = StemSeparation.warmupModels(['test-model']);
    const rejection = expect(pending).rejects.toThrow('MLWorker reset');
    await waitForPost(workers.at(-1), 'warmup');

    StemSeparation.resetStemSeparation();

    await rejection;
  });

  test('recycles when a warmup message cannot be posted', async () => {
    const worker = await readyWorker();
    worker.postMessage.mockImplementation((message) => {
      if (message.type === 'warmup' && message.modelIds.includes('broken-model')) {
        throw new Error('warmup clone failed');
      }
    });

    await expect(StemSeparation.warmupModels(['broken-model']))
      .rejects.toThrow('warmup clone failed');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  test('ignores unscoped results and resolves only its matching request', async () => {
    const worker = await readyWorker();
    const pending = StemSeparation.separateStems(
      [new Float32Array([0.1, -0.1])],
      48000,
      { transferOwned: true, sourceName: 'strict-id.wav' },
    );
    const processCall = await waitForPost(worker, 'process');
    const requestId = processCall[0].requestId;

    worker.dispatch('message', { data: { type: 'stems', clean: ['stale'], noise: ['stale'] } });
    worker.dispatch('message', {
      data: {
        type: 'stems',
        requestId,
        clean: [new Float32Array([0.1])],
        noise: [new Float32Array([0])],
        sampleRate: 48000,
      },
    });

    await expect(pending).resolves.toMatchObject({ sampleRate: 48000 });
  });

  test('exported cancellation targets the active request and owns its grace timeout', async () => {
    const worker = await readyWorker();
    const pending = StemSeparation.separateStems(
      [new Float32Array([0.1, -0.1])],
      48000,
      { transferOwned: true, sourceName: 'cancel.wav' },
    );
    const processCall = await waitForPost(worker, 'process');
    const requestId = processCall[0].requestId;

    expect(StemSeparation.cancelStemSeparation()).toBe(true);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: 'cancel', requestId });
    worker.dispatch('message', { data: { type: 'cancelled', requestId } });

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a throwing progress callback cannot strand the active request', async () => {
    const worker = await readyWorker();
    const pending = StemSeparation.separateStems(
      [new Float32Array([0.1])],
      48000,
      {
        transferOwned: true,
        sourceName: 'progress-callback.wav',
        onProgress: () => { throw new Error('render callback failed'); },
      },
    );
    const requestId = (await waitForPost(worker, 'process'))[0].requestId;
    worker.dispatch('message', { data: { type: 'progress', requestId, percent: 20 } });
    worker.dispatch('message', {
      data: {
        type: 'stems',
        requestId,
        clean: [new Float32Array([0.1])],
        noise: [new Float32Array([0])],
        sampleRate: 48000,
      },
    });

    await expect(pending).resolves.toMatchObject({ sampleRate: 48000 });
  });

  test.each([
    ['error', { message: 'process crashed' }, 'process crashed'],
    ['messageerror', {}, 'deserialize failed'],
  ])('rejects and recycles an active process after worker %s', async (type, event, expected) => {
    const worker = await readyWorker();
    const pending = StemSeparation.separateStems(
      [new Float32Array([0.2])],
      48000,
      { transferOwned: true, sourceName: `${type}.wav` },
    );
    await waitForPost(worker, 'process');

    worker.dispatch(type, event);

    await expect(pending).rejects.toThrow(expected);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  test('reset rejects an active process immediately', async () => {
    const worker = await readyWorker();
    const pending = StemSeparation.separateStems(
      [new Float32Array([0.3])],
      48000,
      { transferOwned: true, sourceName: 'reset-active.wav' },
    );
    await waitForPost(worker, 'process');

    StemSeparation.resetStemSeparation();

    await expect(pending).rejects.toThrow('MLWorker reset');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  test('cleans up and rejects when process dispatch throws', async () => {
    const worker = await readyWorker();
    worker.postMessage.mockImplementationOnce(() => {
      throw new Error('process clone failed');
    });

    await expect(StemSeparation.separateStems(
      [new Float32Array([0.2])],
      48000,
      { transferOwned: true, sourceName: 'post-failure.wav' },
    )).rejects.toThrow('process clone failed');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });
});
