/**
 * Time-budgeted main-thread yields — keep the UI alive without slowing bulk work.
 *
 * Discipline:
 *  - Prefer scheduler.yield() when available (Chrome 115+ / modern Android WebView)
 *  - Fall back to rAF + macrotask so paint/input can run during STFT/DSP
 *  - Budgeted yields: yield at most once per interval (avoid thrashing)
 */
'use strict';

/** Default ms between yields during long CPU-bound loops (~1 frame @ 60 Hz). */
export const YIELD_BUDGET_MS = 16;

/** Mobile / low-end: yield slightly more often so WebView stays responsive. */
export const YIELD_BUDGET_MOBILE_MS = 12;

/** Electron / desktop renderer: yield often enough to unstick 86–99% finalization. */
export const YIELD_BUDGET_DESKTOP_MS = 10;

/** Above this sample count, bulk copies may use budgeted chunking. */
export const LARGE_CHANNEL_SAMPLES = 48000 * 30; // 30 sec @ 48 kHz

/** Chunk size when budgeted copying is used (~20 s of audio). */
export const COPY_CHUNK_SAMPLES = 48000 * 20;

/**
 * @param {AbortSignal|null|undefined} signal
 * @throws {DOMException} AbortError when aborted
 */
export function throwIfAborted(signal) {
  if (!signal) return;
  if (signal.aborted) {
    const err = typeof DOMException !== 'undefined'
      ? new DOMException('Processing cancelled', 'AbortError')
      : Object.assign(new Error('Processing cancelled'), { name: 'AbortError' });
    throw err;
  }
}

/**
 * Bounded cooperative chunk runner for renderer-thread DSP finalization.
 * @param {object} opts
 * @param {number} opts.total
 * @param {number} [opts.chunkSize]
 * @param {AbortSignal} [opts.signal]
 * @param {(ratio: number) => void} [opts.onProgress] 0..1 within this loop
 * @param {(start: number, end: number) => void} opts.runChunk
 */
export async function processInChunks({
  total,
  chunkSize = 48000,
  signal = null,
  onProgress = null,
  runChunk,
}) {
  const n = Math.max(0, Number(total) || 0);
  if (!n || typeof runChunk !== 'function') return;
  const size = Math.max(1, Number(chunkSize) || 48000);
  for (let start = 0; start < n; start += size) {
    throwIfAborted(signal);
    const end = Math.min(n, start + size);
    runChunk(start, end);
    if (onProgress) onProgress(end / n);
    if (end < n) await yieldToBrowser();
  }
}

function isMobileShell() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/Android|Mobile/i.test(ua)) return true;
  try {
    const cap = typeof window !== 'undefined' ? window.Capacitor : null;
    if (cap?.isNativePlatform?.()) return true;
  } catch { /* ignore */ }
  return false;
}

/**
 * Yield to the browser so paint/input can run.
 * Prefer this over bare setTimeout(0) during multi-second DSP.
 * @returns {Promise<void>}
 */
export function yieldToBrowser() {
  // Chromium: cooperative scheduling (best for not freezing tabs).
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    return scheduler.yield();
  }
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
export function createYieldBudget(intervalMs) {
  let defaultMs = YIELD_BUDGET_MS;
  try {
    if (isMobileShell()) defaultMs = YIELD_BUDGET_MOBILE_MS;
    else if (typeof globalThis !== 'undefined' && globalThis.vipDesktop) {
      defaultMs = YIELD_BUDGET_DESKTOP_MS;
    }
  } catch { /* ignore */ }
  const budget = Math.max(4, Number(intervalMs) || defaultMs);
  let last = typeof performance !== 'undefined' ? performance.now() : 0;
  return async function maybeYield() {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (now - last < budget) return;
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

export default {
  createYieldBudget,
  copyFloat32Channel,
  yieldToBrowser,
  throwIfAborted,
  processInChunks,
  YIELD_BUDGET_MS,
  YIELD_BUDGET_MOBILE_MS,
  YIELD_BUDGET_DESKTOP_MS,
};
