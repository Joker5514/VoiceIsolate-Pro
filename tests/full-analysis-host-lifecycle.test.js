/**
 * FullAnalysisHost worker lifecycle regression tests.
 */
'use strict';

let FullAnalysisHost;

beforeAll(async () => {
  ({ FullAnalysisHost } = await import('../src/pipeline/FullAnalysisHost.js'));
});

describe('FullAnalysisHost worker lifecycle', () => {
  let workers;
  let hosts;

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

  async function waitForAnalyzePost() {
    for (let attempt = 0; attempt < 50; attempt++) {
      const worker = workers.at(-1);
      const call = worker?.postMessage.mock.calls.find(([message]) => message.type === 'analyze');
      if (call) return { worker, call };
      await Promise.resolve();
    }
    throw new Error('Analysis worker was never dispatched');
  }

  async function beginAnalysis(host, opts = {}) {
    const pending = host.analyze(
      [new Float32Array([0.1, -0.1])],
      48000,
      { skipVad: true, ...opts },
    );
    const dispatched = await waitForAnalyzePost();
    return { pending, ...dispatched };
  }

  beforeEach(() => {
    workers = [];
    hosts = [];
    global.Worker = jest.fn(() => {
      const worker = createWorker();
      workers.push(worker);
      return worker;
    });
  });

  afterEach(() => {
    for (const host of hosts) host.dispose();
    jest.useRealTimers();
    delete global.Worker;
  });

  function makeHost(options = {}) {
    const host = new FullAnalysisHost({ enableMlVad: false, ...options });
    hosts.push(host);
    return host;
  }

  test('settles a matching result and ignores stale request ids', async () => {
    const host = makeHost();
    const { pending } = await beginAnalysis(host);
    const worker = workers[0];
    const requestId = worker.postMessage.mock.calls[0][0].requestId;

    worker.dispatch('message', { data: { type: 'result', requestId: requestId + 1, analysis: 'stale' } });
    worker.dispatch('message', { data: { type: 'result', requestId, analysis: { ok: true } } });

    await expect(pending).resolves.toEqual({ ok: true });
    expect(host._activeRequestId).toBeNull();
  });

  test('dispose rejects an active analysis and terminates the worker', async () => {
    const host = makeHost();
    const { pending } = await beginAnalysis(host);
    const worker = workers[0];

    host.dispose();

    await expect(pending).rejects.toThrow('Disposed during analysis');
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(host._worker).toBeNull();
  });

  test.each([
    ['error', { message: 'analysis crashed' }, 'analysis crashed'],
    ['messageerror', {}, 'could not be deserialized'],
  ])('recycles and rejects after worker %s', async (eventType, event, expected) => {
    const host = makeHost();
    const { pending } = await beginAnalysis(host);
    const worker = workers[0];

    worker.dispatch(eventType, event);

    await expect(pending).rejects.toThrow(expected);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(host._worker).toBeNull();
  });

  test('creates a clean worker after a fatal worker failure', async () => {
    const host = makeHost();
    const { pending: first } = await beginAnalysis(host);
    workers[0].dispatch('error', { message: 'first failed' });
    await expect(first).rejects.toThrow('first failed');

    const { pending: retry } = await beginAnalysis(host);
    expect(workers).toHaveLength(2);
    const requestId = workers[1].postMessage.mock.calls[0][0].requestId;
    workers[1].dispatch('message', {
      data: { type: 'result', requestId, analysis: { retried: true } },
    });

    await expect(retry).resolves.toEqual({ retried: true });
  });

  test('an older request still preparing VAD cannot dispatch over a newer request', async () => {
    const host = makeHost();
    let releaseFirst;
    host._withVadHints = jest.fn()
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ skipVad: true });
      }))
      .mockResolvedValueOnce({ skipVad: true });

    const first = host.analyze([new Float32Array([0.1])], 48000);
    const firstRejection = expect(first).rejects.toThrow('Superseded by a newer analysis');
    for (let attempt = 0; attempt < 50 && typeof releaseFirst !== 'function'; attempt++) {
      await Promise.resolve();
    }
    expect(typeof releaseFirst).toBe('function');

    const secondProgress = jest.fn();
    const second = host.analyze(
      [new Float32Array([0.2])],
      48000,
      { onProgress: secondProgress },
    );
    const { worker, call } = await waitForAnalyzePost();
    const requestId = call[0].requestId;
    worker.dispatch('message', { data: { type: 'progress', requestId, percent: 40 } });
    worker.dispatch('message', { data: { type: 'result', requestId, analysis: { newest: true } } });

    releaseFirst();
    await firstRejection;
    await expect(second).resolves.toEqual({ newest: true });
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(secondProgress).toHaveBeenCalledWith(40, 'analysis');
  });

  test('cleans up and rejects when dispatch throws', async () => {
    const host = makeHost();
    const worker = host._ensureWorker();
    worker.postMessage.mockImplementationOnce(() => {
      throw new Error('analysis clone failed');
    });
    const pendingPromise = host.analyze(
      [new Float32Array([0.1])],
      48000,
      { skipVad: true },
    );
    await expect(pendingPromise).rejects.toThrow('analysis clone failed');
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  test('does not false-kill a synchronous worker at the default stall deadline', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const host = makeHost();
    const { pending } = await beginAnalysis(host, { stallMs: 1000, timeoutMs: 10000 });

    jest.setSystemTime(2001);
    await jest.advanceTimersByTimeAsync(2000);

    expect(workers[0].terminate).not.toHaveBeenCalled();
    const requestId = workers[0].postMessage.mock.calls[0][0].requestId;
    workers[0].dispatch('message', {
      data: { type: 'result', requestId, analysis: { completed: true } },
    });
    await expect(pending).resolves.toEqual({ completed: true });
  });

  test('terminates a silent worker at the hard deadline', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const host = makeHost();
    const { pending } = await beginAnalysis(host, { timeoutMs: 1000 });
    const rejection = expect(pending).rejects.toThrow('timed out');

    jest.setSystemTime(2001);
    await jest.advanceTimersByTimeAsync(2000);

    await rejection;
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
  });

  test('a throwing dispatch progress observer cannot fail analysis', async () => {
    const host = makeHost();
    const { pending, worker, call } = await beginAnalysis(host, {
      onProgress: () => { throw new Error('render failed'); },
    });
    const requestId = call[0].requestId;

    worker.dispatch('message', {
      data: { type: 'result', requestId, analysis: { ok: true } },
    });

    await expect(pending).resolves.toEqual({ ok: true });
  });

  test('passes cancellation into VAD preparation', async () => {
    const controller = new AbortController();
    const buildVadHints = jest.fn((mono, sampleRate, extraction, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('VAD cancelled'), { name: 'AbortError' }));
      }, { once: true });
    }));
    const host = makeHost({ enableMlVad: true, buildVadHints });
    const pending = host.analyze(
      [new Float32Array([0.1, -0.1])],
      48000,
      { signal: controller.signal },
    );
    for (let attempt = 0; attempt < 50 && !buildVadHints.mock.calls.length; attempt++) {
      await Promise.resolve();
    }

    controller.abort('user');

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(buildVadHints.mock.calls[0][3].signal).toBe(controller.signal);
  });
});
