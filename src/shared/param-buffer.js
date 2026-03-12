// src/shared/param-buffer.js
// Central parameter index registry — imported by main.js, dsp-processor.js, and worker-pool.js

export const PARAMS = {
  NOISE_REDUCTION:  0,
  VOICE_ISOLATION:  1,
  VOLUME_GAIN:      2,
  WORKLET_READY:    3,
  NOISE_FLOOR_BIAS: 4,
};
export const PARAM_COUNT = Object.keys(PARAMS).length;

/**
 * Allocates the SharedArrayBuffer used by all threads.
 * Call ONCE in main.js, then pass the .buffer to all Workers and the AudioWorklet.
 */
export function createParamBuffer() {
  const sab = new SharedArrayBuffer(PARAM_COUNT * Float32Array.BYTES_PER_ELEMENT);
  const buf = new Float32Array(sab);
  // Defaults
  buf[PARAMS.NOISE_REDUCTION]  = 0.5;
  buf[PARAMS.VOICE_ISOLATION]  = 0.5;
  buf[PARAMS.VOLUME_GAIN]      = 0.7;
  buf[PARAMS.WORKLET_READY]    = 0.0;
  buf[PARAMS.NOISE_FLOOR_BIAS] = 1.5;
  return buf;
}

// ── Mapping helpers (UI → DSP scale) ─────────────────────────────────────────

/** Volume slider 0–1 → linear gain (via dB scale) */
export const gainMap = (s, dbMin = -60, dbMax = 6) =>
  s <= 0 ? 0 : Math.pow(10, (dbMin + s * (dbMax - dbMin)) / 20);

/** Frequency slider 0–1 → Hz (exponential) */
export const freqMap = (s, fMin = 20, fMax = 20000) =>
  fMin * Math.pow(fMax / fMin, Math.max(0, Math.min(1, s)));

/** Threshold / ratio slider 0–1 → square-root (perceptual mid-range precision) */
export const sqrtMap = (s) => Math.sqrt(Math.max(0, s));
