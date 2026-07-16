/**
 * Time-budgeted main-thread yields — keep the UI alive without slowing bulk work.
 */
'use strict';

/** Minimum ms between yields during long CPU-bound loops. */
export const YIELD_BUDGET_MS = 12;

/** Above this sample count, bulk copies may use budgeted chunking. */
export const LARGE_CHANNEL_SAMPLES = 48000 * 300; // 5 min @ 48 kHz

/** Chunk size when budgeted copying is used (~30 s of audio). */
export const COPY_CHUNK_SAMPLES = 48000 * 30;

/**
 * Yield to the browser so paint/input can run (rAF + macrotask).
 * Prefer this over bare setTimeout(0) during multi-second DSP.
 * @returns {Promise<void>}
 */
export function yieldToBrowser() {
  return new Promise((resolve) => {
    const done = () => {
      if (typeof setTimeout === 'function') setTimeout(resolve, 0);
      else resolve();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(done);
    else done();
  });
}

/**
 * @param {number} [intervalMs]
 * @returns {() => Promise<void>}
 */
export function createYieldBudget(intervalMs = YIELD_BUDGET_MS) {
  let last = typeof performance !== 'undefined' ? performance.now() : 0;
  return async function maybeYield() {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - last < intervalMs) return;
    last = now;
    await yieldToBrowser();
  };
}

/**
 * Fast typed-array copy; only chunks on very long clips.
 * @param {Float32Array} src
 * @param {{ yieldBudget?: () => Promise<void>, largeThreshold?: number }} [opts]
 */
export async function copyFloat32Channel(src, opts = {}) {
  const {
    yieldBudget = null,
    largeThreshold = LARGE_CHANNEL_SAMPLES,
  } = opts;
  if (!src?.length) return new Float32Array(0);
  if (src.length <= largeThreshold || !yieldBudget) return src.slice();

  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += COPY_CHUNK_SAMPLES) {
    const end = Math.min(src.length, i + COPY_CHUNK_SAMPLES);
    out.set(src.subarray(i, end), i);
    if (end < src.length) await yieldBudget();
  }
  return out;
}

export default { createYieldBudget, copyFloat32Channel, yieldToBrowser, YIELD_BUDGET_MS };