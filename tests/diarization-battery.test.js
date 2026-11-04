/**
 * VIP-031 — diarization battery pins.
 *
 * These tests pin the shipped diarization's observable behaviour on
 * small synthetic fixtures (fast: pure JS, no ONNX) so a future change
 * to runDiarization is a deliberate, visible change — they do NOT bless
 * the baseline quality. The baseline numbers themselves (DER per
 * fixture, 50% false-split rate on real single-speaker clips) live in
 * scripts/quality/diarization-eval.cjs output, not here.
 *
 * Deliberately pinned as change detectors (update with the fix, not
 * silently): the energy-weighted confidence range [0.68, 0.97], and the
 * fact that a single stationary tone currently reports 2 speakers
 * (forced k=2). If calibrated speaker confidence or a speaker-aware
 * clusterer lands, these tests must be updated in the same commit.
 */
'use strict';

const { createDiarizationWorker } = require('../scripts/quality/lib/diarization-node.cjs');
const S = require('../scripts/quality/lib/signals.cjs');

const SR = 48000;

function sine(seconds, freq = 220) {
  const pcm = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin((2 * Math.PI * freq * i) / SR) * 0.3;
  return pcm;
}

describe('shipped diarization (VIP-031)', () => {
  let worker;
  beforeAll(() => {
    worker = createDiarizationWorker();
  });

  test('silence produces zero segments', async () => {
    const r = await worker.diarize(new Float32Array(3 * SR), SR);
    expect(r.segments).toEqual([]);
    expect(r.speakerCount).toBe(0);
  });

  test('segments carry the documented schema', async () => {
    const r = await worker.diarize(sine(4), SR);
    expect(r.segments.length).toBeGreaterThan(0);
    for (const s of r.segments) {
      expect(typeof s.speakerId).toBe('string');
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end - s.start).toBeGreaterThanOrEqual(0.3);
      // Energy-weighted confidence range (change detector — see header).
      expect(s.confidence).toBeGreaterThanOrEqual(0.68);
      expect(s.confidence).toBeLessThanOrEqual(0.97);
    }
  });

  test('a single stationary tone currently reports 2 speakers (forced k=2; known limitation)', async () => {
    const r = await worker.diarize(sine(4), SR);
    expect(r.speakerCount).toBe(2);
  });

  test('two-talker fixture runs and returns segments (separation quality is measured by the eval script, not asserted here)', async () => {
    const A = S.talker({ seconds: 3, seed: 11, f0: 125 }).signal;
    const B = S.talker({ seconds: 3, seed: 22, f0: 180, formantScale: 1.2 }).signal;
    const pcm = new Float32Array(6 * SR);
    pcm.set(A, 0);
    pcm.set(B, 3 * SR);
    const r = await worker.diarize(pcm, SR);
    expect(r.segments.length).toBeGreaterThan(0);
    expect(r.duration).toBeCloseTo(6, 5);
  });
});
