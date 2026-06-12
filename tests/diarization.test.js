/**
 * VoiceIsolate Pro — Speaker Diarization Core Tests (Layer 1)
 *
 * Exercises src/core/diarization.js against synthetic audio with two
 * acoustically distinct "speakers" separated by silence:
 *
 *   0–3 s   low tone   (220 Hz sine — low ZCR)
 *   3–4 s   silence
 *   4–7 s   bright noise-like signal (high ZCR / flatness)
 *
 * The module is pure (no DOM/Web Audio), loaded as ESM via dynamic import
 * under --experimental-vm-modules (same pattern as stem-split-core.test.js).
 */

'use strict';

const SR = 48000;

let diar;

beforeAll(async () => {
  diar = await import('../src/core/diarization.js');
});

function makeTwoSpeakerSignal() {
  const samples = new Float32Array(7 * SR);
  for (let i = 0; i < 3 * SR; i++) {
    samples[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  // 3–4 s stays zero (silence)
  let seed = 42;
  const rand = () => {
    // Deterministic LCG so the test never flakes.
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 4 * SR; i < 7 * SR; i++) {
    samples[i] = 0.3 * (rand() * 2 - 1);
  }
  return samples;
}

describe('frameFeatures', () => {
  test('returns [rms, zcr, flatness]; silence is near-zero energy', () => {
    const silent = diar.frameFeatures(new Float32Array(9600));
    expect(silent[0]).toBe(0);

    const tone = new Float32Array(9600);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin((2 * Math.PI * 220 * i) / SR);
    const f = diar.frameFeatures(tone);
    expect(f[0]).toBeCloseTo(Math.SQRT1_2, 1); // sine RMS ≈ 0.707
    expect(f[1]).toBeGreaterThan(0);
    expect(f[2]).toBeGreaterThan(0);
  });

  test('empty frame yields zeros', () => {
    expect(diar.frameFeatures(new Float32Array(0))).toEqual([0, 0, 0]);
  });
});

describe('kMeans', () => {
  test('separates two obvious clusters deterministically', () => {
    const features = [
      [0, 0], [0.05, 0.02], [0.02, 0.04],
      [1, 1], [0.95, 0.97], [0.98, 1.02],
    ];
    const labels = diar.kMeans(features, 2);
    expect(labels[0]).toBe(labels[1]);
    expect(labels[0]).toBe(labels[2]);
    expect(labels[3]).toBe(labels[4]);
    expect(labels[3]).toBe(labels[5]);
    expect(labels[0]).not.toBe(labels[3]);
    // Deterministic init → identical output on re-run.
    expect([...diar.kMeans(features, 2)]).toEqual([...labels]);
  });

  test('handles empty input', () => {
    expect(diar.kMeans([], 2)).toHaveLength(0);
  });
});

describe('diarizeChannel', () => {
  test('finds two distinct speakers split by silence', () => {
    const segments = diar.diarizeChannel(makeTwoSpeakerSignal(), SR);
    expect(segments.length).toBeGreaterThanOrEqual(2);

    // Output contract: ordered, non-overlapping, ≥ MIN_SEGMENT_SEC long.
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      expect(s.end - s.start).toBeGreaterThanOrEqual(diar.MIN_SEGMENT_SEC);
      expect(s.speakerId).toMatch(/^S\d$/);
      expect(s.label).toBe(`Speaker ${s.speakerId}`);
      expect(s.confidence).toBeGreaterThan(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
      if (i > 0) expect(s.start).toBeGreaterThanOrEqual(segments[i - 1].end);
    }

    // The two halves must be attributed to different speakers.
    const at = (t) => segments.find((s) => t >= s.start && t < s.end);
    const tonal = at(1.5);
    const noisy = at(5.5);
    expect(tonal).toBeDefined();
    expect(noisy).toBeDefined();
    expect(tonal.speakerId).not.toBe(noisy.speakerId);

    // The silent gap must stay unattributed.
    expect(at(3.5)).toBeUndefined();
  });

  test('confidence reflects the segment own energy, not the boundary frame', () => {
    const segments = diar.diarizeChannel(makeTwoSpeakerSignal(), SR);
    const at = (t) => segments.find((s) => t >= s.start && t < s.end);
    // The loud tone flushes on a silent boundary frame; its confidence must
    // come from its own (maximal) energy, not get floored at the 0.68 base.
    expect(at(1.5).confidence).toBeGreaterThan(0.9);
  });

  test('summarizeSpeakers aggregates talk time per speaker', () => {
    const segments = diar.diarizeChannel(makeTwoSpeakerSignal(), SR);
    const speakers = diar.summarizeSpeakers(segments);
    expect(speakers.length).toBeGreaterThanOrEqual(2);
    const total = speakers.reduce((sum, s) => sum + s.talkTime, 0);
    // ~6 s of speech in a 7 s file (1 s is silence).
    expect(total).toBeGreaterThan(4.5);
    expect(total).toBeLessThan(6.6);
    for (const s of speakers) {
      expect(s.segmentCount).toBeGreaterThan(0);
      expect(s.label).toBe(`Speaker ${s.speakerId}`);
    }
  });

  test('degenerate inputs return empty results instead of throwing', () => {
    expect(diar.diarizeChannel(new Float32Array(0), SR)).toEqual([]);
    expect(diar.diarizeChannel(new Float32Array(100), SR)).toEqual([]); // < 1 window
    expect(diar.summarizeSpeakers([])).toEqual([]);
    expect(diar.summarizeSpeakers(null)).toEqual([]);
  });

  test('pure silence produces no speakers', () => {
    expect(diar.diarizeChannel(new Float32Array(2 * SR), SR)).toEqual([]);
  });

  test('invalid sample rate throws a descriptive RangeError', () => {
    expect(() => diar.diarizeChannel(new Float32Array(SR), 0)).toThrow(RangeError);
    // Rates that round the analysis hop to zero samples must fail fast,
    // not spin the feature loop forever.
    expect(() => diar.diarizeChannel(new Float32Array(100), 3)).toThrow(RangeError);
  });
});
