'use strict';

/**
 * STFT / iSTFT reconstruction correctness.
 *
 * SDR is the plain (not scale-invariant) ratio from scripts/quality/lib/metrics.cjs:
 *   SDR = 10 * log10( sum(ref[i]^2) / sum((est[i] - ref[i])^2) )
 * A 440 Hz, amplitude 0.8, 48 kHz sine through the padded 4096/1024 periodic
 * Hann path is a synthetic round-trip only. It does not measure real-world
 * speech quality. On this engine that case lands near 139 dB; the assertion
 * is SDR > 120 dB and max |error| < 1e-5, which still fails the old half-peak
 * overlap-add floor (that path was ~12 dB on full-band material).
 *
 * Non-padded framing (pad = 0) cannot rebuild samples the periodic Hann
 * zeroes (w[0] = 0) or samples past the last whole window. Those samples are
 * expected to be exactly 0. Everywhere the window² sum exceeds 1e-12 the
 * waveform must match.
 */

const fs = require('fs');
const path = require('path');
const { sdr } = require('../scripts/quality/lib/metrics.cjs');

const dspSrc = fs.readFileSync(path.join(__dirname, '../public/app/dsp-core.js'), 'utf8');
const DSPCore = (() => {
  const exports = {};
  const module = { exports };
  const window = undefined;
  const self = undefined;
  // eslint-disable-next-line no-eval
  eval(dspSrc);
  return module.exports;
})();

const SR = 48000;

function sine(length, amp = 0.8, freq = 440) {
  const x = new Float32Array(length);
  for (let i = 0; i < length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

function impulse(length, at, amp) {
  const x = new Float32Array(length);
  x[at] = amp;
  return x;
}

function maxAbs(a, b, i0 = 0, i1 = Math.min(a.length, b.length)) {
  let m = 0;
  for (let i = i0; i < i1; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function nonFinite(x) {
  let n = 0;
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) n++;
  return n;
}

function roundTrip(input, fftSize, hopSize, opts) {
  const spec = DSPCore.forwardSTFT(input, fftSize, hopSize, opts);
  const out = DSPCore.inverseSTFT(spec.mag, spec.phase, fftSize, hopSize, input.length);
  return { spec, out };
}

describe('padded STFT/iSTFT', () => {
  test('4096/1024 440 Hz sine: documented SDR and edge error', () => {
    const fftSize = 4096;
    const hopSize = 1024;
    const input = sine(SR, 0.8, 440);
    const { spec, out } = roundTrip(input, fftSize, hopSize);
    expect(spec.pad).toBe(fftSize - hopSize);
    expect(spec.frameCount).toBe(Math.floor((input.length - 1 + spec.pad) / hopSize) + 1);
    const err = maxAbs(out, input);
    const ratio = sdr(out, input);
    // Recorded on Node 22, linux, float32 Cooley-Tukey, periodic Hann.
    // Observed SDR ≈ 139.2 dB, max |error| ≈ 3e-7.
    expect(err).toBeLessThan(1e-5);
    expect(ratio).toBeGreaterThan(120);
    expect(nonFinite(out)).toBe(0);
  });

  test('low-amplitude sine keeps relative error', () => {
    const input = sine(8000, 1e-6, 1000);
    const { out } = roundTrip(input, 1024, 256);
    expect(nonFinite(out)).toBe(0);
    expect(maxAbs(out, input)).toBeLessThan(1e-9);
    expect(sdr(out, input)).toBeGreaterThan(100);
  });

  test('leading and trailing silence stay silent and the tone returns', () => {
    const input = sine(SR);
    for (let i = 0; i < 2000; i++) input[i] = 0;
    for (let i = SR - 2000; i < SR; i++) input[i] = 0;
    const { out } = roundTrip(input, 2048, 512);
    expect(maxAbs(out, input)).toBeLessThan(1e-5);
    expect(Math.abs(out[0])).toBeLessThan(1e-5);
    expect(Math.abs(out[out.length - 1])).toBeLessThan(1e-5);
  });

  test('impulses, including one at each end', () => {
    const input = impulse(16000, 0, 0.8);
    input[100] = -0.4;
    input[8000] = 0.9;
    input[15999] = -0.7;
    const { out } = roundTrip(input, 1024, 256);
    expect(nonFinite(out)).toBe(0);
    expect(maxAbs(out, input)).toBeLessThan(1e-5);
  });

  test.each([
    ['exact multiple', 16384],
    ['not divisible by hop', SR + 777],
    ['shorter than the window', 1000],
    ['one sample', 1],
  ])('%s length round-trips', (_label, length) => {
    const input = sine(length, 0.5, 880);
    const { out } = roundTrip(input, 1024, 256);
    expect(out.length).toBe(length);
    expect(nonFinite(out)).toBe(0);
    expect(maxAbs(out, input)).toBeLessThan(1e-4);
  });
});

describe('non-padded STFT/iSTFT', () => {
  test('hop === fftSize rebuilds the window peak that the half-peak floor used to halve', () => {
    const fftSize = 1024;
    const input = sine(fftSize, 0.8, 440);
    const { spec, out } = roundTrip(input, fftSize, fftSize);
    expect(spec.pad).toBe(0);
    expect(spec.frameCount).toBe(1);
    expect(spec.mag[0]).toHaveLength(fftSize / 2 + 1);
    // Periodic Hann is 0 at sample 0, so that sample is uncovered.
    expect(out[0]).toBe(0);
    // i = N/4 has window² = 0.25, below the removed 0.5·peak floor.
    const quarter = fftSize / 4;
    expect(Math.abs(out[quarter] - input[quarter])).toBeLessThan(1e-4);
    expect(Math.abs(out[fftSize / 2] - input[fftSize / 2])).toBeLessThan(1e-4);
    expect(nonFinite(out)).toBe(0);
  });

  test('explicit pad=0 does not reflect, and the covered interior matches', () => {
    const fftSize = 1024;
    const hopSize = 256;
    const input = sine(SR + 100, 0.6, 220);
    const spec = DSPCore.forwardSTFT(input, fftSize, hopSize, { pad: 0 });
    expect(spec.pad).toBe(0);
    const expectedFrames = Math.floor((input.length - fftSize) / hopSize) + 1;
    expect(spec.frameCount).toBe(expectedFrames);
    const out = DSPCore.inverseSTFT(spec.mag, spec.phase, fftSize, hopSize, input.length);
    const coveredEnd = (expectedFrames - 1) * hopSize + fftSize;
    expect(maxAbs(out, input, 8, coveredEnd - 8)).toBeLessThan(1e-4);
    for (let i = coveredEnd; i < out.length; i++) expect(out[i]).toBe(0);
    expect(out[0]).toBe(0);
    expect(nonFinite(out)).toBe(0);
  });

  test('untagged magnitudes do not assume the edge pad', () => {
    const input = sine(4096, 0.5, 440);
    const spec = DSPCore.forwardSTFT(input, 1024, 256);
    expect(spec.pad).toBe(768);
    const tagged = DSPCore.inverseSTFT(spec.mag, spec.phase, 1024, 256, input.length);
    const bare = spec.mag.slice();
    delete bare.pad;
    delete bare.inputLength;
    const warned = [];
    const orig = console.warn;
    console.warn = (...args) => warned.push(args.join(' '));
    DSPCore._untaggedPadWarned = false;
    let untagged;
    try {
      untagged = DSPCore.inverseSTFT(bare, spec.phase, 1024, 256, input.length);
    } finally {
      console.warn = orig;
    }
    expect(warned.some((m) => /pad=0/.test(m))).toBe(true);
    expect(maxAbs(tagged, input)).toBeLessThan(1e-5);
    expect(maxAbs(untagged, tagged)).toBeGreaterThan(0.1);
  });
});

describe('chunked overlap-add', () => {
  test('chunk boundaries match the full forward/inverse pair', () => {
    const input = sine(SR + 300, 0.7, 440);
    input[0] = 0.9;
    input[input.length - 1] = -0.8;
    const fftSize = 1024;
    const hopSize = 256;
    const full = roundTrip(input, fftSize, hopSize).out;
    for (const chunkFrames of [1, 3, 17, 64]) {
      const chunked = DSPCore.processChunked(input, fftSize, hopSize, { chunkFrames });
      expect(chunked.length).toBe(input.length);
      expect(maxAbs(chunked, full)).toBe(0);
      expect(nonFinite(chunked)).toBe(0);
    }
  });

  test('a final partial chunk does not drop or duplicate samples', () => {
    const input = sine(5000, 0.4, 1000);
    const full = roundTrip(input, 512, 128).out;
    const chunked = DSPCore.processChunked(input, 512, 128, { chunkFrames: 10 });
    expect(chunked.length).toBe(5000);
    expect(maxAbs(chunked, full)).toBe(0);
  });
});
