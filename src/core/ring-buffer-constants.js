/**
 * VoiceIsolate Pro — Ring-Buffer Constants (Layer 1: Core)
 *
 * Codified per Master Blueprint v2.1 §III. HOP_SIZE must be an integer
 * multiple of the AudioWorklet quantum (128 samples). QUANTA_PER_HOP must
 * be an integer — overlap-add accumulates exactly that many quanta before
 * advancing the FFT hop.
 *
 * Pure module: no DOM, no Web Audio, no I/O.
 */
'use strict';

/** AudioWorklet render quantum (fixed by Web Audio spec). */
export const QUANTUM = 128;

/** Live-mode FFT size — smaller for <80–100 ms target latency. */
export const FFT_SIZE_LIVE = 1024;

/** Creator / Forensic FFT size — higher frequency resolution. */
export const FFT_SIZE_CREATOR = 4096;

/** Hop size between successive frames (75% overlap when FFT = 4 × HOP). */
export const HOP_SIZE = 512;

/** Integer number of AudioWorklet quanta per hop — must divide evenly. */
export const QUANTA_PER_HOP = HOP_SIZE / QUANTUM;

/** Default cosine-similarity threshold for ECAPA-TDNN speaker masking. */
export const SPEAKER_COSINE_THRESHOLD_DEFAULT = 0.75;

/** EMA smoothing factor for session-scoped speaker embedding updates. */
export const SPEAKER_EMBEDDING_EMA_ALPHA = 0.05;

/** Minimum enrollment duration (seconds) at SNR > 10 dB. */
export const SPEAKER_ENROLLMENT_MIN_SECONDS = 3;

/** Minimum enrollment SNR (dB). */
export const SPEAKER_ENROLLMENT_MIN_SNR_DB = 10;

/** Typical multiplicative mask floor in dB (prevents total target erasure). */
export const MASK_FLOOR_DB = -30;

/**
 * @typedef {'live' | 'creator' | 'forensic'} ProcessingMode
 */

/**
 * Resolve FFT size for a processing mode.
 * @param {ProcessingMode} [mode='live']
 * @returns {number}
 */
export function fftSizeForMode(mode = 'live') {
  if (mode === 'creator' || mode === 'forensic') return FFT_SIZE_CREATOR;
  return FFT_SIZE_LIVE;
}

/**
 * Validate ring-buffer / overlap-add constants. Throws on violation.
 * @param {object} [opts]
 * @param {number} [opts.quantum=QUANTUM]
 * @param {number} [opts.hopSize=HOP_SIZE]
 * @param {number} [opts.fftSize=FFT_SIZE_LIVE]
 * @returns {{ quantum: number, hopSize: number, fftSize: number, quantaPerHop: number }}
 */
export function validateRingBufferConstants(opts = {}) {
  const quantum = opts.quantum ?? QUANTUM;
  const hopSize = opts.hopSize ?? HOP_SIZE;
  const fftSize = opts.fftSize ?? FFT_SIZE_LIVE;

  if (!Number.isInteger(quantum) || quantum <= 0) {
    throw new RangeError('[VIP][ring-buffer] quantum must be a positive integer.');
  }
  if (!Number.isInteger(hopSize) || hopSize <= 0) {
    throw new RangeError('[VIP][ring-buffer] hopSize must be a positive integer.');
  }
  if (hopSize % quantum !== 0) {
    throw new RangeError(
      `[VIP][ring-buffer] HOP_SIZE (${hopSize}) must be an integer multiple of QUANTUM (${quantum}).`
    );
  }
  const quantaPerHop = hopSize / quantum;
  if (!Number.isInteger(quantaPerHop)) {
    throw new RangeError('[VIP][ring-buffer] QUANTA_PER_HOP must be an integer.');
  }
  if (fftSize < hopSize) {
    throw new RangeError('[VIP][ring-buffer] fftSize must be >= hopSize.');
  }
  if ((fftSize & (fftSize - 1)) !== 0) {
    throw new RangeError('[VIP][ring-buffer] fftSize must be a power of two.');
  }

  return { quantum, hopSize, fftSize, quantaPerHop };
}