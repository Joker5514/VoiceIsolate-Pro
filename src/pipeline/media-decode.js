'use strict';

import { SAMPLE_RATE } from '../core/audio-config.js';
import { inferMediaKind } from '../core/media-types.js';

/** Minimum capture timeout — long files scale beyond this. */
const MEDIA_DECODE_MIN_TIMEOUT_MS = 120_000;
// ScriptProcessorNode block size — must be a power-of-two 256–16384.
const SPN_BLOCK_SIZE = 4096;

/**
 * Decode any supported blob to an AudioBuffer.
 *
 * Strategy:
 *   Video containers always use the media-element capture path so the browser
 *   demuxes the full timeline (decodeAudioData can truncate some MP4/MOV).
 *   Audio:
 *     1. Fast path  — ctx.decodeAudioData()  (PCM/WAV/MP3/OGG/FLAC)
 *     2. Fallback   — live AudioContext + createMediaElementSource +
 *                     ScriptProcessorNode ring-buffer capture until 'ended'.
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
    return _decodeViaMediaElement(blob, kind, onProgress);
  }

  let primaryErr = null;
  try {
    return await _decodeWithAudioData(blob, onProgress);
  } catch (err) {
    primaryErr = err;
  }

  try {
    return await _decodeViaMediaElement(blob, kind, onProgress);
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
  if (typeof blob.stream !== 'function') {
    onProgress(15);
    await yieldToMain();
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
    if (received % (4 * 1024 * 1024) < value.byteLength) await yieldToMain();
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
    toArray(outLen) {
      const n = Math.min(len, outLen);
      const out = new Float32Array(n);
      out.set(buf.subarray(0, n));
      return out;
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
  await yieldToMain();
  const ctx = new Ctx();
  try {
    if (ctx.state === 'suspended') await ctx.resume();
    onProgress(55);
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    onProgress(100);
    return decoded;
  } finally {
    try { await ctx.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Fallback — live AudioContext + createMediaElementSource + ring-buffer
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

    const numChannels = 2;
    const channels = Array.from({ length: numChannels }, () => createGrowingChannel());
    let writeOffset = 0;
    let captureDone = false;
    let captureSettled = false;
    let resolveCapture = null;
    let rejectCapture = null;
    /** @type {ScriptProcessorNode|null} */
    let spn = null;

    const flushTailMs = Math.ceil((SPN_BLOCK_SIZE / SAMPLE_RATE) * 1000) + 100;
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
      rejectCapture = reject;
    });

    const resetCaptureTimeout = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const captureTimeoutMs = Math.max(
        MEDIA_DECODE_MIN_TIMEOUT_MS,
        Math.ceil(duration * 1000 * 2) + 60_000,
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
        const src = e.inputBuffer.getChannelData(ch);
        channels[ch].append(src, copyLen);
      }
      writeOffset += copyLen;
      reportProgress();
    };

    media.addEventListener('ended', finishCapture, { once: true });
    media.addEventListener('error', () => {
      if (captureSettled) return;
      captureSettled = true;
      captureDone = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (spn) spn.onaudioprocess = null;
      rejectCapture?.(new Error(media.error?.message || 'Media playback failed'));
    }, { once: true });
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
    await yieldToMain();

    const result = new AudioBuffer({
      numberOfChannels: numChannels,
      length: outFrames,
      sampleRate: SAMPLE_RATE,
    });
    for (let ch = 0; ch < numChannels; ch++) {
      result.getChannelData(ch).set(channels[ch].toArray(outFrames));
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