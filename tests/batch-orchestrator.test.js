'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/app/batch-orchestrator.js'), 'utf8');
const BatchOrchestrator = (() => {
  const exports = {};
  const module = { exports };
  const window = {};
  eval(src); // eslint-disable-line no-eval
  return module.exports;
})();

// ── constructor ───────────────────────────────────────────────────────────────

describe('BatchOrchestrator constructor', () => {
  test('default concurrency falls back to navigator.hardwareConcurrency or 4', () => {
    const expected = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency)
      ? navigator.hardwareConcurrency : 4;
    expect(new BatchOrchestrator({}).concurrency).toBe(expected);
  });

  test('concurrency option overrides default', () => {
    expect(new BatchOrchestrator({ concurrency: 8 }).concurrency).toBe(8);
  });

  test('starts with empty queue and maps', () => {
    const bo = new BatchOrchestrator();
    expect(bo.queue.length).toBe(0);
    expect(bo.active.size).toBe(0);
    expect(bo.completed.length).toBe(0);
    expect(bo.failed.length).toBe(0);
  });

  test('running is false initially', () => {
    expect(new BatchOrchestrator().running).toBe(false);
  });

  test('default callbacks are no-ops that do not throw', () => {
    const bo = new BatchOrchestrator();
    expect(() => bo.onProgress({})).not.toThrow();
    expect(() => bo.onJobComplete({})).not.toThrow();
    expect(() => bo.onJobError({})).not.toThrow();
    expect(() => bo.onBatchComplete({})).not.toThrow();
  });

  test('custom callbacks are stored', () => {
    const onProgress = jest.fn();
    const bo = new BatchOrchestrator({ onProgress });
    bo.onProgress({ pct: 50 });
    expect(onProgress).toHaveBeenCalledWith({ pct: 50 });
  });
});

// ── enqueue ───────────────────────────────────────────────────────────────────

describe('BatchOrchestrator.enqueue', () => {
  test('returns incrementing integer IDs', () => {
    const bo = new BatchOrchestrator();
    const id1 = bo.enqueue({ name: 'a.wav' });
    const id2 = bo.enqueue({ name: 'b.wav' });
    expect(typeof id1).toBe('number');
    expect(id2).toBe(id1 + 1);
  });

  test('adds a job to the queue', () => {
    const bo = new BatchOrchestrator();
    bo.enqueue({ name: 'test.wav' });
    expect(bo.queue.length).toBe(1);
  });

  test('queue sorts by priority ascending (lower number = higher priority)', () => {
    const bo = new BatchOrchestrator();
    bo.enqueue({ name: 'low.wav' }, 10);
    bo.enqueue({ name: 'high.wav' }, 1);
    bo.enqueue({ name: 'mid.wav' }, 5);
    expect(bo.queue.map(j => j.priority)).toEqual([1, 5, 10]);
  });

  test('default priority is 5', () => {
    const bo = new BatchOrchestrator();
    bo.enqueue({ name: 'test.wav' });
    expect(bo.queue[0].priority).toBe(5);
  });

  test('initial job status is queued', () => {
    const bo = new BatchOrchestrator();
    bo.enqueue({ name: 'test.wav' });
    expect(bo.queue[0].status).toBe('queued');
  });

  test('initial progress is 0', () => {
    const bo = new BatchOrchestrator();
    bo.enqueue({ name: 'test.wav' });
    expect(bo.queue[0].progress).toBe(0);
  });

  test('per-file params override global params', () => {
    const bo = new BatchOrchestrator({ params: { nrAmount: 50 } });
    bo.enqueue({ name: 'test.wav' }, 5, { nrAmount: 80 });
    expect(bo.queue[0].params.nrAmount).toBe(80);
  });

  test('uses global params when no per-file params provided', () => {
    const bo = new BatchOrchestrator({ params: { nrAmount: 50 } });
    bo.enqueue({ name: 'test.wav' });
    expect(bo.queue[0].params.nrAmount).toBe(50);
  });
});

// ── enqueueMany ───────────────────────────────────────────────────────────────

describe('BatchOrchestrator.enqueueMany', () => {
  test('enqueues all files and returns their IDs', () => {
    const bo = new BatchOrchestrator();
    const ids = bo.enqueueMany([{ name: 'a.wav' }, { name: 'b.wav' }, { name: 'c.wav' }]);
    expect(ids.length).toBe(3);
    expect(bo.queue.length).toBe(3);
  });

  test('all returned IDs are unique', () => {
    const bo = new BatchOrchestrator();
    const ids = bo.enqueueMany([{ name: 'a.wav' }, { name: 'b.wav' }]);
    expect(new Set(ids).size).toBe(2);
  });
});

// ── getProgress ───────────────────────────────────────────────────────────────

describe('BatchOrchestrator.getProgress', () => {
  test('empty state returns 100', () => {
    expect(new BatchOrchestrator().getProgress()).toBe(100);
  });

  test('all queued, none done → 0', () => {
    const bo = new BatchOrchestrator();
    bo.enqueue({ name: 'a.wav' });
    bo.enqueue({ name: 'b.wav' });
    expect(bo.getProgress()).toBe(0);
  });

  test('half completed → 50', () => {
    const bo = new BatchOrchestrator();
    bo.enqueue({ name: 'a.wav' });
    bo.enqueue({ name: 'b.wav' });
    bo.completed.push(bo.queue.shift());
    expect(bo.getProgress()).toBe(50);
  });

  test('all completed → 100', () => {
    const bo = new BatchOrchestrator();
    bo.enqueue({ name: 'a.wav' });
    bo.completed.push(bo.queue.shift());
    expect(bo.getProgress()).toBe(100);
  });
});

// ── stop / cancel ─────────────────────────────────────────────────────────────

describe('BatchOrchestrator.stop and cancel', () => {
  test('stop() sets running=false', () => {
    const bo = new BatchOrchestrator();
    bo.running = true;
    bo.stop();
    expect(bo.running).toBe(false);
  });

  test('cancel() clears queue and sets running=false', () => {
    const bo = new BatchOrchestrator();
    bo.enqueue({ name: 'a.wav' });
    bo.enqueue({ name: 'b.wav' });
    bo.running = true;
    bo.cancel();
    expect(bo.running).toBe(false);
    expect(bo.queue.length).toBe(0);
  });

  test('cancel() sends abort to active workers', () => {
    const bo = new BatchOrchestrator();
    const mockWorker = { postMessage: jest.fn() };
    bo.active.set(1, { worker: mockWorker });
    bo.cancel();
    expect(mockWorker.postMessage).toHaveBeenCalledWith({ type: 'abort' });
  });

  test('cancel() handles active jobs without a worker reference gracefully', () => {
    const bo = new BatchOrchestrator();
    bo.active.set(1, { worker: null }); // no worker ref
    expect(() => bo.cancel()).not.toThrow();
  });
});

// ── _encodeWAV ────────────────────────────────────────────────────────────────

describe('BatchOrchestrator._encodeWAV', () => {
  const readStr = (v, off, len) =>
    Array.from({ length: len }, (_, i) => String.fromCharCode(v.getUint8(off + i))).join('');

  let bo;
  beforeEach(() => { bo = new BatchOrchestrator(); });

  test('produces valid RIFF/WAVE/fmt /data header', () => {
    const buf = bo._encodeWAV(new Float32Array(10), 48000);
    const v = new DataView(buf);
    expect(readStr(v, 0, 4)).toBe('RIFF');
    expect(readStr(v, 8, 4)).toBe('WAVE');
    expect(readStr(v, 12, 4)).toBe('fmt ');
    expect(readStr(v, 36, 4)).toBe('data');
  });

  test('buffer size = 44 + samples*2 for 16-bit', () => {
    expect(bo._encodeWAV(new Float32Array(100), 48000, 16).byteLength).toBe(244);
  });

  test('sample rate written at offset 24', () => {
    expect(new DataView(bo._encodeWAV(new Float32Array(1), 44100, 16)).getUint32(24, true)).toBe(44100);
  });

  test('RIFF chunk size = 36 + dataSize', () => {
    const buf = bo._encodeWAV(new Float32Array(10), 48000, 16);
    expect(new DataView(buf).getUint32(4, true)).toBe(36 + 10 * 2);
  });

  test('data size field = samples * 2', () => {
    const buf = bo._encodeWAV(new Float32Array(20), 48000, 16);
    expect(new DataView(buf).getUint32(40, true)).toBe(20 * 2);
  });

  test('over-range samples are clipped to ±32767', () => {
    const buf = bo._encodeWAV(new Float32Array([2.0, -2.0]), 48000, 16);
    const v = new DataView(buf);
    expect(v.getInt16(44, true)).toBe(0x7FFF);
    expect(v.getInt16(46, true)).toBeLessThanOrEqual(-0x7FFF);
  });

  test('format tag is 1 (PCM) for 16-bit', () => {
    const buf = bo._encodeWAV(new Float32Array(1), 48000, 16);
    expect(new DataView(buf).getUint16(20, true)).toBe(1);
  });
});

// ── start() ───────────────────────────────────────────────────────────────────

describe('BatchOrchestrator.start()', () => {
  test('onBatchComplete fires after all jobs finish', async () => {
    const completeCb = jest.fn();
    const bo = new BatchOrchestrator({ concurrency: 2, onBatchComplete: completeCb });

    bo._processJob = async (job) => {
      job.status = 'complete';
      bo.completed.push(job);
      bo.active.delete(job.id);
    };

    bo.enqueue({ name: 'a.wav' });
    bo.enqueue({ name: 'b.wav' });
    await bo.start();

    expect(completeCb).toHaveBeenCalledTimes(1);
    const stats = completeCb.mock.calls[0][0];
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(0);
    expect(stats.total).toBe(2);
  });

  test('calling start() while already running is a no-op', async () => {
    const bo = new BatchOrchestrator({ concurrency: 1 });
    bo._processJob = async (job) => {
      await new Promise(r => setTimeout(r, 10));
      bo.completed.push(job);
      bo.active.delete(job.id);
    };
    bo.enqueue({ name: 'a.wav' });
    await Promise.all([bo.start(), bo.start()]);
    expect(bo.completed.length).toBe(1);
  });

  test('failed jobs are tracked in failed array', async () => {
    const bo = new BatchOrchestrator({ concurrency: 1 });
    bo._processJob = async (job) => {
      job.status = 'error';
      job.error = 'Test error';
      bo.failed.push(job);
      bo.active.delete(job.id);
    };
    bo.enqueue({ name: 'fail.wav' });
    await bo.start();
    expect(bo.failed.length).toBe(1);
    expect(bo.completed.length).toBe(0);
  });

  test('running resets to false after completion', async () => {
    const bo = new BatchOrchestrator({ concurrency: 1 });
    bo._processJob = async (job) => {
      bo.completed.push(job);
      bo.active.delete(job.id);
    };
    bo.enqueue({ name: 'a.wav' });
    await bo.start();
    expect(bo.running).toBe(false);
  });

  test('empty queue: onBatchComplete fires immediately with zeros', async () => {
    const cb = jest.fn();
    const bo = new BatchOrchestrator({ onBatchComplete: cb });
    await bo.start();
    expect(cb).toHaveBeenCalledWith({ completed: 0, failed: 0, total: 0 });
  });
});
