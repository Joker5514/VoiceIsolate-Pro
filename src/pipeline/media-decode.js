'use strict';

import { SAMPLE_RATE } from '../core/audio-config.js';
import { inferMediaKind } from '../core/media-types.js';

/** Minimum capture timeout — long files scale beyond this. */
const MEDIA_DECODE_MIN_TIMEOUT_MS = 120_000;
/** Below 64 MiB a single arrayBuffer() read is faster than streaming chunks. */
const FAST_READ_BYTES = 64 * 1024 * 1024;
/** Yield during streaming reads at most every N bytes. */
const STREAM_YIELD_BYTES = 32 * 1024 * 1024;
/** Target media-element capture rate (16× is widely supported). */
const MAX_CAPTURE_PLAYBACK_RATE = 16;
// ScriptProcessorNode block size — must be a power-of-two 256–16384.
const SPN_BLOCK_SIZE = 8192;

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
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeBlobToAudioBuffer(blob, hooks = {}) {
  const { onProgress = () => {} } = hooks;
  const kind = inferMediaKind(blob) || 'audio';

  if (kind === 'video') {
    try {
      const fast = await _decodeWithAudioData(blob, onProgress);
      if (!_likelyTruncatedDecode(blob, fast)) return fast;
    } catch {
      /* fall through to media-element capture */
    }
    return _decodeViaMediaElement(blob, kind, onProgress);
  }

  let primaryErr = null;
  try {
    return await _decodeWithAudioData(blob, onProgress);
  } catch (err) {
    primaryErr = err;
  }

  try {
    return _decodeViaMediaElement(blob, kind, onProgress);
  } catch (fallbackErr) {
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
async function readBlobWithProgress(blob, onProgress) {
  const total = blob.size || 1;
  if (total <= FAST_READ_BYTES || typeof blob.stream !== 'function') {
    onProgress(15);
    const buf = await blob.arrayBuffer();
    onProgress(45);
    return buf;
  }

  const reader = blob.stream().getReader();
  const parts = [];
  let received = 0;
  onProgress(8);

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.byteLength;
    onProgress(Math.min(44, 8 + Math.round((received / total) * 36)));
    if (received % STREAM_YIELD_BYTES < value.byteLength) await yieldToMain();
  }

  const out = new Uint8Array(received);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  onProgress(45);
  return out.buffer;
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
async function decodeAudioBufferSafe(ctx, arrayBuffer) {
  const shim = globalThis.safeDecodeAudioData;
  if (typeof shim === 'function') {
    return shim(ctx, arrayBuffer);
  }
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch { /* best-effort */ }
  }
  const decodeOnce = (context, buf) => new Promise((resolve, reject) => {
    const onOk = (decoded) => resolve(decoded);
    const onErr = (err) => reject(err || new Error('decodeAudioData failed'));
    try {
      const ret = context.decodeAudioData(buf, onOk, onErr);
      if (ret && typeof ret.then === 'function') ret.then(resolve, reject);
    } catch (err) {
      reject(err);
    }
  });
  try {
    return await decodeOnce(ctx, arrayBuffer);
  } catch (firstErr) {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) throw firstErr;
    const fresh = new Ctx();
    try {
      if (fresh.state === 'suspended') await fresh.resume();
      const retryBuf = arrayBuffer.byteLength > 0 ? arrayBuffer.slice(0) : arrayBuffer;
      return await decodeOnce(fresh, retryBuf);
    } catch {
      throw firstErr;
    } finally {
      try { await fresh.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * decodeAudioData on MP4/MOV often returns only the first ~15 s. Detect that
 * so we can fall back to full media-element capture.
 */
function _likelyTruncatedDecode(blob, buffer) {
  if (!buffer?.duration || buffer.duration <= 0) return true;
  const sizeMB = (blob.size || 0) / (1024 * 1024);
  const name = blob.name || '';
  const isVideoContainer = /\.(mp4|m4v|mov|mkv|webm|avi|ogv|3gp|wmv)$/i.test(name)
    || (blob.type || '').startsWith('video/');
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
// ---------------------------------------------------------------------------
async function _decodeWithAudioData(blob, onProgress) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API is not available.');

  onProgress(5);
  const arrayBuffer = await readBlobWithProgress(blob, onProgress);

  onProgress(50);
  const ctx = new Ctx();
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    onProgress(55);
    const decoded = await decodeAudioBufferSafe(ctx, arrayBuffer);
    onProgress(100);
    return decoded;
  } finally {
    try { await ctx.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Fallback — accelerated media-element capture via ScriptProcessorNode
// ---------------------------------------------------------------------------
async function _decodeViaMediaElement(blob, kind, onProgress) {
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
  media.muted = true;
  media.setAttribute('playsinline', '');
  media.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  doc.body.appendChild(media);
  media.src = url;

  let ctx = null;
  let timeoutHandle = null;
  try {
    onProgress(5);
    await _waitForMetadata(media);
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
    let resolveCapture = null;
    /** @type {ScriptProcessorNode|null} */
    let spn = null;

    const flushTailMs = Math.ceil((SPN_BLOCK_SIZE / SAMPLE_RATE) * 1000) + 50;
    const estimatedFrames = Math.max(1, Math.ceil(duration * SAMPLE_RATE));

    const reportProgress = () => {
      const pct = Math.min(99, Math.round((writeOffset / estimatedFrames) * 100));
      onProgress(Math.max(15, pct));
    };

    const updateDuration = (newDuration) => {
      if (!Number.isFinite(newDuration) || newDuration <= 0) return;
      if (newDuration > duration) duration = newDuration;
    };

    const finishCapture = () => {
      if (captureSettled) return;
      captureSettled = true;
      captureDone = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (spn) spn.onaudioprocess = null;
      setTimeout(() => {
        onProgress(100);
        resolveCapture?.();
      }, flushTailMs);
    };

    const capturePromise = new Promise((resolve, reject) => {
      resolveCapture = resolve;
      media.addEventListener('error', () => {
        if (captureSettled) return;
        captureSettled = true;
        captureDone = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (spn) spn.onaudioprocess = null;
        reject(new Error(media.error?.message || 'Media playback failed'));
      }, { once: true });
    });

    const resetCaptureTimeout = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const realtimeMs = Math.ceil(duration * 1000);
      const captureTimeoutMs = Math.max(
        MEDIA_DECODE_MIN_TIMEOUT_MS,
        Math.ceil((realtimeMs * 2) / playbackRate) + 60_000,
      );
      timeoutHandle = setTimeout(() => {
        try { media.pause(); } catch { /* ignore */ }
        finishCapture();
      }, captureTimeoutMs);
    };

    ctx = new Ctx({ sampleRate: SAMPLE_RATE });
    if (ctx.state === 'suspended') await ctx.resume();
    const source = ctx.createMediaElementSource(media);
    spn = ctx.createScriptProcessor(SPN_BLOCK_SIZE, numChannels, numChannels);
    source.connect(spn);
    spn.connect(ctx.destination);

    spn.onaudioprocess = (e) => {
      if (captureDone) return;
      const copyLen = SPN_BLOCK_SIZE;
      for (let ch = 0; ch < numChannels; ch++) {
        channels[ch].append(e.inputBuffer.getChannelData(ch), copyLen);
      }
      writeOffset += copyLen;
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
      await media.play();
    } catch (playErr) {
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

    return result;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    try { media.pause(); } catch { /* ignore */ }
    try { media.removeAttribute('src'); media.load(); media.remove(); } catch { /* ignore */ }
    URL.revokeObjectURL(url);
    if (ctx) try { await ctx.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function _waitForMetadata(media) {
  return new Promise((resolve, reject) => {
    const HAVE_METADATA = globalThis.HTMLMediaElement?.HAVE_METADATA ?? 1;
    let settled = false;
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        reject(new Error('Media metadata load timeout — file may be corrupt or unsupported.'));
      },
      MEDIA_DECODE_MIN_TIMEOUT_MS,
    );
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = media.error?.code;
      const msg  = media.error?.message || 'Media element failed to load';
      reject(new Error(`${msg}${code ? ` (code ${code})` : ''}`));
    };
    if (media.readyState >= HAVE_METADATA) { done(); return; }
    media.addEventListener('loadedmetadata', done, { once: true });
    media.addEventListener('canplay', done, { once: true });
    media.addEventListener('error', fail, { once: true });
  });
}

export default decodeBlobToAudioBuffer;