/**
 * VoiceIsolate Pro — Click / discontinuity hardening (Layer 1: Core)
 *
 * Shared utilities for detecting amplitude discontinuities and applying short
 * equal-power / linear crossfades. Pure math — no DOM, no Web Audio, no I/O.
 *
 * Used by:
 *   • Offline Pass-1 click removal follow-up
 *   • Target-speaker gain curves
 *   • Segment / process boundary edge fades
 *   • Regression tests for residual pops
 */
'use strict';

/**
 * Maximum absolute first-difference |x[i] − x[i−1]| over the buffer.
 * Large values at segment boundaries correlate with audible clicks.
 * @param {Float32Array|number[]} samples
 * @param {{ start?: number, end?: number }} [range]
 * @returns {number}
 */
export function maxAbsDelta(samples, range = {}) {
  if (!samples || samples.length < 2) return 0;
  const start = Math.max(1, range.start | 0);
  const end = Math.min(samples.length, range.end == null ? samples.length : range.end | 0);
  let max = 0;
  for (let i = start; i < end; i++) {
    const d = Math.abs(samples[i] - samples[i - 1]);
    if (d > max) max = d;
  }
  return max;
}

/**
 * Peak |x| over the buffer (or sub-range).
 * @param {Float32Array|number[]} samples
 * @param {{ start?: number, end?: number }} [range]
 * @returns {number}
 */
export function peakAbs(samples, range = {}) {
  if (!samples || !samples.length) return 0;
  const start = Math.max(0, range.start | 0);
  const end = Math.min(samples.length, range.end == null ? samples.length : range.end | 0);
  let peak = 0;
  for (let i = start; i < end; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * High-frequency energy proxy via first-difference energy / signal energy.
 * Spikes after repair often elevate this ratio near boundaries.
 * @param {Float32Array|number[]} samples
 * @returns {number} ratio in [0, ∞)
 */
export function hfEnergyRatio(samples) {
  if (!samples || samples.length < 2) return 0;
  let e = 0;
  let d = 0;
  for (let i = 0; i < samples.length; i++) e += samples[i] * samples[i];
  for (let i = 1; i < samples.length; i++) {
    const diff = samples[i] - samples[i - 1];
    d += diff * diff;
  }
  return e > 1e-20 ? d / e : 0;
}

/**
 * In-place linear fade-in / fade-out at buffer edges (process boundaries).
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number} [fadeMs=8]
 * @returns {Float32Array}
 */
export function applyEdgeFades(samples, sampleRate, fadeMs = 8) {
  if (!samples || samples.length < 4) return samples;
  const nFade = Math.max(1, Math.min(
    Math.floor(samples.length / 4),
    Math.round((fadeMs / 1000) * (sampleRate || 48000)),
  ));
  for (let i = 0; i < nFade; i++) {
    const g = i / nFade;
    samples[i] *= g;
    samples[samples.length - 1 - i] *= g;
  }
  return samples;
}

/**
 * Equal-power crossfade of two mono buffers of equal length into `out`.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @param {Float32Array} [out]
 * @returns {Float32Array}
 */
export function equalPowerCrossfade(a, b, out) {
  const n = Math.min(a.length, b.length);
  const dest = out && out.length >= n ? out : new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = n <= 1 ? 1 : i / (n - 1);
    const wa = Math.cos(t * Math.PI * 0.5);
    const wb = Math.sin(t * Math.PI * 0.5);
    dest[i] = a[i] * wa + b[i] * wb;
  }
  return dest;
}

/**
 * Smooth a per-sample gain curve with a causal one-pole + optional anti-zip
 * equal-power style clamp on consecutive sample steps.
 *
 * @param {Float32Array} gain  raw gain [0..1+]
 * @param {number} sampleRate
 * @param {{ smoothMs?: number, maxStepPerMs?: number }} [opts]
 * @returns {Float32Array}
 */
export function smoothGainCurve(gain, sampleRate, opts = {}) {
  const n = gain?.length || 0;
  if (!n) return new Float32Array(0);
  const sr = sampleRate || 48000;
  const smoothMs = opts.smoothMs ?? 15;
  const tau = Math.max(1e-4, smoothMs / 1000);
  const coeff = Math.exp(-1 / (tau * sr));
  const maxStep = (opts.maxStepPerMs ?? 0.08) / (sr / 1000); // per sample
  const out = new Float32Array(n);
  let y = gain[0];
  out[0] = y;
  for (let i = 1; i < n; i++) {
    let target = gain[i];
    // One-pole toward target
    y = coeff * y + (1 - coeff) * target;
    // Hard rate limit (anti-zipper)
    const delta = y - out[i - 1];
    if (delta > maxStep) y = out[i - 1] + maxStep;
    else if (delta < -maxStep) y = out[i - 1] - maxStep;
    out[i] = y;
  }
  return out;
}

/**
 * OLA edge-safe normalize: divide by window² sum with a floor so edges do not
 * explode into clicks when only 1–2 frames overlap.
 * @param {Float32Array} out
 * @param {Float32Array} norm  window² accumulation
 * @param {number} [floorFrac=0.5] fraction of peak norm used as divisor floor
 */
export function olaNormalizeFloor(out, norm, floorFrac = 0.5) {
  let maxNorm = 0;
  for (let i = 0; i < norm.length; i++) {
    if (norm[i] > maxNorm) maxNorm = norm[i];
  }
  const floor = Math.max(1e-12, floorFrac * maxNorm);
  for (let i = 0; i < out.length; i++) {
    out[i] /= Math.max(norm[i], floor);
  }
  return out;
}

/**
 * COLA-safe hop for periodic Hann: only fft/4 (75%) or fft/2 (50%).
 * Never returns hop > fft/2 (zero-overlap causes frame-boundary clicks).
 *
 * @param {number} fftSize
 * @param {number} baseHop  model default hop (usually fft/4)
 * @param {number} desiredHop  speed-requested hop before clamping
 * @returns {number}
 */
export function colaSafeHop(fftSize, baseHop, desiredHop) {
  const fft = Math.max(64, fftSize | 0);
  const half = fft >> 1;
  const quarter = Math.max(1, fft >> 2);
  const base = Math.max(1, baseHop | 0);
  let hop = Math.max(base, desiredHop | 0);
  // Snap to power-of-two then clamp to COLA-safe set {fft/4, fft/2}.
  hop = 2 ** Math.round(Math.log2(Math.max(1, hop)));
  if (hop <= quarter) return quarter;
  return Math.min(half, Math.max(quarter, hop >= half ? half : quarter));
}

export default {
  maxAbsDelta,
  peakAbs,
  hfEnergyRatio,
  applyEdgeFades,
  equalPowerCrossfade,
  smoothGainCurve,
  olaNormalizeFloor,
  colaSafeHop,
};
