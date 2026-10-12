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
// ScriptProcessorNode block size — must be a power-of-two 256–16384. It is
// also the granularity of the pre-roll estimate used only when the media
// itself starts and ends in digital silence (~85 ms at 48 kHz).
const SPN_BLOCK_SIZE = 4096;
/** Metadata probe used to check a decodeAudioData result for truncation. */
const METADATA_PROBE_TIMEOUT_MS = 15_000;
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
      if (!(await _decodeLooksTruncated(blob, fast, signal))) return fast;
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
      reject(err instanceof Error ? err : new Error(String(err || 'decodeAudioData failed')));
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
 * A decodeAudioData result is truncated when it is clearly shorter than the
 * container's own duration (media-element metadata). The old size/duration
 * heuristic flagged every short, high-bitrate video (≥1.5 MB under 18 s) —
 * e.g. a 10 s phone clip — and sent a correct decode down the capture path.
 * Without readable metadata the decode is trusted.
 * @param {Blob} blob
 * @param {AudioBuffer} buffer
 * @param {AbortSignal|null} signal
 * @returns {Promise<boolean>}
 */
async function _decodeLooksTruncated(blob, buffer, signal = null) {
  if (!buffer?.duration || buffer.duration <= 0) return true;
  const containerSec = await _probeMediaDuration(blob, signal).catch((err) => {
    if (isTerminalOperationError(err)) throw err;
    return null;
  });
  if (!Number.isFinite(containerSec) || containerSec <= 0) return false;
  const tolerance = Math.max(0.25, containerSec * 0.02);
  return buffer.duration + tolerance < containerSec;
}

/** Container duration in seconds from a metadata-only media element. */
async function _probeMediaDuration(blob, signal) {
  const doc = globalThis.document;
  if (!doc?.createElement) return null;
  const kind = inferMediaKind(blob) === 'video' ? 'video' : 'audio';
  const media = doc.createElement(kind);
  media.preload = 'metadata';
  media.muted = true;
  const url = URL.createObjectURL(blob);
  try {
    media.src = url;
    await runBounded(() => _waitForMetadata(media, signal), {
      timeoutMs: METADATA_PROBE_TIMEOUT_MS,
      timeoutMessage: '[VIP][FileIngestion] metadata probe timeout',
      timeoutCode: 'MEDIA_METADATA_TIMEOUT',
      signal,
    });
    return Number.isFinite(media.duration) ? media.duration : null;
  } finally {
    try { media.removeAttribute('src'); media.load(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
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
    view() { return buf.subarray(0, len); },
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
// Fallback — real-time media-element capture via ScriptProcessorNode
//
// The element plays at 1× and unmuted. Accelerated capture (16×, pitch not
// preserved) returned 1/16 of the frames labelled 48 kHz with content
// band-limited by the resampler, and muted=true made Chromium feed the graph
// silence: a 10 s 440 Hz WebM came back as 1.19 s of zeros. The element's
// output is re-routed into the graph and leaves through a zero-gain sink, so
// unmuted capture is still inaudible. It runs in real time.
//
// The captured stream is [pre-roll zeros][content][post-roll zeros]; the
// content window is placed from the media duration and the first/last
// non-silent samples (exact when the media does not begin and end in digital
// silence), and the capture is rejected when blocks were dropped or it is
// shorter than the media.
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
  // Muted (or volume 0) silences the MediaElementAudioSourceNode in Chromium.
  media.muted = false;
  try { media.volume = 1; } catch { /* ignore */ }
  media.setAttribute('playsinline', '');
  media.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  doc.body.appendChild(media);
  try {
    media.src = url;
  } catch (srcErr) {
    throw new Error(`[VIP][FileIngestion] Cannot set media source: ${srcErr?.message || srcErr}`);
  }

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

    try {
      media.playbackRate = 1;
      media.defaultPlaybackRate = 1;
    } catch { /* ignore */ }

    // Read the actual channel count from the media element after metadata loads.
    // Falls back to 2 (stereo) when the browser doesn't expose the track count.
    const numChannels = Math.min(
      2,
      Math.max(1, media.mozChannels || media.audioTracks?.length || 2),
    );
    const channels = Array.from({ length: numChannels }, () => createGrowingChannel());
    let writeOffset = 0;
    /** Frames captured before the element reported 'playing' (pre-roll estimate). */
    let prePlayFrames = 0;
    let playing = false;
    /** Frames lost to late ScriptProcessor callbacks (gaps in playbackTime). */
    let droppedFrames = 0;
    let lastPlaybackTime = null;
    let captureDone = false;
    let captureSettled = false;
    let progressScheduled = false;
    let resolveCapture = null;
    let rejectCapture = null;
    // After 'ended', blocks still queued in the graph keep arriving: capture
    // until two all-silent blocks have passed and the media's whole length is
    // covered, bounded so a stuck graph cannot hold the import.
    const POST_ROLL_SILENT_BLOCKS = 2;
    const MAX_POST_ROLL_MS = 2000;
    let ended = false;
    let silentBlocksAfterEnd = 0;
    let postRollTimer = null;
    let estimatedFrames = Math.max(1, Math.ceil(duration * SAMPLE_RATE));

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
      if (postRollTimer != null) clearTimeout(postRollTimer);
      if (spn) spn.onaudioprocess = null;
      resolveCapture?.();
    };

    const failCapture = (error) => {
      if (captureSettled) return;
      captureSettled = true;
      captureDone = true;
      if (timeoutHandle != null) clearTimeout(timeoutHandle);
      if (postRollTimer != null) clearTimeout(postRollTimer);
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
        realtimeMs * 2 + 60_000,
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
    estimatedFrames = Math.max(1, Math.ceil(duration * ctx.sampleRate));
    source = ctx.createMediaElementSource(media);
    spn = ctx.createScriptProcessor(SPN_BLOCK_SIZE, numChannels, numChannels);
    // Zero-gain sink: SPN must stay connected for onaudioprocess to fire, but
    // we must not blast 16×-rate audio through the speakers during decode.
    silentGain = ctx.createGain();
    silentGain.gain.value = 0;
    source.connect(spn);
    spn.connect(silentGain);
    silentGain.connect(ctx.destination);

    media.addEventListener('playing', () => { playing = true; }, { once: true });
    spn.onaudioprocess = (e) => {
      if (captureDone) return;
      const copyLen = SPN_BLOCK_SIZE;
      const blockSec = copyLen / ctx.sampleRate;
      if (lastPlaybackTime != null && Number.isFinite(e.playbackTime)) {
        const gap = e.playbackTime - lastPlaybackTime - blockSec;
        if (gap > blockSec * 0.5) droppedFrames += Math.round(gap * ctx.sampleRate);
      }
      lastPlaybackTime = e.playbackTime;
      for (let ch = 0; ch < numChannels; ch++) {
        channels[ch].append(e.inputBuffer.getChannelData(ch), copyLen);
      }
      if (!playing) prePlayFrames += copyLen;
      writeOffset += copyLen;
      if (ended) {
        let silent = true;
        for (let ch = 0; ch < numChannels && silent; ch++) {
          const d = e.inputBuffer.getChannelData(ch);
          for (let i = 0; i < d.length; i++) { if (d[i] !== 0) { silent = false; break; } }
        }
        silentBlocksAfterEnd = silent ? silentBlocksAfterEnd + 1 : 0;
        const mediaSec = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : duration;
        const covered = writeOffset >= prePlayFrames + Math.round(mediaSec * ctx.sampleRate);
        if (silentBlocksAfterEnd >= POST_ROLL_SILENT_BLOCKS && covered) finishCapture();
      }
      // ScriptProcessor callbacks already run as separate tasks and cannot be
      // made async safely. Coalesce UI progress above instead of queuing no-op
      // timers, which do not yield the callback that scheduled them.
      reportProgress();
    };

    media.addEventListener('ended', () => {
      ended = true;
      postRollTimer = setTimeout(finishCapture, MAX_POST_ROLL_MS);
    }, { once: true });
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
    const sr = ctx.sampleRate;
    if (droppedFrames > 0) {
      throw new Error(
        `[VIP][FileIngestion] Audio capture lost ${Math.round((droppedFrames / sr) * 1000)} ms while the page was busy. `
        + 'Keep this tab in the foreground and import again.',
      );
    }

    const reportedDuration = Number.isFinite(media.duration) && media.duration > 0
      ? media.duration
      : duration;
    const expected = Math.max(1, Math.round(reportedDuration * sr));
    const views = channels.map((c) => c.view());
    const content = locateContentWindow(views, expected, prePlayFrames);
    if (content.shortBy > SPN_BLOCK_SIZE) {
      throw new Error(
        `[VIP][FileIngestion] Audio capture ended ${(content.shortBy / sr).toFixed(2)} s before the media's `
        + `${reportedDuration.toFixed(2)} s duration.`,
      );
    }

    onProgress(98);

    // Labelled with the capturing context's real rate; ingestion resamples.
    const result = new AudioBuffer({
      numberOfChannels: numChannels,
      length: Math.max(1, content.length),
      sampleRate: sr,
    });
    for (let ch = 0; ch < numChannels; ch++) {
      result.getChannelData(ch).set(views[ch].subarray(content.start, content.start + content.length));
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

/**
 * Place the media's content inside a capture of [pre-roll][content][post-roll].
 * Pre- and post-roll are exact zeros (the element is not playing), so the
 * content starts at or before the first non-zero sample and ends at or after
 * the last one: the start lies in [lastNonZero + 1 − expected, firstNonZero].
 * When the first non-zero sample falls within a block of where playback was
 * seen to start, the media opens with signal and that sample is the start
 * (sample-exact). Otherwise the media opens in digital silence and the frames
 * captured before 'playing' place it (block-granular).
 * @param {Float32Array[]} views captured channels (equal length)
 * @param {number} expected content frames from the media duration
 * @param {number} prePlayFrames frames captured before 'playing'
 * @param {number} [blockFrames] capture block size (estimate granularity)
 * @returns {{ start: number, length: number, shortBy: number }}
 */
export function locateContentWindow(views, expected, prePlayFrames = 0, blockFrames = SPN_BLOCK_SIZE) {
  const total = views[0]?.length || 0;
  let first = -1;
  let last = -1;
  for (const v of views) {
    for (let i = 0; i < v.length; i++) {
      if (v[i] !== 0) { if (first < 0 || i < first) first = i; break; }
    }
    for (let i = v.length - 1; i >= 0; i--) {
      if (v[i] !== 0) { if (i > last) last = i; break; }
    }
  }
  if (total < expected) {
    // Too short to hold the media: report how short, keep what was captured.
    const start = first >= 0 ? Math.min(first, Math.max(0, prePlayFrames)) : 0;
    return { start, length: total - start, shortBy: expected - (total - start) };
  }
  if (first < 0) {
    const start = Math.min(Math.max(0, prePlayFrames), total - expected);
    return { start, length: expected, shortBy: 0 };
  }
  const lo = Math.max(0, last + 1 - expected);
  const hi = Math.min(first, total - expected);
  if (lo > hi) {
    // Non-silent content spans more than the reported duration: keep all of it.
    return { start: first, length: last + 1 - first, shortBy: 0 };
  }
  const opensWithSignal = Math.abs(first - prePlayFrames) <= 2 * blockFrames;
  const guess = opensWithSignal ? first : prePlayFrames;
  const start = Math.min(hi, Math.max(lo, guess));
  return { start, length: expected, shortBy: 0 };
}

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
      // Translate numeric HTMLMediaElement error codes to actionable user text.
      const codeDesc = code === 1 ? 'load aborted'
        : code === 2 ? 'network error'
        : code === 3 ? 'decode failed — file may be corrupt'
        : code === 4 ? 'unsupported format or codec'
        : null;
      const msg = codeDesc
        || media.error?.message
        || 'Media element failed to load';
      settle(() => reject(new Error(`[VIP][FileIngestion] ${msg}${code && !codeDesc ? ` (code ${code})` : ''}`)));
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
