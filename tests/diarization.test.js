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

describe('exported constants (PR-added)', () => {
  test('SILENCE_RMS is the deliberate low floor (0.0015 ≈ −56 dBFS)', () => {
    // Intentionally low to capture whispered/soft speech on the CLEAN stem.
    expect(diar.SILENCE_RMS).toBe(0.0015);
  });

  test('MEL_BANDS is 20', () => {
    expect(diar.MEL_BANDS).toBe(20);
  });
});

describe('melBands (timbral fingerprint)', () => {
  test('degenerate input yields an all-zero band vector', () => {
    const z = diar.melBands(new Float32Array(0), SR);
    expect(z).toHaveLength(diar.MEL_BANDS);
    expect([...z].every((v) => v === 0)).toBe(true);
    expect([...diar.melBands(new Float32Array(4096), SR)].every((v) => v === 0)).toBe(true);
  });

  test('returns a loudness-invariant shape (sums to 1) concentrated by pitch', () => {
    const low = new Float32Array(9600);
    const high = new Float32Array(9600);
    for (let i = 0; i < low.length; i++) {
      low[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / SR);
      high[i] = 0.5 * Math.sin((2 * Math.PI * 6000 * i) / SR);
    }
    const lowBands = diar.melBands(low, SR);
    const highBands = diar.melBands(high, SR);
    // Each fingerprint normalises to a distribution (sum ≈ 1).
    const sum = (a) => [...a].reduce((s, v) => s + v, 0);
    expect(sum(lowBands)).toBeCloseTo(1, 5);
    expect(sum(highBands)).toBeCloseTo(1, 5);
    // The low tone's mass sits in lower bands than the high tone's.
    const centroid = (a) => [...a].reduce((s, v, i) => s + v * i, 0);
    expect(centroid(lowBands)).toBeLessThan(centroid(highBands));
  });

  test('fingerprint is invariant to amplitude (same voice, different volume)', () => {
    const quiet = new Float32Array(9600);
    const loud = new Float32Array(9600);
    for (let i = 0; i < quiet.length; i++) {
      const s = Math.sin((2 * Math.PI * 440 * i) / SR);
      quiet[i] = 0.02 * s; // a near-whisper amplitude
      loud[i] = 0.8 * s;
    }
    const a = diar.melBands(quiet, SR);
    const b = diar.melBands(loud, SR);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 4);
  });

  test('returns Float32Array of length MEL_BANDS for valid input', () => {
    const frame = new Float32Array(9600);
    for (let i = 0; i < frame.length; i++) frame[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
    const result = diar.melBands(frame, SR);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result).toHaveLength(diar.MEL_BANDS);
  });

  test('invalid sampleRate values yield all-zero band vector', () => {
    const frame = new Float32Array(9600);
    for (let i = 0; i < frame.length; i++) frame[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
    expect([...diar.melBands(frame, 0)].every((v) => v === 0)).toBe(true);
    expect([...diar.melBands(frame, -1)].every((v) => v === 0)).toBe(true);
    expect([...diar.melBands(frame, NaN)].every((v) => v === 0)).toBe(true);
    expect([...diar.melBands(frame, Infinity)].every((v) => v === 0)).toBe(true);
  });

  test('non-Float32Array input (wrong type) yields all-zero band vector', () => {
    // Regular Array is not Float32Array — must be rejected gracefully.
    const asArray = Array.from({ length: 9600 }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / SR));
    const result = diar.melBands(asArray, SR);
    expect(result).toBeInstanceOf(Float32Array);
    expect([...result].every((v) => v === 0)).toBe(true);
  });

  test('single-sample frame (length 1) yields all-zero band vector', () => {
    // frame.length <= 1 is the boundary — exactly 1 sample is degenerate.
    const single = new Float32Array([0.5]);
    expect([...diar.melBands(single, SR)].every((v) => v === 0)).toBe(true);
  });

  test('custom bands parameter produces the requested output length', () => {
    const frame = new Float32Array(9600);
    for (let i = 0; i < frame.length; i++) frame[i] = Math.sin((2 * Math.PI * 440 * i) / SR);
    const result10 = diar.melBands(frame, SR, 10);
    expect(result10).toHaveLength(10);
    const sum10 = [...result10].reduce((s, v) => s + v, 0);
    expect(sum10).toBeCloseTo(1, 4);

    const result40 = diar.melBands(frame, SR, 40);
    expect(result40).toHaveLength(40);
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

  test('separates two EQUAL-loudness speakers by timbre alone (fingerprint)', () => {
    // Both "speakers" are 0.5-amplitude harmonic tones — identical RMS — so
    // they can only be told apart by their spectral fingerprint, not energy.
    const samples = new Float32Array(8 * SR);
    const harmonic = (i, f) =>
      0.5 * (Math.sin((2 * Math.PI * f * i) / SR) +
             0.4 * Math.sin((2 * Math.PI * 2 * f * i) / SR) +
             0.2 * Math.sin((2 * Math.PI * 3 * f * i) / SR)) / 1.6;
    for (let i = 0; i < 3.5 * SR; i++) samples[i] = harmonic(i, 180); // low-pitched voice
    // 3.5–4 s silence
    for (let i = 4 * SR; i < 8 * SR; i++) samples[i] = harmonic(i, 320); // higher-pitched voice

    const segments = diar.diarizeChannel(samples, SR);
    const at = (t) => segments.find((s) => t >= s.start && t < s.end);
    const first = at(1.5);
    const second = at(6);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first.speakerId).not.toBe(second.speakerId);
  });

  test('captures whisper-level speech instead of gating it as silence', () => {
    // A very quiet (≈ −40 dBFS) voiced tone must still register as a speaker.
    const samples = new Float32Array(2 * SR);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = 0.01 * Math.sin((2 * Math.PI * 300 * i) / SR);
    }
    const segments = diar.diarizeChannel(samples, SR);
    expect(segments.length).toBeGreaterThanOrEqual(1);
    const talk = diar.summarizeSpeakers(segments).reduce((s, sp) => s + sp.talkTime, 0);
    expect(talk).toBeGreaterThan(1); // most of the 2 s is captured
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

  test('SILENCE_RMS boundary: signal just below threshold produces no segments', () => {
    // RMS well below SILENCE_RMS (0.0015) — must be gated out entirely.
    // A 1-sample-per-window constant at amplitude 0.001 gives RMS = 0.001 < 0.0015.
    const amplitude = 0.001; // < SILENCE_RMS
    const samples = new Float32Array(2 * SR);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = amplitude * Math.sin((2 * Math.PI * 300 * i) / SR);
    }
    // RMS of a sine ≈ amplitude / √2 ≈ 0.000707, which is below SILENCE_RMS.
    expect(diar.diarizeChannel(samples, SR)).toEqual([]);
  });

  test('SILENCE_RMS boundary: signal at and above threshold is captured', () => {
    // RMS > 0.0015 must register as voiced. Use amplitude 0.01 (RMS ≈ 0.00707).
    const amplitude = 0.01; // sine RMS ≈ 0.00707 >> SILENCE_RMS
    const samples = new Float32Array(2 * SR);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = amplitude * Math.sin((2 * Math.PI * 300 * i) / SR);
    }
    const segments = diar.diarizeChannel(samples, SR);
    expect(segments.length).toBeGreaterThanOrEqual(1);
  });

  test('maxSpeakers option caps cluster count', () => {
    // maxSpeakers is clamped to the documented 2-8 range; with maxSpeakers: 2
    // the diarizer should never produce more than 2 speaker ids.
    const samples = makeTwoSpeakerSignal();
    const segments = diar.diarizeChannel(samples, SR, { maxSpeakers: 2 });
    const ids = new Set(segments.map((s) => s.speakerId));
    expect(ids.size).toBeLessThanOrEqual(2);
  });
});
