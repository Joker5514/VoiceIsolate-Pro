'use strict';

/**
 * The fused spectral path transforms a *real* frame, so it uses a half-length
 * complex FFT instead of an n-point one. These tests execute both transforms
 * and pin the new path to the full complex reference it replaced — a silent
 * divergence here would be audible, not just slow.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8');
const start = src.indexOf('/** Precomputed FFT tables');
const end = src.indexOf('/**\n * Spectral-mask inference: the contract shared by both shipped models');

const fft = (() => {
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const body = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return { fftTables, fftInPlace, realFftForward, realFftInverse };`)();
})();

const N = 4096;
const HALF = N >> 1;
const BINS = HALF + 1;

/** Deterministic broadband frame — tonal content plus a little noise. */
function makeFrame(seed = 1) {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff - 0.5;
  };
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    x[i] = Math.sin(i * 0.037) * 0.7 + Math.cos(i * 0.31) * 0.2 + rand() * 0.05;
  }
  return x;
}

/** Full complex forward transform of a real frame (the previous behaviour). */
function referenceForward(x) {
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  re.set(x);
  fft.fftInPlace(re, im, false);
  return { re, im };
}

describe('MLWorker real-input FFT', () => {
  test('forward matches the full complex transform for bins 0..N/2', () => {
    const x = makeFrame();
    const ref = referenceForward(x);
    const re = new Float32Array(BINS);
    const im = new Float32Array(BINS);
    fft.realFftForward(x, N, re, im, 0, new Float32Array(HALF), new Float32Array(HALF));

    let peak = 0;
    let maxErr = 0;
    for (let k = 0; k < BINS; k++) {
      peak = Math.max(peak, Math.hypot(ref.re[k], ref.im[k]));
      maxErr = Math.max(maxErr, Math.abs(re[k] - ref.re[k]), Math.abs(im[k] - ref.im[k]));
    }
    expect(peak).toBeGreaterThan(1);
    expect(maxErr / peak).toBeLessThan(1e-5);
  });

  test('DC and Nyquist bins are real', () => {
    const re = new Float32Array(BINS);
    const im = new Float32Array(BINS);
    fft.realFftForward(makeFrame(7), N, re, im, 0, new Float32Array(HALF), new Float32Array(HALF));
    expect(im[0]).toBe(0);
    expect(im[HALF]).toBe(0);
  });

  test('writes at the requested destination offset', () => {
    const x = makeFrame(3);
    const flat = new Float32Array(BINS * 2);
    const flatIm = new Float32Array(BINS * 2);
    const solo = new Float32Array(BINS);
    const soloIm = new Float32Array(BINS);
    fft.realFftForward(x, N, flat, flatIm, BINS, new Float32Array(HALF), new Float32Array(HALF));
    fft.realFftForward(x, N, solo, soloIm, 0, new Float32Array(HALF), new Float32Array(HALF));
    for (let k = 0; k < BINS; k++) {
      expect(flat[BINS + k]).toBe(solo[k]);
      expect(flatIm[BINS + k]).toBe(soloIm[k]);
      expect(flat[k]).toBe(0);
    }
  });

  test('forward → inverse round-trips the original frame', () => {
    const x = makeFrame(11);
    const re = new Float32Array(BINS);
    const im = new Float32Array(BINS);
    const hr = new Float32Array(HALF);
    const hi = new Float32Array(HALF);
    fft.realFftForward(x, N, re, im, 0, hr, hi);
    const out = new Float32Array(N);
    fft.realFftInverse(re, im, N, out, hr, hi);
    for (let i = 0; i < N; i++) expect(out[i]).toBeCloseTo(x[i], 5);
  });

  test('inverse matches mirroring + full complex inverse after a per-bin mask', () => {
    const x = makeFrame(23);
    const ref = referenceForward(x);

    // Arbitrary real per-bin gains — exactly what the fused mask applies.
    const gain = new Float32Array(BINS);
    for (let k = 0; k < BINS; k++) gain[k] = ((k * 37) % 100) / 83;

    // Previous behaviour: mask, rebuild the conjugate half, inverse over N.
    const mRe = new Float32Array(N);
    const mIm = new Float32Array(N);
    for (let k = 0; k < BINS; k++) {
      mRe[k] = ref.re[k] * gain[k];
      mIm[k] = ref.im[k] * gain[k];
    }
    for (let k = BINS; k < N; k++) {
      mRe[k] = mRe[N - k];
      mIm[k] = -mIm[N - k];
    }
    fft.fftInPlace(mRe, mIm, true);

    const hr = new Float32Array(HALF);
    const hi = new Float32Array(HALF);
    const re = new Float32Array(BINS);
    const im = new Float32Array(BINS);
    fft.realFftForward(x, N, re, im, 0, hr, hi);
    for (let k = 0; k < BINS; k++) {
      re[k] *= gain[k];
      im[k] *= gain[k];
    }
    const out = new Float32Array(N);
    fft.realFftInverse(re, im, N, out, hr, hi);

    let peak = 0;
    let maxErr = 0;
    for (let i = 0; i < N; i++) {
      peak = Math.max(peak, Math.abs(mRe[i]));
      maxErr = Math.max(maxErr, Math.abs(out[i] - mRe[i]));
    }
    expect(peak).toBeGreaterThan(0.01);
    expect(maxErr / peak).toBeLessThan(1e-4);
  });

  test('fused chain no longer mirrors the negative half before the iSTFT', () => {
    expect(src).toContain('realFftForward(frame, N, buf.batchRe, buf.batchIm, off, halfRe, halfIm)');
    expect(src).toContain('realFftInverse(re, im, N, frame, halfRe, halfIm)');
    expect(src).not.toMatch(/for \(let k = bins; k < N; k\+\+\) \{\s*\n\s*re\[k\] = re\[N - k\];/);
  });
});
