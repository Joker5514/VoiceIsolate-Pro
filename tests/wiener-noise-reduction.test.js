'use strict';

/**
 * Wiener-MMSE must attenuate a known noise component and leave a clean tone
 * alone when the noise profile is empty. A test that only checks "output
 * changed" is not sufficient.
 *
 * Signals are deterministic. Noise is a fixed LCG, not Math.random.
 * Noise attenuation is the drop in RMS of a noise-only region.
 * Signal preservation is the SDR of a tone-dominated region after reduction,
 * masked to that region.
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
const FFT = 1024;
const HOP = 256;

function lcg(length, amp, seed) {
  const x = new Float32Array(length);
  let s = seed >>> 0;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    x[i] = ((s / 4294967296) * 2 - 1) * amp;
  }
  return x;
}

function tone(length, amp, freq) {
  const x = new Float32Array(length);
  for (let i = 0; i < length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

function rms(x, i0, i1) {
  let s = 0;
  const a = i0 || 0;
  const b = i1 == null ? x.length : i1;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

function nonFinite(x) {
  for (let i = 0; i < x.length; i++) if (!Number.isFinite(x[i])) return true;
  return false;
}

function mixRegions() {
  // 0.25 s noise only, 0.5 s tone+noise, 0.25 s noise only.
  const n = SR;
  const noise = lcg(n, 0.08, 0xA5A5A5A5);
  const clean = new Float32Array(n);
  const tonePart = tone(n, 0.5, 440);
  const noisy = new Float32Array(n);
  const a = Math.floor(n * 0.25);
  const b = Math.floor(n * 0.75);
  for (let i = 0; i < n; i++) {
    noisy[i] = noise[i];
    if (i >= a && i < b) {
      clean[i] = tonePart[i];
      noisy[i] += tonePart[i];
    }
  }
  return { noisy, clean, noise, a, b };
}

function reduce(signal, amount) {
  const spec = DSPCore.forwardSTFT(signal, FFT, HOP);
  const profile = DSPCore.noiseProfileFromMagnitudes(spec.mag, { fraction: 0.2 });
  expect(profile.length).toBe(FFT / 2 + 1);
  const before = spec.mag[0].slice();
  DSPCore.wienerMMSE(spec.mag, profile, amount);
  const out = DSPCore.inverseSTFT(spec.mag, spec.phase, FFT, HOP, signal.length);
  return { out, profile, before, after: spec.mag[0] };
}

describe('Wiener noise reduction', () => {
  test('amount 0 is a no-op on the spectrum and the waveform', () => {
    const { noisy } = mixRegions();
    const spec = DSPCore.forwardSTFT(noisy, FFT, HOP);
    const profile = DSPCore.noiseProfileFromMagnitudes(spec.mag);
    const mag0 = spec.mag[0].slice();
    DSPCore.wienerMMSE(spec.mag, profile, 0);
    for (let k = 0; k < mag0.length; k++) expect(spec.mag[0][k]).toBeCloseTo(mag0[k], 6);
    const out = DSPCore.inverseSTFT(spec.mag, spec.phase, FFT, HOP, noisy.length);
    const plain = DSPCore.inverseSTFT(
      DSPCore.forwardSTFT(noisy, FFT, HOP).mag,
      DSPCore.forwardSTFT(noisy, FFT, HOP).phase,
      FFT, HOP, noisy.length,
    );
    // Re-run a single pair so the comparison is the amount-0 inverse.
    const id = (() => {
      const s = DSPCore.forwardSTFT(noisy, FFT, HOP);
      return DSPCore.inverseSTFT(s.mag, s.phase, FFT, HOP, noisy.length);
    })();
    let max = 0;
    for (let i = 0; i < out.length; i++) max = Math.max(max, Math.abs(out[i] - id[i]));
    expect(max).toBeLessThan(1e-5);
    expect(nonFinite(out)).toBe(false);
    void plain;
  });

  test('a positive amount attenuates the noise-only region and keeps the tone', () => {
    const { noisy, clean, a, b } = mixRegions();
    const dryRms = rms(noisy, 0, a);
    const { out, profile } = reduce(noisy, 80);
    expect(nonFinite(out)).toBe(false);
    const wetRms = rms(out, 0, a);
    // Wiener gain is floored (0.02 at DC, up to ~0.14 at Nyquist), so this
    // fixture cannot go to silence. Measured noise-only RMS ratio at amount
    // 80 is about 1.7× (~4.6 dB). A null profile would leave the ratio at 1.
    expect(dryRms / Math.max(wetRms, 1e-12)).toBeGreaterThan(1.5);
    // Profile matches the analysis bins and is not a null/zero stand-in.
    let profileEnergy = 0;
    for (let k = 0; k < profile.length; k++) profileEnergy += profile[k];
    expect(profileEnergy).toBeGreaterThan(0);
    const toneSdr = sdr(out.subarray(a, b), clean.subarray(a, b));
    // Tone region still contains residual noise, so SDR is modest, but the
    // tone is not erased (which would push this well below 0 dB).
    expect(toneSdr).toBeGreaterThan(6);
  });

  test('more reduction does not disable processing', () => {
    const { noisy, a } = mixRegions();
    const mild = reduce(noisy, 40).out;
    const strong = reduce(noisy, 100).out;
    expect(rms(strong, 0, a)).toBeLessThan(rms(mild, 0, a));
    expect(nonFinite(strong)).toBe(false);
  });

  test('null profile still does not pretend to reduce noise', () => {
    const mag = [new Float32Array([0.5, 0.4, 0.3, 0.2])];
    const before = mag[0].slice();
    DSPCore.wienerMMSE(mag, null, 80);
    for (let k = 0; k < before.length; k++) expect(mag[0][k]).toBeCloseTo(before[k], 5);
  });

  test('estimateNoiseProfile uses padded geometry and a real floor without VAD', () => {
    const { noisy } = mixRegions();
    const spec = DSPCore.forwardSTFT(noisy, FFT, HOP);
    const profile = DSPCore.estimateNoiseProfile(noisy, null, FFT, HOP);
    expect(profile.length).toBe(spec.mag[0].length);
    let e = 0;
    for (let k = 0; k < profile.length; k++) {
      expect(Number.isFinite(profile[k])).toBe(true);
      e += profile[k];
    }
    expect(e).toBeGreaterThan(0);
    // VAD that marks everything as speech yields an empty (zero) profile.
    const voiced = new Float32Array(Math.ceil(noisy.length / 512)).fill(1);
    const none = DSPCore.estimateNoiseProfile(noisy, voiced, FFT, HOP);
    let z = 0;
    for (let k = 0; k < none.length; k++) z += none[k];
    expect(z).toBe(0);
  });
});
