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
 * How long a single yield waits for requestAnimationFrame before falling back
 * to a plain macrotask. Two 60 Hz frames — long enough that a healthy frame
 * always wins the race, short enough that a throttled one cannot stall DSP.
 */
const RAF_GUARD_MS = 34;

/** Latched once rAF misses the guard, so a throttled window yields via macrotask. */
let rafUnreliable = false;
let visibilityRearmBound = false;

/**
 * Clear the rAF latch when the page becomes visible again.
 *
 * The latch exists so an occluded window does not pay the guard delay on every
 * yield, but it is module state shared by Landing and Engineer: without this,
 * one transient stall would disable paint alignment for the rest of the page
 * session, including every later file and Process run. Bound lazily, and only
 * when a document exists, so this module stays side-effect free in workers.
 */
function rearmRafOnVisibility() {
  if (visibilityRearmBound) return;
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  visibilityRearmBound = true;
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) rafUnreliable = false;
  });
}

/**
 * True only on a real browser main thread.
 *
 * `window === globalThis` holds in a browser but not under jsdom (where tests
 * assign a window object onto Node's global), and `window` is undefined in
 * workers and in Node. That distinction matters below: it is exactly the
 * context where hidden-page timer clamping applies, and the only one where a
 * persistent MessagePort is safe.
 */
const isBrowserMainThread = typeof window !== 'undefined'
  && typeof document !== 'undefined'
  && window === globalThis
  && typeof MessageChannel === 'function';

/** Single reusable channel; one per yield would allocate thousands per file. */
let macrotaskPort = null;
const macrotaskQueue = [];

/**
 * Run a macrotask checkpoint so queued timers, input and Cancel can run.
 *
 * On a browser main thread this uses MessageChannel rather than setTimeout:
 * hidden pages clamp timers to roughly one second, which would turn every
 * cooperative yield in a background tab into a one-second stall — the same
 * freeze this file exists to prevent, just slower instead of infinite.
 * postMessage is not clamped that way.
 *
 * Everywhere else (Node, tests, workers) the plain timer is used. A live
 * MessagePort keeps Node's event loop referenced, so doing this unconditionally
 * stops the process from ever exiting — it hangs `pnpm test:ci` outright.
 */
function macrotask() {
  if (isBrowserMainThread) {
    if (!macrotaskPort) {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { macrotaskQueue.shift()?.(); };
      macrotaskPort = channel.port2;
    }
    return new Promise((resolve) => {
      macrotaskQueue.push(resolve);
      macrotaskPort.postMessage(0);
    });
  }
  return new Promise((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}

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
export async function yieldToBrowser() {
  // Chromium: scheduler.yield() continuations can outrank an already queued
  // timer. Follow it with a macrotask checkpoint so Cancel/input/timers run
  // before a long chunk loop resumes.
  if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') {
    await scheduler.yield();
    await macrotask();
    return;
  }
  // requestAnimationFrame is throttled to 0 Hz in a hidden tab and in an
  // occluded window, and never fires at all in a worker. Waiting on it alone
  // deadlocks the caller: post-ML finalization and envelope builds would stall
  // until the tab is foregrounded, which the landing watchdog then reports as
  // "the worker stopped responding". A macrotask always runs, so rAF is only
  // ever used as an optional paint alignment that a guard timer can outrun.
  const hidden = typeof document !== 'undefined' && document.hidden === true;
  if (rafUnreliable || hidden
    || typeof requestAnimationFrame !== 'function'
    || typeof setTimeout !== 'function') {
    return macrotask();
  }

  const painted = await new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(ok);
    };
    const guard = setTimeout(() => finish(false), RAF_GUARD_MS);
    requestAnimationFrame(() => finish(true));
  });
  // Latch after the first miss so an occluded window (document.hidden stays
  // false) does not pay the guard delay on every subsequent yield. Plain
  // macrotask yields stay correct and responsive, just not paint-aligned.
  // The latch is cleared again the next time the page becomes visible.
  if (!painted) {
    rafUnreliable = true;
    rearmRafOnVisibility();
  }

  return macrotask();
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
