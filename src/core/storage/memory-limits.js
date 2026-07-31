/**
 * Memory / crash-safety limits for browser + Android WebView + Electron.
 * Prevents tab OOM from auto-restore, File copies, and durable stem packs.
 */
'use strict';

/** Auto-hydrate active library file into a live File only under this size. */
export const MAX_AUTO_RESTORE_BYTES = 64 * 1024 * 1024; // 64 MiB

/** Refuse durable stem packs larger than this (float storage). */
export const MAX_DURABLE_STEM_BYTES = 48 * 1024 * 1024; // 48 MiB pack

/** Max samples per mono stem channel for durable cache (~3 min @ 48 kHz). */
export const MAX_DURABLE_STEM_SAMPLES = 48000 * 180;

/** Prefer Blob+name over File constructor above this size (avoids full copy). */
export const MAX_FILE_CONSTRUCTOR_COPY_BYTES = 32 * 1024 * 1024; // 32 MiB

/** sessionStorage key: skip one auto-restore after a detected crash. */
export const CRASH_GUARD_KEY = 'vip-crash-guard';

/** Max simultaneous library tracks (canonical state each). */
export const MAX_LIBRARY_TRACKS = 5;

/**
 * @param {number} nClean
 * @param {number} nNoise
 * @param {number} length samples
 */
export function estimateStemPackBytes(nClean, nNoise, length) {
  return 20 + (nClean + nNoise) * length * 4;
}

/**
 * @param {number} samples
 * @param {number} [channels]
 */
export function estimatePcmBytes(samples, channels = 1) {
  return samples * channels * 4;
}

export default {
  MAX_AUTO_RESTORE_BYTES,
  MAX_DURABLE_STEM_BYTES,
  MAX_DURABLE_STEM_SAMPLES,
  MAX_FILE_CONSTRUCTOR_COPY_BYTES,
  CRASH_GUARD_KEY,
  estimateStemPackBytes,
  estimatePcmBytes,
};
