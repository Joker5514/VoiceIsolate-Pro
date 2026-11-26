#!/usr/bin/env node
'use strict';
/**
 * DSP-02 guard calibration (scratch — do not ship).
 *
 * Computes the fricative-detection features per frame on the fixture
 * mixes (speech + controls) so the guard thresholds can be set with a
 * measured margin, not guessed:
 *   hfRatio  = E(3.5-9 kHz) / (E(3.5-9 kHz) + E(0.3-3.4 kHz))
 *   flatness = geomean/mean of power in 3.5-9 kHz
 *   vowelE   = mean power in 0.3-3.4 kHz (absolute, STFT units)
 * Frames are the worker's geometry: N=4096, hop=1024, Hann window.
 * Prints per-fixture means over the annotated fricative samples, over
 * vowel samples, and over control samples.
 */
const { buildFricativeFixtures } = require('./fricative-fixtures.cjs');

const SR = 48000;
const N = 4096;
const HOP = 1024;
const BIN_HZ = SR / N;

function hann(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}
const WIN = hann(N);

// Minimal DFT magnitudes via naive Goertzel per bin is too slow; use the
// metrics fft (real FFT, Float64). Reuse scripts/quality/lib/metrics.cjs.
const M = require('./lib/metrics.cjs');

function frameMags(signal, start) {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = start + i < signal.length ? signal[start + i] : 0;
    re[i] = s * WIN[i];
  }
  M.fft(re, im);
  const bins = N / 2 + 1;
  const mags = new Float64Array(bins);
  for (let k = 0; k < bins; k++) mags[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  return mags;
}

function features(mags) {
  const kHf0 = Math.ceil(3500 / BIN_HZ);
  const kHf1 = Math.floor(9000 / BIN_HZ);
  const kSp0 = Math.ceil(300 / BIN_HZ);
  const kSp1 = Math.floor(3400 / BIN_HZ);
  let eHf = 0; let eSp = 0; let logSum = 0; let nHf = 0;
  let maxSp = 0;
  for (let k = kHf0; k <= kHf1; k++) {
    const p = mags[k] * mags[k] + 1e-20;
    eHf += p;
    logSum += Math.log(p);
    nHf++;
  }
  for (let k = kSp0; k <= kSp1; k++) {
    const p = mags[k] * mags[k];
    eSp += p;
    if (p > maxSp) maxSp = p;
  }
  const meanPow = eHf / Math.max(1, nHf);
  const geoPow = Math.exp(logSum / Math.max(1, nHf));
  const meanSp = eSp / Math.max(1, kSp1 - kSp0 + 1);
  return {
    hfRatio: eHf / (eHf + eSp + 1e-20),
    flatness: geoPow / (meanPow + 1e-20),
    vowelE: meanSp,
    hfE: meanPow,
    // Harmonic peakiness of the speech band: vowels are peaky (formants +
    // harmonics stick far above the band mean); broadband noise is flat.
    peakiness: maxSp / (meanSp + 1e-20),
  };
}

function main() {
  const fixtures = buildFricativeFixtures();
  for (const fx of fixtures) {
    // Frames overlapping the fricative samples, vowel samples, and (for
    // controls) the control samples.
    const stats = { fric: [], vowel: [], other: [] };
    for (let start = 0; start + N <= fx.mix.length; start += HOP) {
      const mid = start + N / 2;
      const f = features(frameMags(fx.mix, start));
      if (fx.fricMask[mid]) stats.fric.push(f);
      else if (fx.speechMask[mid]) stats.vowel.push(f);
      else stats.other.push(f);
    }
    const mean = (arr, k) => arr.length ? arr.reduce((a, x) => a + x[k], 0) / arr.length : NaN;
    const fmt = (arr, k) => (arr.length ? mean(arr, k).toFixed(3) : '  -  ');
    console.log(
      `${fx.id.padEnd(18)} fric: hfRatio=${fmt(stats.fric, 'hfRatio')} peak=${fmt(stats.fric, 'peakiness')} vowelE=${fmt(stats.fric, 'vowelE')} | vowel: hfRatio=${fmt(stats.vowel, 'hfRatio')} peak=${fmt(stats.vowel, 'peakiness')} vowelE=${fmt(stats.vowel, 'vowelE')} | other: n=${stats.other.length}`,
    );
  }
}

main();
