/** Regression coverage for ExportOrchestrator worker initialization timeout. */
'use strict';

const { describe, it, expect, afterEach } = require('@jest/globals');

describe('ExportOrchestrator initialization timeout', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete global.Worker;
  });

  it('rejects, terminates the stalled worker, and resets worker state', async () => {
    jest.useFakeTimers();

    let worker;
    global.Worker = jest.fn().mockImplementation(() => {
      worker = {
        postMessage: jest.fn(),
        terminate: jest.fn(),
        onmessage: null,
        onerror: null,
      };
      return worker;
    });

    const { ExportOrchestrator } = await import('../src/pipeline/ExportOrchestrator.js');
    const orchestrator = new ExportOrchestrator({});
    const initPromise = orchestrator._initWorker();
    const rejection = expect(initPromise).rejects.toThrow('Worker initialization timeout');

    await jest.advanceTimersByTimeAsync(10000);

    await rejection;
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(orchestrator._worker).toBeNull();
    expect(orchestrator._workerReady).toBe(false);
    expect(orchestrator._initPromise).toBeNull();
    expect(orchestrator._rejectInit).toBeNull();
  });
});
