/**
 * JobController — cancellation + stale job guards.
 */
'use strict';

let JC;

beforeAll(async () => {
  JC = await import('../src/pipeline/JobController.js');
});

beforeEach(() => {
  JC._resetJobsForTests();
});

describe('JobController', () => {
  test('beginJob creates running job with signal', () => {
    const job = JC.beginJob('Test');
    expect(job.id).toMatch(/^job-/);
    expect(job.status).toBe('running');
    expect(job.controller.signal.aborted).toBe(false);
    expect(JC.getCurrentJobId()).toBe(job.id);
  });

  test('cancelCurrent aborts signal and clears current', () => {
    const job = JC.beginJob('Test');
    const ok = JC.cancelCurrent('user');
    expect(ok).toBe(true);
    expect(job.controller.signal.aborted).toBe(true);
    expect(JC.getCurrentJobId()).toBe(null);
  });

  test('updateJob ignores stale job ids', () => {
    const job = JC.beginJob('A');
    expect(JC.updateJob(job.id, 'stage', 50)).toBe(true);
    expect(JC.updateJob('job-other', 'x', 10)).toBe(false);
    expect(job.percent).toBe(50);
  });

  test('updateJob clamps progress and never regresses within a job', () => {
    const job = JC.beginJob('Monotonic');
    JC.updateJob(job.id, 'decode', 62);
    JC.updateJob(job.id, 'decode', 41);
    expect(job.percent).toBe(62);
    JC.updateJob(job.id, 'finalize', 140);
    expect(job.percent).toBe(100);
    JC.updateJob(job.id, 'invalid', Number.NaN);
    expect(job.percent).toBe(100);
  });

  test('beginJob supersedes previous running job', () => {
    const a = JC.beginJob('A');
    const b = JC.beginJob('B');
    expect(a.controller.signal.aborted).toBe(true);
    expect(a.cancelReason).toBe('superseded');
    expect(JC.getCurrentJobId()).toBe(b.id);
  });

  test('throwIfAborted raises CancellationError', () => {
    const job = JC.beginJob('X');
    job.controller.abort();
    expect(() => JC.throwIfAborted(job.controller.signal)).toThrow(JC.CancellationError);
  });

  test('isCancellationError detects cancel names', () => {
    expect(JC.isCancellationError(new JC.CancellationError())).toBe(true);
    expect(JC.isCancellationError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
    expect(JC.isCancellationError(new Error('network fail'))).toBe(false);
  });

  test('endJob only accepts current id', () => {
    const job = JC.beginJob('E');
    expect(JC.endJob(job.id, 'completed')).toBeTruthy();
    expect(JC.getCurrentJob()).toBe(null);
  });
});
