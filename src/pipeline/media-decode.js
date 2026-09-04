'use strict';

import { SAMPLE_RATE } from '../core/audio-config.js';
import { inferMediaKind } from '../core/media-types.js';

/** Minimum capture timeout — long files scale beyond this. */
const MEDIA_DECODE_MIN_TIMEOUT_MS = 120_000;
const AUDIO_DATA_DECODE_MIN_TIMEOUT_MS = 60_000;
const AUDIO_DATA_DECODE_MAX_TIMEOUT_MS = 180_000;
const FILE_READ_MIN_TIMEOUT_MS = 30_000;
const MEDIA_PLAY_TIMEOUT_MS = 15_000;
const AUDIO_CONTEXT_RESUME_TIMEOUT_MS = 10_000;
/** Below 64 MiB a single arrayBuffer() read is faster than streaming chunks. */
const FAST_READ_BYTES = 64 * 1024 * 1024;
/** Yield during streaming reads at most every N bytes. */
const STREAM_YIELD_BYTES = 8 * 1024 * 1024;
/** Target media-element capture rate (16× is widely supported). */
const MAX_CAPTURE_PLAYBACK_RATE = 16;
// ScriptProcessorNode block size — must be a power-of-two 256–16384.
const SPN_BLOCK_SIZE = 8192;
let sharedPrimaryContext = null;
let sharedRetryContext = null;
let sharedContextCleanupHooked = false;

function createAbortError() {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Decode cancelled', 'AbortError')
    : Object.assign(new Error('Decode cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function createTimeoutError(message, code) {
  const error = new Error(message);
  error.name = 'TimeoutError';
  error.code = code;
  return error;
}

function adaptiveTimeout(blob, override, minimum) {
  if (Number.isFinite(override) && override > 0) return Number(override);
  const sizeMiB = Math.max(0, Number(blob?.size || 0) / (1024 * 1024));
  return Math.min(
    AUDIO_DATA_DECODE_MAX_TIMEOUT_MS,
    Math.max(minimum, minimum + Math.ceil(sizeMiB) * 1000),
  );
}

function isTerminalOperationError(error) {
  return error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || /_TIMEOUT$/.test(String(error?.code || ''));
}

/** Settle exactly once and detach timer/signal hooks even if the browser API never returns. */
export function runBounded(operation, { timeoutMs, timeoutMessage, timeoutCode, signal, onStop } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer != null) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const stop = () => {
      try { onStop?.(); } catch { /* best-effort cancellation */ }
    };
    const onAbort = () => {
      stop();
      settle(() => reject(createAbortError()));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      stop();
      settle(() => reject(createTimeoutError(timeoutMessage, timeoutCode)));
    }, timeoutMs);

    let pending;
    try {
      pending = operation();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    Promise.resolve(pending).then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error)),
    );
  });
}

export async function resumeAudioContext(ctx, signal) {
  if (!ctx || ctx.state !== 'suspended') return;
  await runBounded(() => ctx.resume(), {
    timeoutMs: AUDIO_CONTEXT_RESUME_TIMEOUT_MS,
    timeoutMessage: '[VIP][FileIngestion] AudioContext resume timeout',
    timeoutCode: 'AUDIO_CONTEXT_RESUME_TIMEOUT',
    signal,
  });
}

function closeOwnedAudioContext(ctx) {
  try {
    const closing = ctx?.close?.();
    closing?.catch?.(() => {});
  } catch { /* already closed */ }
}

/** Keep at most two module-owned contexts, avoiding Chrome's context cap even if close() hangs. */
function getSharedAudioContext(Ctx, slot, options) {
  let ctx = slot === 'retry' ? sharedRetryContext : sharedPrimaryContext;
  if (!ctx || ctx.state === 'closed') {
    ctx = options ? new Ctx(options) : new Ctx();
    if (slot === 'retry') sharedRetryContext = ctx;
    else sharedPrimaryContext = ctx;
  }
  if (!sharedContextCleanupHooked && typeof globalThis.addEventListener === 'function') {
    sharedContextCleanupHooked = true;
    globalThis.addEventListener('pagehide', onSharedContextPageHide);
  }
  return ctx;
}

function onSharedContextPageHide(event) {
  if (event?.persisted) return;
  disposeSharedDecodeContexts();
}

export function disposeSharedDecodeContexts() {
  const contexts = new Set([sharedPrimaryContext, sharedRetryContext].filter(Boolean));
  sharedPrimaryContext = null;
  sharedRetryContext = null;
  if (sharedContextCleanupHooked && typeof globalThis.removeEventListener === 'function') {
    globalThis.removeEventListener('pagehide', onSharedContextPageHide);
  }
  sharedContextCleanupHooked = false;
  for (const ctx of contexts) closeOwnedAudioContext(ctx);
}

/**
 * Decode any supported blob to an AudioBuffer.
 *
 * Strategy:
 *   Video:
 *     1. Fast path  — decodeAudioData when the browser demuxes the full timeline
 *     2. Fallback   — accelerated media-element capture (up to 16× realtime)
 *   Audio:
 *     1. Fast path  — decodeAudioData (PCM/WAV/MP3/OGG/FLAC)
 *     2. Fallback   — accelerated media-element capture
 *
 * @param {Blob|File} blob
 * @param {object} [hooks]
 * @param {(percent: number) => void} [hooks.onProgress] 0–100 during decode
 * @param {AudioContext} [hooks.audioContext] Optional existing AudioContext to
 *   reuse — prevents browser AudioContext limit exhaustion on rapid re-uploads.
 * @param {AbortSignal} [hooks.signal] Cooperative cancellation signal.
 * @param {number} [hooks.decodeTimeoutMs] Optional decode deadline override.
 * @param {number} [hooks.readTimeoutMs] Optional file-read deadline override.
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeBlobToAudioBuffer(blob, hooks = {}) {
  const {
    onProgress = () => {},
    audioContext = null,
    signal = null,
    decodeTimeoutMs: decodeTimeoutOverride,
    readTimeoutMs: readTimeoutOverride,
  } = hooks;
  const kind = inferMediaKind(blob) || 'audio';
  const decodeTimeoutMs = adaptiveTimeout(blob, decodeTimeoutOverride, AUDIO_DATA_DECODE_MIN_TIMEOUT_MS);
  const readTimeoutMs = adaptiveTimeout(blob, readTimeoutOverride, FILE_READ_MIN_TIMEOUT_MS);
  if (signal?.aborted) throw createAbortError();

  if (kind === 'video') {
    try {
      const fast = await _decodeWithAudioData(blob, onProgress, audioContext, {
        decodeTimeoutMs,
        readTimeoutMs,
        signal,
      });
      if (!_likelyTruncatedDecode(blob, fast)) return fast;
    } catch (error) {
      if (isTerminalOperationError(error)) throw error;
      /* fall through to media-element capture */
    }
    return _decodeViaMediaElement(blob, kind, onProgress, audioContext, signal);
  }

  let primaryErr = null;
  try {
    return await _decodeWithAudioData(blob, onProgress, audioContext, {
      decodeTimeoutMs,
      readTimeoutMs,
      signal,
    });
  } catch (err) {
    if (isTerminalOperationError(err)) throw err;
    primaryErr = err;
  }

  try {
    // Must await — otherwise rejections bypass this catch and surface as
    // unhandled rejections, leaving upload UI stuck mid-decode.
    return await _decodeViaMediaElement(blob, kind, onProgress, audioContext, signal);
  } catch (fallbackErr) {
    if (isTerminalOperationError(fallbackErr)) throw fallbackErr;
    throw new Error(
      `[VIP][FileIngestion] Could not decode '${blob.name || 'file'}'. ` +
      `(Web Audio: ${primaryErr?.message ?? primaryErr}; ` +
      `media fallback: ${fallbackErr?.message ?? fallbackErr})`
    );
  }
}

// ---------------------------------------------------------------------------
// Blob read with progress (avoids a silent stall on large files)
// ---------------------------------------------------------------------------
async function readBlobWithProgress(blob, onProgress, { timeoutMs, signal } = {}) {
  const total = blob.size || 1;
  if (total <= FAST_READ_BYTES || typeof blob.stream !== 'function') {
    onProgress(15);
    const buf = await runBounded(() => blob.arrayBuffer(), {
      timeoutMs,
      timeoutMessage: '[VIP][FileIngestion] File read timeout',
      timeoutCode: 'FILE_READ_TIMEOUT',
      signal,
    });
    onProgress(45);
    return buf;
  }

  const reader = blob.stream().getReader();
  const out = new Uint8Array(total);
  let received = 0;
  try {
    await runBounded(async () => {
      onProgress(8);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (received + value.byteLength > out.byteLength) {
          throw new Error('[VIP][FileIngestion] File stream exceeded its declared size');
        }
        out.set(value, received);
        received += value.byteLength;
        onProgress(Math.min(44, 8 + Math.round((received / total) * 36)));
        if (received % STREAM_YIELD_BYTES < value.byteLength) await yieldToMain();
      }
    }, {
      timeoutMs,
      timeoutMessage: '[VIP][FileIngestion] File read timeout',
      timeoutCode: 'FILE_READ_TIMEOUT',
      signal,
      onStop: () => {
        const cancelled = reader.cancel?.();
        cancelled?.catch?.(() => {});
      },
    });
  } finally {
    try { reader.releaseLock?.(); } catch { /* ignore */ }
  }
  onProgress(45);
  return received === out.byteLength ? out.buffer : out.slice(0, received).buffer;
}

function yieldToMain() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * Cross-browser decodeAudioData — iOS callback API, Android resume/retry.
 * Uses window.safeDecodeAudioData when mobile-upload-fix.js is loaded (Engineer).
 */
async function decodeAudioBufferSafe(ctx, arrayBuffer, { timeoutMs, signal } = {}) {
  const shim = globalThis.safeDecodeAudioData;
  if (typeof shim === 'function') {
    return runBounded(() => shim(ctx, arrayBuffer), {
      timeoutMs,
      timeoutMessage: '[VIP][FileIngestion] decodeAudioData timeout',
      timeoutCode: 'DECODE_TIMEOUT',
      signal,
    });
  }
  await resumeAudioContext(ctx, signal);
  // Keep one compressed-input copy for the Android/Chromium retry. Some
  // decodeAudioData implementations detach the buffer even when decode fails.
  let retryBuffer = null;
  try { retryBuffer = arrayBuffer.slice(0); } catch { /* retry unavailable */ }
  const decodeOnce = (context, buf) => runBounded(() => new Promise((resolve, reject) => {
    let callbackSettled = false;
    const onOk = (decoded) => {
      if (callbackSettled) return;
      callbackSettled = true;
      resolve(decoded);
    };
    const onErr = (err) => {
      if (callbackSettled) return;
      callbackSettled = true;
      reject(err || new Error('decodeAudioData failed'));
    };
    const ret = context.decodeAudioData(buf, onOk, onErr);
    if (ret && typeof ret.then === 'function') ret.then(onOk, onErr);
  }), {
    timeoutMs,
    timeoutMessage: '[VIP][FileIngestion] decodeAudioData timeout',
    timeoutCode: 'DECODE_TIMEOUT',
    signal,
  });
  try {
    return await decodeOnce(ctx, arrayBuffer);
  } catch (firstErr) {
    if (isTerminalOperationError(firstErr)) throw firstErr;
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx || !retryBuffer?.byteLength) throw firstErr;
    const fresh = getSharedAudioContext(Ctx, 'retry');
    try {
      await resumeAudioContext(fresh, signal);
      return await decodeOnce(fresh, retryBuffer);
    } catch (retryError) {
      if (isTerminalOperationError(retryError)) throw retryError;
      throw firstErr;
    }
  }
}

/**
 * decodeAudioData on MP4/MOV often returns only the first ~15 s. Detect that
 * so we can fall back to full media-element capture.
 *
 * FIX: Previously this triggered on large WAV/AIFF files (sizeMB >= 8 &&
 * duration < 45) even though the decode was correct. Guard is now gated
 * exclusively on video containers — audio blobs never enter this branch.
 */
function _likelyTruncatedDecode(blob, buffer) {
  if (!buffer?.duration || buffer.duration <= 0) return true;
  const sizeMB = (blob.size || 0) / (1024 * 1024);
  const name = blob.name || '';
  const isVideoContainer = /\.(mp4|m4v|mov|mkv|webm|avi|ogv|3gp|wmv)$/i.test(name)
    || (blob.type || '').startsWith('video/');
  // Only apply duration heuristic for actual video containers — audio
  // blobs (WAV, AIFF, FLAC) can legitimately be large with short durations.
  if (!isVideoContainer) return false;
  if (sizeMB >= 1.5 && buffer.duration < 18) return true;
  if (sizeMB >= 8 && buffer.duration < 45) return true;
  return false;
}

/** Apply the highest playback rate the element accepts (faster-than-realtime capture). */
function _applyCapturePlaybackRate(media) {
  try {
    media.playbackRate = MAX_CAPTURE_PLAYBACK_RATE;
    if (typeof media.preservesPitch === 'boolean') media.preservesPitch = false;
    const applied = media.playbackRate;
    return applied >= 1 ? applied : 1;
  } catch {
    return 1;
  }
}

/** Incremental channel buffer — grows in chunks instead of one huge upfront alloc. */
function createGrowingChannel() {
  let buf = new Float32Array(SPN_BLOCK_SIZE * 32);
  let len = 0;
  return {
    append(src, count) {
      const need = len + count;
      if (need > buf.length) {
        let cap = buf.length;
        while (cap < need) cap *= 2;
        const next = new Float32Array(cap);
        next.set(buf.subarray(0, len));
        buf = next;
      }
      buf.set(src.subarray(0, count), len);
      len += count;
    },
    get length() { return len; },
    copyInto(dest, outLen) {
      const n = Math.min(len, outLen);
      dest.set(buf.subarray(0, n));
    },
  };
}

// ---------------------------------------------------------------------------
// Fast path — decodeAudioData
//
// FIX: Accepts an optional externalCtx to reuse the app-level AudioContext
// instead of spawning a new one on every upload. Chrome enforces a ~6-context
// cap; exceeding it causes decodeAudioData to return null/empty silently.
// ---------------------------------------------------------------------------
async function _decodeWithAudioData(blob, onProgress, externalCtx = null, options = {}) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API is not available.');

  onProgress(5);
  const arrayBuffer = await readBlobWithProgress(blob, onProgress, {
    timeoutMs: options.readTimeoutMs,
    signal: options.signal,
  });

  onProgress(50);

  // Reuse the caller's context when available — avoids context limit exhaustion.
  const ctx = externalCtx || getSharedAudioContext(Ctx, 'primary', { sampleRate: SAMPLE_RATE });
  onProgress(55);
  const decoded = await decodeAudioBufferSafe(ctx, arrayBuffer, {
    timeoutMs: options.decodeTimeoutMs,
    signal: options.signal,
  });
  onProgress(100);
  return decoded;
}

// ---------------------------------------------------------------------------
// Fallback — accelerated media-element capture via ScriptProcessorNode
//
// FIX: media.muted was false and only volume=0 was set. On Chrome/Safari,
// volume=0 without muted=true still triggers autoplay policy enforcement —
// play() throws NotAllowedError when no prior user-gesture AudioContext
// unlock has been recorded. Set muted=true for the capture element; the
// ScriptProcessorNode captures PCM from the graph regardless of muted state.
// ---------------------------------------------------------------------------
async function _decodeViaMediaElement(blob, kind, onProgress, externalCtx = null, signal = null) {
  const doc = globalThis.document;
  if (!doc?.createElement || !doc.body) {
    throw new Error('Media element decode requires a browser document.');
  }
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API is not available.');

  onProgress(3);
  const url = URL.createObjectURL(blob);
  const tag = kind === 'video' ? 'video' : 'audio';
  const media = doc.createElement(tag);
  media.preload = 'auto';
  // FIX: Set muted=true so play() is not blocked by autoplay policy.
  // The ScriptProcessorNode captures audio from the graph regardless of the
  // muted attribute — muted only affects the speaker output, not the SPN tap.
  media.muted = true;
  try { media.volume = 0; } catch { /* ignore — belt-and-suspenders */ }
  media.setAttribute('playsinline', '');
  media.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  doc.body.appendChild(media);
  media.src = url;

  // Reuse the app's AudioContext when viable — a closed context cannot create nodes.
  const reusableCtx = externalCtx?.state === 'closed' ? null : externalCtx;
  let ctx = null;
  let source = null;
  let spn = null;
  let silentGain = null;
  let timeoutHandle = null;
  let captureAbortHandler = null;
  try {
    onProgress(5);
    await _waitForMetadata(media, signal);
    onProgress(12);

    let duration = media.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Media has no decodable audio duration.');
    }

    const playbackRate = _applyCapturePlaybackRate(media);

    const numChannels = 2;
    const channels = Array.from({ length: numChannels }, () => createGrowingChannel());
    let writeOffset = 0;
    let captureDone = false;
    let captureSettled = false;
    let progressScheduled = false;
    let resolveCapture = null;
    let rejectCapture = null;
    const flushTailMs = Math.ceil((SPN_BLOCK_SIZE / SAMPLE_RATE) * 1000) + 50;
    const estimatedFrames = Math.max(1, Math.ceil(duration * SAMPLE_RATE));

    const reportProgress = () => {
      if (progressScheduled) return;
      progressScheduled = true;
      const schedule = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (callback) => setTimeout(callback, 16);
      schedule(() => {
        progressScheduled = false;
        if (captureDone) return;
        const pct = Math.min(99, Math.round((writeOffset / estimatedFrames) * 100));
        try { onProgress(Math.max(15, pct)); } catch { /* UI callback only */ }
      });
    };

    const updateDuration = (newDuration) => {
      if (!Number.isFinite(newDuration) || newDuration <= 0) return;
      if (newDuration > duration) duration = newDuration;
    };

    const finishCapture = () => {
      if (captureSettled) return;
      captureSettled = true;
      captureDone = true;
      if (timeoutHandle != null) clearTimeout(timeoutHandle);
      if (spn) spn.onaudioprocess = null;
      setTimeout(() => {
        resolveCapture?.();
      }, flushTailMs);
    };

    const failCapture = (error) => {
      if (captureSettled) return;
      captureSettled = true;
      captureDone = true;
      if (timeoutHandle != null) clearTimeout(timeoutHandle);
      if (spn) spn.onaudioprocess = null;
      rejectCapture?.(error);
    };

    const capturePromise = new Promise((resolve, reject) => {
      resolveCapture = resolve;
      rejectCapture = reject;
      media.addEventListener('error', () => {
        failCapture(new Error(media.error?.message || 'Media playback failed'));
      }, { once: true });
    });
    // The capture can fail while media.play() is still pending. Attach a handler
    // immediately so that early media/abort failures cannot become unhandled.
    void capturePromise.catch(() => {});

    captureAbortHandler = () => {
      try { media.pause(); } catch { /* ignore */ }
      failCapture(createAbortError());
    };
    if (signal?.aborted) captureAbortHandler();
    else signal?.addEventListener?.('abort', captureAbortHandler, { once: true });

    const resetCaptureTimeout = () => {
      if (timeoutHandle != null) clearTimeout(timeoutHandle);
      const realtimeMs = Math.ceil(duration * 1000);
      const captureTimeoutMs = Math.max(
        MEDIA_DECODE_MIN_TIMEOUT_MS,
        Math.ceil((realtimeMs * 2) / playbackRate) + 60_000,
      );
      timeoutHandle = setTimeout(() => {
        try { media.pause(); } catch { /* ignore */ }
        failCapture(createTimeoutError(
          '[VIP][FileIngestion] Media capture timeout',
          'MEDIA_CAPTURE_TIMEOUT',
        ));
      }, captureTimeoutMs);
    };

    ctx = reusableCtx || getSharedAudioContext(Ctx, 'primary', { sampleRate: SAMPLE_RATE });
    await resumeAudioContext(ctx, signal);
    source = ctx.createMediaElementSource(media);
    spn = ctx.createScriptProcessor(SPN_BLOCK_SIZE, numChannels, numChannels);
    // Zero-gain sink: SPN must stay connected for onaudioprocess to fire, but
    // we must not blast 16×-rate audio through the speakers during decode.
    silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    source.connect(spn);
    spn.connect(silentGain);
    silentGain.connect(ctx.destination);

    spn.onaudioprocess = (e) => {
      if (captureDone) return;
      const copyLen = SPN_BLOCK_SIZE;
      for (let ch = 0; ch < numChannels; ch++) {
        channels[ch].append(e.inputBuffer.getChannelData(ch), copyLen);
      }
      writeOffset += copyLen;
      // ScriptProcessor callbacks already run as separate tasks and cannot be
      // made async safely. Coalesce UI progress above instead of queuing no-op
      // timers, which do not yield the callback that scheduled them.
      reportProgress();
    };

    media.addEventListener('ended', finishCapture, { once: true });
    media.addEventListener('durationchange', () => {
      updateDuration(media.duration);
      resetCaptureTimeout();
    });

    resetCaptureTimeout();
    onProgress(15);

    try {
      await runBounded(() => media.play(), {
        timeoutMs: MEDIA_PLAY_TIMEOUT_MS,
        timeoutMessage: '[VIP][FileIngestion] Media playback start timeout',
        timeoutCode: 'MEDIA_PLAY_TIMEOUT',
        signal,
        onStop: () => media.pause(),
      });
    } catch (playErr) {
      failCapture(playErr);
      if (isTerminalOperationError(playErr)) throw playErr;
      // NotAllowedError = autoplay policy (should not reach here after the
      // muted=true fix above, but guard in case the browser is strict).
      const isAutoplayBlock = playErr?.name === 'NotAllowedError'
        || /not allowed/i.test(playErr?.message || '');
      if (isAutoplayBlock) {
        throw new Error(
          'Audio playback was blocked by the browser autoplay policy. ' +
          'Tap or click anywhere on the page first, then upload again.'
        );
      }
      throw new Error(
        `Media playback blocked or failed: ${playErr?.message || playErr}. ` +
        'Tap Browse and try again (audio unlock required).'
      );
    }

    await capturePromise;

    if (writeOffset <= 0) {
      throw new Error('Media element produced an empty audio buffer.');
    }

    const reportedDuration = Number.isFinite(media.duration) && media.duration > 0
      ? media.duration
      : duration;
    const outFrames = Math.min(
      writeOffset,
      Math.max(1, Math.ceil(reportedDuration * SAMPLE_RATE)),
    );

    onProgress(98);

    const result = new AudioBuffer({
      numberOfChannels: numChannels,
      length: outFrames,
      sampleRate: SAMPLE_RATE,
    });
    for (let ch = 0; ch < numChannels; ch++) {
      channels[ch].copyInto(result.getChannelData(ch), outFrames);
    }

    try { onProgress(100); } catch { /* UI callback only */ }
    return result;
  } finally {
    if (timeoutHandle != null) clearTimeout(timeoutHandle);
    signal?.removeEventListener?.('abort', captureAbortHandler);
    if (spn) spn.onaudioprocess = null;
    try { source?.disconnect?.(); } catch { /* already disconnected */ }
    try { spn?.disconnect?.(); } catch { /* already disconnected */ }
    try { silentGain?.disconnect?.(); } catch { /* already disconnected */ }
    try { media.pause(); } catch { /* ignore */ }
    try { media.removeAttribute('src'); media.load(); media.remove(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _waitForMetadata(media, signal = null) {
  return new Promise((resolve, reject) => {
    const HAVE_METADATA = globalThis.HTMLMediaElement?.HAVE_METADATA ?? 1;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      media.removeEventListener?.('loadedmetadata', done);
      media.removeEventListener?.('canplay', done);
      media.removeEventListener?.('error', fail);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const done = () => {
      settle(resolve);
    };
    const fail = () => {
      const code = media.error?.code;
      const msg  = media.error?.message || 'Media element failed to load';
      settle(() => reject(new Error(`${msg}${code ? ` (code ${code})` : ''}`)));
    };
    const onAbort = () => settle(() => reject(createAbortError()));
    timer = setTimeout(() => {
      settle(() => reject(createTimeoutError(
        'Media metadata load timeout — file may be corrupt or unsupported.',
        'MEDIA_METADATA_TIMEOUT',
      )));
    }, MEDIA_DECODE_MIN_TIMEOUT_MS);
    if (media.readyState >= HAVE_METADATA) { done(); return; }
    media.addEventListener('loadedmetadata', done, { once: true });
    media.addEventListener('canplay', done, { once: true });
    media.addEventListener('error', fail, { once: true });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

export default decodeBlobToAudioBuffer;
