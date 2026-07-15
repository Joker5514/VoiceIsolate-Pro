/**
 * VoiceIsolate Pro — Spectral Cleanup Core Tests (Layer 1)
 *
 * Exercises src/core/SpectralCleanup.js (offline Phase-1 DSP):
 *   • bypass / transparency at amount 0
 *   • near-transparency at tiny amount → validates STFT COLA reconstruction
 *   • reduceNoise: attenuates a stationary noise floor while preserving a burst
 *   • dereverb: shortens an exponentially decaying tail, preserves the onset
 *   • length + finiteness invariants
 *
 * Pure ESM module, loaded via dynamic import under --experimental-vm-modules
 * (same pattern as diarization.test.js).
 */
'use strict';

const SR = 48000;

let sc;

beforeAll(async () => {
  sc = await import('../src/core/SpectralCleanup.js');
});

// ── helpers ─────────────────────────────────────────────────────────────────

function rms(buf, from = 0, to = buf.length) {
  // Floor bounds: `2.2 * SR` is a non-integer float, and indexing a
  // Float32Array off-grid yields undefined → NaN. Keep indices integral.
  from = Math.floor(from);
  to = Math.floor(to);
  let s = 0;
  for (let i = from; i < to; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

function allFinite(buf) {
  for (let i = 0; i < buf.length; i++) if (!Number.isFinite(buf[i])) return false;
  return true;
}

// Deterministic pseudo-random noise (mulberry32) so tests never flake.
function noiseGen(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5) * 2;
  };
}

// ── transparency / COLA ──────────────────────────────────────────────────────

describe('transparency & reconstruction', () => {
  test('reduceNoise(amount 0) returns an exact copy', () => {
    const x = new Float32Array(SR);
    for (let i = 0; i < x.length; i++) x[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SR);
    const y = sc.reduceNoise(x, { amount: 0, sampleRate: SR });
    expect(y).not.toBe(x);                 // new buffer
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  test('dereverb(amount 0) returns an exact copy', () => {
    const x = new Float32Array(2048).map((_, i) => Math.sin(i / 5));
    const y = sc.dereverb(x, { amount: 0 });
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  test('tiny amount ≈ identity (STFT overlap-add reconstructs the signal)', () => {
    const x = new Float32Array(SR);
    for (let i = 0; i < x.length; i++) {
      // sweep so many bins are exercised
      x[i] = 0.4 * Math.sin((2 * Math.PI * (200 + 0.05 * i) * i) / SR);
    }
    const y = sc.reduceNoise(x, { amount: 1e-6, sampleRate: SR });
    // Compare an interior region (skip COLA ramp at the very edges).
    const a = 4096; const b = x.length - 4096;
    let maxErr = 0;
    for (let i = a; i < b; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - x[i]));
    expect(maxErr).toBeLessThan(1e-3);
  });
});

// ── noise reduction ──────────────────────────────────────────────────────────

describe('reduceNoise', () => {
  // 3 s: stationary low-level noise throughout + a loud tone burst in [1s,2s).
  function makeNoisyBurst() {
    const n = 3 * SR;
    const x = new Float32Array(n);
    const rnd = noiseGen(12345);
    for (let i = 0; i < n; i++) x[i] = 0.03 * rnd();           // noise floor
    for (let i = SR; i < 2 * SR; i++) x[i] += 0.5 * Math.sin((2 * Math.PI * 600 * i) / SR);
    return x;
  }

  test('attenuates the noise-only region while largely preserving the burst', () => {
    const x = makeNoisyBurst();
    const y = sc.reduceNoise(x, { amount: 1, sampleRate: SR });
    expect(y.length).toBe(x.length);
    expect(allFinite(y)).toBe(true);

    // Noise-only region [2.2s, 2.8s): should drop substantially.
    const noiseBefore = rms(x, 2.2 * SR, 2.8 * SR);
    const noiseAfter = rms(y, 2.2 * SR, 2.8 * SR);
    expect(noiseAfter).toBeLessThan(noiseBefore * 0.6);

    // Burst region [1.2s, 1.8s): tone energy should be largely retained.
    const burstBefore = rms(x, 1.2 * SR, 1.8 * SR);
    const burstAfter = rms(y, 1.2 * SR, 1.8 * SR);
    expect(burstAfter).toBeGreaterThan(burstBefore * 0.7);
  });

  test('digital-silence segments do not disable reduction (noise floor not zeroed)', () => {
    // A leading + trailing block of absolute silence would pin every bin's
    // minimum power at 0 and globally disable NR. The silence guard skips them.
    const n = 3 * SR;
    const x = new Float32Array(n);
    const rnd = noiseGen(777);
    for (let i = 0; i < n; i++) x[i] = 0.03 * rnd();
    x.fill(0, 0, 0.5 * SR);            // 0.5 s leading digital silence
    x.fill(0, 2.5 * SR, n);           // 0.5 s trailing digital silence
    const y = sc.reduceNoise(x, { amount: 1, sampleRate: SR });
    expect(allFinite(y)).toBe(true);
    // The noisy middle must still be attenuated (not passed through untouched).
    const before = rms(x, 1.2 * SR, 1.8 * SR);
    const after = rms(y, 1.2 * SR, 1.8 * SR);
    expect(after).toBeLessThan(before * 0.6);
  });

  test('stronger amount removes more noise', () => {
    const x = makeNoisyBurst();
    const lo = sc.reduceNoise(x, { amount: 0.3, sampleRate: SR });
    const hi = sc.reduceNoise(x, { amount: 1, sampleRate: SR });
    const r = (b) => rms(b, 2.2 * SR, 2.8 * SR);
    expect(r(hi)).toBeLessThan(r(lo));
    expect(r(lo)).toBeLessThan(r(x));
  });
});

// ── dereverb ─────────────────────────────────────────────────────────────────

describe('dereverb', () => {
  // A 600 Hz tone gated to a short onset, then an exponentially decaying tail
  // (a crude single-bin "reverb"): onset [0,0.1s], decay over the next ~1s.
  function makeDecayingTail() {
    const n = 2 * SR;
    const x = new Float32Array(n);
    const onset = 0.1 * SR;
    for (let i = 0; i < n; i++) {
      const tone = Math.sin((2 * Math.PI * 600 * i) / SR);
      const env = i < onset ? 1 : Math.exp(-(i - onset) / (0.25 * SR));
      x[i] = 0.5 * env * tone;
    }
    return x;
  }

  test('shortens the decaying tail relative to the onset', () => {
    const x = makeDecayingTail();
    const y = sc.dereverb(x, { amount: 1, sampleRate: SR, rt60: 0.3 });
    expect(y.length).toBe(x.length);
    expect(allFinite(y)).toBe(true);

    const onsetBefore = rms(x, 0, 0.1 * SR);
    const onsetAfter = rms(y, 0, 0.1 * SR);
    const tailBefore = rms(x, 0.6 * SR, 1.2 * SR);
    const tailAfter = rms(y, 0.6 * SR, 1.2 * SR);

    // Tail/onset ratio must shrink — the late tail is suppressed more than the onset.
    const ratioBefore = tailBefore / (onsetBefore + 1e-12);
    const ratioAfter = tailAfter / (onsetAfter + 1e-12);
    expect(ratioAfter).toBeLessThan(ratioBefore * 0.9);
    // Onset itself is largely preserved.
    expect(onsetAfter).toBeGreaterThan(onsetBefore * 0.6);
  });
});

// ── cleanupSpectral (fused single STFT path) ─────────────────────────────────

describe('cleanupSpectral', () => {
  test('amount 0 / 0 returns a copy', () => {
    const x = new Float32Array([0.1, -0.2, 0.3, 0]);
    const y = sc.cleanupSpectral(x, { noiseReduction: 0, dereverb: 0 });
    expect(y).toBeInstanceOf(Float32Array);
    expect(y.length).toBe(x.length);
    expect(Array.from(y)).toEqual(Array.from(x));
  });

  test('NR-only delegates to reduceNoise path (finite output)', () => {
    const n = SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.05 * Math.sin((2 * Math.PI * 440 * i) / SR) + 0.02 * Math.sin(i);
    const y = sc.cleanupSpectral(x, { noiseReduction: 0.8, dereverb: 0, sampleRate: SR });
    expect(y.length).toBe(x.length);
    expect(allFinite(y)).toBe(true);
  });

  test('both stages active yields finite same-length output', () => {
    const n = Math.floor(0.5 * SR);
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const tone = Math.sin((2 * Math.PI * 300 * i) / SR);
      const env = i < 0.05 * SR ? 1 : Math.exp(-(i - 0.05 * SR) / (0.15 * SR));
      x[i] = 0.4 * env * tone + 0.02 * Math.sin(i * 0.7);
    }
    const y = sc.cleanupSpectral(x, { noiseReduction: 0.7, dereverb: 0.6, sampleRate: SR, rt60: 0.3 });
    expect(y.length).toBe(x.length);
    expect(allFinite(y)).toBe(true);
  });
});

// ── invariants ───────────────────────────────────────────────────────────────

describe('invariants', () => {
  test('empty input yields empty output', () => {
    expect(sc.reduceNoise(new Float32Array(0), { amount: 1 }).length).toBe(0);
    expect(sc.dereverb(new Float32Array(0), { amount: 1 }).length).toBe(0);
  });

  test('short input (< frame size) is handled', () => {
    const x = new Float32Array(500).map((_, i) => 0.2 * Math.sin(i / 3));
    const y = sc.reduceNoise(x, { amount: 1, sampleRate: SR });
    expect(y.length).toBe(500);
    expect(allFinite(y)).toBe(true);
  });

  test('accepts a plain array and returns a Float32Array', () => {
    const y = sc.reduceNoise([0, 0.1, -0.1, 0.2], { amount: 0.5 });
    expect(y).toBeInstanceOf(Float32Array);
    expect(y.length).toBe(4);
  });
});
