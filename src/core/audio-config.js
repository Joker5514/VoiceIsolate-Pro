/**
 * VoiceIsolate Pro — Audio Configuration (Layer 1: Core)
 *
 * Single source of truth for the canonical sample rate and DSP constants.
 * Pure data module: no DOM, no Web Audio, no I/O, no side effects.
 * Importable from Node, Web Workers, and the browser alike.
 */
'use strict';

/** Canonical processing sample rate. ALL stems are resampled to this. */
export const SAMPLE_RATE = 48000;

/** Maximum channels carried through the pipeline (stereo). */
export const MAX_CHANNELS = 2;

/** Render quantum of the Web Audio API (fixed by spec). Alias: QUANTUM in ring-buffer-constants. */
export const RENDER_QUANTUM = 128;

/** STFT frame size used by frame-based models (e.g. DeepFilterNet). */
export const FRAME_SIZE = 2048;

/** Hop size between successive frames (75% overlap). Must be integer multiple of RENDER_QUANTUM. */
export const HOP_SIZE = 512;

export {
  QUANTUM,
  FFT_SIZE_LIVE,
  FFT_SIZE_CREATOR,
  QUANTA_PER_HOP,
  validateRingBufferConstants,
} from './ring-buffer-constants.js';

/** Segment length, in samples, for waveform-domain models (MDX-Net). 8 s. */
export const SEGMENT_SAMPLES = SAMPLE_RATE * 8;

/** Overlap, in samples, between successive inference segments (1 s). */
export const SEGMENT_OVERLAP = SAMPLE_RATE;

/** Time constant (seconds) for AudioParam.setTargetAtTime slider smoothing. */
export const PARAM_SMOOTHING = 0.03;

/** Buffer sizes pre-allocated by BufferPool (see BufferPool.js). */
export const POOL_BUFFER_SIZES = Object.freeze([RENDER_QUANTUM, FRAME_SIZE, 4096]);

/**
 * Verify a (Base)AudioContext runs at the canonical rate. Browsers may open
 * the hardware context at 44.1 kHz; that is fine for playback, but every
 * buffer fed to the ML pipeline must be SAMPLE_RATE. We warn (not throw) so
 * playback still works while making the mismatch loud and visible.
 *
 * @param {{ sampleRate: number }} audioContext
 * @param {(msg: string) => void} [warn] injectable for tests; defaults to console.warn
 * @returns {boolean} true when the context matches SAMPLE_RATE
 */
export function verifyContextSampleRate(audioContext, warn = console.warn) {
  if (!audioContext || typeof audioContext.sampleRate !== 'number') {
    warn('[VIP][audio-config] verifyContextSampleRate: invalid AudioContext.');
    return false;
  }
  if (audioContext.sampleRate !== SAMPLE_RATE) {
    warn(
      `[VIP][audio-config] AudioContext runs at ${audioContext.sampleRate} Hz, ` +
      `canonical rate is ${SAMPLE_RATE} Hz. Playback is unaffected, but all ` +
      'pipeline buffers MUST be resampled via FileIngestion before inference.'
    );
    return false;
  }
  return true;
}

/**
 * Convert a sample count at an arbitrary rate to the equivalent count at the
 * canonical SAMPLE_RATE (used to size OfflineAudioContext for resampling).
 *
 * @param {number} length  sample frames at sourceRate
 * @param {number} sourceRate
 * @returns {number} sample frames at SAMPLE_RATE
 */
export function resampledLength(length, sourceRate) {
  if (!Number.isFinite(length) || !Number.isFinite(sourceRate) || sourceRate <= 0) {
    throw new RangeError('[VIP][audio-config] resampledLength: invalid arguments.');
  }
  return Math.round(length * (SAMPLE_RATE / sourceRate));
}
