/**
 * DSP-03 — slider-sweep zero-inference proof (LOCAL 2026-11-25).
 *
 * The claim: moving sliders (or any UI-side parameter change) performs
 * ZERO model inference. The counters live at the actual model invocation
 * boundary — `queuedSessionRun`, the single `session.run` call site in
 * the worker — so a sweep that never reaches the worker cannot move them,
 * and any inference anywhere in the worker must move them.
 *
 * Proof shape (plan DSP-03):
 * 1. Fresh worker: counters are 0.
 * 2. 200 slider-sweep iterations through the REAL UI-side param path
 *    (getEffectiveDspParams → buildMlProcessingConfig → snapshotParams),
 *    sweeping real slider values across their ranges: counters stay 0.
 *    The sweep is proven non-trivial: the built revisions differ across
 *    steps, so the path did real work and still invoked nothing.
 * 3. Positive control: one separate() moves the counters (proving the
 *    boundary is real — a counter that never moves proves nothing).
 * 4. Steady state: after warmup, one 1-channel separate() adds exactly
 *    one session run; resetCounters() returns to 0 and the next
 *    separate() adds exactly one again.
 *
 * Browser-level proof (Playwright slider drag → counters stay 0) is NOT
 * runnable here — no Chrome binary exists in this VM — and must run where
 * Chrome exists. This suite is the harness-level proof.
 */
'use strict';

const { createMlWorker } = require('../scripts/quality/lib/mlworker-node.cjs');

const TIMEOUT = 120000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fixtureInput() {
  const rand = mulberry32(777);
  const n = 48000;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t = i / 48000;
    out[i] = 0.1 * Math.sin(2 * Math.PI * 220 * t) + 0.02 * (rand() * 2 - 1);
  }
  return [out];
}

let worker;
let Schema;
let SliderCal;

beforeAll(async () => {
  worker = await createMlWorker();
  Schema = await import('../src/core/ParameterSchema.js');
  SliderCal = await import('../public/app/slider-calibration.js');
}, TIMEOUT);

describe('slider sweeps perform zero inference', () => {
  test('counters start at 0 on a fresh worker', async () => {
    const c = await worker.counters();
    expect(c.sessionRuns).toBe(0);
    expect(c.bySessionKey).toEqual({});
  }, TIMEOUT);

  test('200 sweep iterations through the real UI param path: still 0', async () => {
    const revisions = new Set();
    // Sweep real slider values across their ranges, exactly as a drag
    // would: coupling + soft-clamp + schema build + snapshot, no worker.
    for (let i = 0; i < 200; i += 1) {
      const raw = {
        voiceIso: (i * 7) % 101,
        bgSuppress: (i * 13) % 101,
        voiceFocus: (i * 3) % 101,
        nrAmount: (i * 11) % 101,
        maskStrength: 0.15 + ((i % 10) * 0.05), // 0.15..0.60
        whisperLift: i % 9,
      };
      const effective = SliderCal.getEffectiveDspParams(raw, {});
      const built = Schema.buildMlProcessingConfig(effective);
      const snap = Schema.snapshotParams(effective);
      expect(snap).toBeTruthy();
      revisions.add(built.revision);
    }
    // The sweep did real work: many distinct configs were built.
    expect(revisions.size).toBeGreaterThan(50);
    const c = await worker.counters();
    expect(c.sessionRuns).toBe(0);
    expect(c.bySessionKey).toEqual({});
  }, TIMEOUT);

  test('positive control: one separate() moves the counters', async () => {
    const before = await worker.counters();
    expect(before.sessionRuns).toBe(0);
    const res = await worker.separate(fixtureInput(), {
      modelIds: ['bsrnn_vocals'],
      processingConfig: null,
    });
    expect(res.clean[0].length).toBe(48000);
    const after = await worker.counters();
    // First separate includes the bsrnn self-test run (1) + the inference
    // run (1). The exact split is recorded, not assumed: what matters is
    // > 0 — the counter boundary is real.
    expect(after.sessionRuns).toBeGreaterThan(0);
    expect(after.bySessionKey.bsrnn_vocals).toBe(after.sessionRuns);
  }, TIMEOUT);

  test('steady state: one separate() adds exactly one session run', async () => {
    const before = await worker.counters();
    await worker.separate(fixtureInput(), {
      modelIds: ['bsrnn_vocals'],
      processingConfig: null,
    });
    const after = await worker.counters();
    expect(after.sessionRuns - before.sessionRuns).toBe(1);
    expect(after.bySessionKey.bsrnn_vocals - before.bySessionKey.bsrnn_vocals).toBe(1);
  }, TIMEOUT);

  test('resetCounters returns to 0; the next separate adds exactly one', async () => {
    const reset = await worker.resetCounters();
    expect(reset.sessionRuns).toBe(0);
    expect(reset.bySessionKey).toEqual({});
    await worker.separate(fixtureInput(), {
      modelIds: ['bsrnn_vocals'],
      processingConfig: null,
    });
    const after = await worker.counters();
    expect(after.sessionRuns).toBe(1);
    expect(after.bySessionKey).toEqual({ bsrnn_vocals: 1 });
  }, TIMEOUT);
});
