/**
 * VoiceIsolate Pro — Shared STFT math (Layer 1: Core)
 *
 * Single source of truth for analysis/synthesis windows, frame counting,
 * COLA diagnostics, and STFT geometry presets.
 *
 * Rules (see CLAUDE.md §1 + audit F-01/F-04/F-06/F-07):
 *   • Use PERIODIC Hann (denominator N, not N−1) for COLA at 75% overlap.
 *   • Prefer STFT_PRESETS instead of hard-coding N/H pairs in call sites.
 *   • frameCount() is the only allowed framing formula for offline STFT.
 *
 * Pure module: no DOM, no Web Audio, no I/O.
 */
'use strict';

// ─── Presets (geometry only — sample rate lives in audio-config) ─────────────

/**
 * Named STFT geometries used across the product.
 * Engineer desktop defaults to 75% overlap (flat w² COLA for periodic Hann).
 * Mobile speed may use 50% hop deliberately (higher hop-rate AM risk after masks).
 *
 * @type {Readonly<Record<string, { fftSize: number, hopSize: number, overlap: number, window: 'periodic-hann' }>>}
 */
export const STFT_PRESETS = Object.freeze({
  /** Engineer Mode default desktop isolation (speed + quality). */
  engineer: Object.freeze({
    fftSize: 2048,
    hopSize: 512,
    overlap: 0.75,
    window: 'periodic-hann',
  }),
  /** Whisper / forensic higher frequency resolution. */
  forensic: Object.freeze({
    fftSize: 4096,
    hopSize: 1024,
    overlap: 0.75,
    window: 'periodic-hann',
  }),
  /** Mobile WebView freeze mitigation — 50% hop is intentional. */
  engineerMobile: Object.freeze({
    fftSize: 1024,
    hopSize: 512,
    overlap: 0.5,
    window: 'periodic-hann',
  }),
  /** Universal Source Matrix + Creator spectral masks. */
  usm: Object.freeze({
    fftSize: 4096,
    hopSize: 1024,
    overlap: 0.75,
    window: 'periodic-hann',
  }),
  /** SpectralCleanup (NR + dereverb) — matches audio-config FRAME/HOP. */
  cleanup: Object.freeze({
    fftSize: 2048,
    hopSize: 512,
    overlap: 0.75,
    window: 'periodic-hann',
  }),
  /** Live ring-buffer class FFT (time-domain worklets still preferred). */
  live: Object.freeze({
    fftSize: 1024,
    hopSize: 512,
    overlap: 0.5,
    window: 'periodic-hann',
  }),
});

// ─── Window ──────────────────────────────────────────────────────────────────

const _hannCache = new Map();

/**
 * PERIODIC Hann window of length N.
 * w[i] = 0.5 * (1 - cos(2π i / N))
 *
 * Symmetric form (N−1) is forbidden here — it breaks COLA flatness contracts
 * used by DSPCore / fft-bridge (AUDIT-FIX #12 / #15).
 *
 * @param {number} N window length (positive integer)
 * @returns {Float32Array}
 */
export function periodicHann(N) {
  if (!Number.isInteger(N) || N < 2) {
    throw new RangeError(`[VIP][stft-math] periodicHann: N must be integer ≥ 2 (got ${N})`);
  }
  let w = _hannCache.get(N);
  if (w) return w;
  w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
  }
  _hannCache.set(N, w);
  return w;
}

/** Alias used by call sites that historically said hannWindow / makeHannWindow. */
export const hannWindow = periodicHann;
export const makeHannWindow = periodicHann;

/**
 * Squared periodic Hann table for OLA normalisation (∑ w²).
 * @param {number} N
 * @returns {Float32Array}
 */
export function periodicHannSq(N) {
  const w = periodicHann(N);
  const sq = new Float32Array(N);
  for (let i = 0; i < N; i++) sq[i] = w[i] * w[i];
  return sq;
}

// ─── Framing ─────────────────────────────────────────────────────────────────

/**
 * Number of STFT frames for a signal of length L with window N and hop H.
 * Matches DSPCore: floor((L − N) / H) + 1 when L ≥ N, else 0.
 *
 * @param {number} length sample count
 * @param {number} fftSize window / FFT size
 * @param {number} hopSize hop in samples
 * @returns {number}
 */
export function frameCount(length, fftSize, hopSize) {
  if (!Number.isFinite(length) || length < 0) return 0;
  if (!Number.isInteger(fftSize) || fftSize < 2) {
    throw new RangeError(`[VIP][stft-math] frameCount: invalid fftSize ${fftSize}`);
  }
  if (!Number.isInteger(hopSize) || hopSize < 1 || hopSize > fftSize) {
    throw new RangeError(`[VIP][stft-math] frameCount: invalid hopSize ${hopSize}`);
  }
  if (length < fftSize) return 0;
  return Math.floor((length - fftSize) / hopSize) + 1;
}

/**
 * Minimum PCM length that yields at least one full frame.
 * @param {number} fftSize
 * @returns {number}
 */
export function minSamplesForOneFrame(fftSize) {
  return fftSize;
}

/**
 * Zero-pad (or pass through) so length ≥ fftSize for a single-frame STFT.
 * @param {Float32Array} samples
 * @param {number} fftSize
 * @returns {Float32Array}
 */
export function padToMinFrame(samples, fftSize) {
  if (!(samples instanceof Float32Array) && !ArrayBuffer.isView(samples)) {
    throw new TypeError('[VIP][stft-math] padToMinFrame: samples must be a typed array');
  }
  if (samples.length >= fftSize) {
    return samples instanceof Float32Array ? samples : new Float32Array(samples);
  }
  const out = new Float32Array(fftSize);
  out.set(samples);
  return out;
}

// ─── Geometry helpers ────────────────────────────────────────────────────────

/**
 * Half-spectrum bin count for a real FFT of size N: N/2 + 1.
 * @param {number} fftSize
 * @returns {number}
 */
export function halfBins(fftSize) {
  return (fftSize >> 1) + 1;
}

/**
 * Bin center frequency in Hz.
 * @param {number} k bin index
 * @param {number} sampleRate
 * @param {number} fftSize
 * @returns {number}
 */
export function binHz(k, sampleRate, fftSize) {
  return (k * sampleRate) / fftSize;
}

/**
 * Overlap ratio 1 − H/N.
 * @param {number} fftSize
 * @param {number} hopSize
 * @returns {number}
 */
export function overlapRatio(fftSize, hopSize) {
  return 1 - hopSize / fftSize;
}

// ─── COLA diagnostics ────────────────────────────────────────────────────────

/**
 * Steady-state COLA envelope of analysis×synthesis windows (same window twice).
 * Evaluates ∑_k w[n − kH]² over hops that cover the window support.
 *
 * @param {Float32Array|number[]} window
 * @param {number} hopSize
 * @returns {{ min: number, max: number, mean: number, ripple: number, cola: Float32Array }}
 */
export function colaEnvelope(window, hopSize) {
  const N = window.length;
  if (!Number.isInteger(hopSize) || hopSize < 1 || hopSize > N) {
    throw new RangeError(`[VIP][stft-math] colaEnvelope: invalid hopSize ${hopSize}`);
  }
  const cola = new Float32Array(N);
  // Hops that can contribute energy into [0, N)
  const kMin = -Math.ceil(N / hopSize) - 1;
  const kMax = Math.ceil(N / hopSize) + 1;
  for (let k = kMin; k <= kMax; k++) {
    for (let n = 0; n < N; n++) {
      const idx = n - k * hopSize;
      if (idx >= 0 && idx < N) {
        const wv = window[idx];
        cola[n] += wv * wv;
      }
    }
  }
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (let n = 0; n < N; n++) {
    const v = cola[n];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = sum / N;
  const mid = (max + min) / 2 || 1;
  const ripple = (max - min) / mid;
  return { min, max, mean, ripple, cola };
}

/**
 * Assert COLA ripple is below a threshold (for tests / validate scripts).
 * @param {number} fftSize
 * @param {number} hopSize
 * @param {number} [maxRipple=1e-3]
 * @returns {{ ok: boolean, ripple: number, min: number, max: number }}
 */
export function checkColaFlat(fftSize, hopSize, maxRipple = 1e-3) {
  const { min, max, ripple } = colaEnvelope(periodicHann(fftSize), hopSize);
  return { ok: ripple <= maxRipple, ripple, min, max };
}

/**
 * Soft real-valued mask application on complex bins (magnitude path).
 * Y = M ⊙ |X| e^{j∠X} implemented as scale of re/im by M.
 *
 * @param {Float32Array} re
 * @param {Float32Array} im
 * @param {Float32Array|number[]} mask length ≥ bins used
 * @param {number} bins half-spectrum length
 */
export function applySoftMask(re, im, mask, bins) {
  const n = Math.min(bins, mask.length, re.length, im.length);
  for (let k = 0; k < n; k++) {
    let m = mask[k];
    if (!Number.isFinite(m) || m < 0) m = 0;
    else if (m > 1) m = 1;
    re[k] *= m;
    im[k] *= m;
  }
}

/**
 * Resolve Engineer STFT geometry from mode flags (mirrors app.js policy).
 * @param {{ forensic?: boolean, mobile?: boolean }} [opts]
 * @returns {{ fftSize: number, hopSize: number, overlap: number, window: string, preset: string }}
 */
export function engineerStftGeometry(opts = {}) {
  const forensic = !!opts.forensic;
  const mobile = !!opts.mobile;
  if (forensic && mobile) {
    return { ...STFT_PRESETS.engineer, fftSize: 2048, hopSize: 512, preset: 'forensic-mobile' };
  }
  if (forensic) {
    return { ...STFT_PRESETS.forensic, preset: 'forensic' };
  }
  if (mobile) {
    return { ...STFT_PRESETS.engineerMobile, preset: 'engineerMobile' };
  }
  return { ...STFT_PRESETS.engineer, preset: 'engineer' };
}
