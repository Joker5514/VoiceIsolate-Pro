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
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeBlobToAudioBuffer(blob) {
  const kind = inferMediaKind(blob) || 'audio';

  if (kind === 'video') {
    return _decodeViaMediaElement(blob, kind);
  }

  let primaryErr = null;
  try {
    return await _decodeWithAudioData(blob);
  } catch (err) {
    primaryErr = err;
  }

  try {
    return await _decodeViaMediaElement(blob, kind);
  } catch (fallbackErr) {
    throw new Error(
      `[VIP][FileIngestion] Could not decode '${blob.name || 'file'}'. ` +
      `(Web Audio: ${primaryErr?.message ?? primaryErr}; ` +
      `media fallback: ${fallbackErr?.message ?? fallbackErr})`
    );
  }
}

// ---------------------------------------------------------------------------
// Fast path — decodeAudioData
// ---------------------------------------------------------------------------
async function _decodeWithAudioData(blob) {
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API is not available.');
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    try { await ctx.close(); } catch { /* already closed */ }
  }
}

// ---------------------------------------------------------------------------
// Fallback — live AudioContext + createMediaElementSource + ring-buffer
// ---------------------------------------------------------------------------
async function _decodeViaMediaElement(blob, kind) {
  const doc = globalThis.document;
  if (!doc?.createElement || !doc.body) {
    throw new Error('Media element decode requires a browser document.');
  }
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) throw new Error('Web Audio API is not available.');

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
    await _waitForMetadata(media);

    let duration = media.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Media has no decodable audio duration.');
    }

    ctx = new Ctx({ sampleRate: SAMPLE_RATE });
    const source = ctx.createMediaElementSource(media);

    const numChannels = 2;
    const chunks = [];
    let captureDone = false;

    const spn = ctx.createScriptProcessor(SPN_BLOCK_SIZE, numChannels, numChannels);
    source.connect(spn);
    spn.connect(ctx.destination);

    spn.onaudioprocess = (e) => {
      if (captureDone) return;
      const block = [];
      for (let ch = 0; ch < numChannels; ch++) {
        block.push(new Float32Array(e.inputBuffer.getChannelData(ch)));
      }
      chunks.push(block);
    };

    const flushTailMs = Math.ceil((SPN_BLOCK_SIZE / SAMPLE_RATE) * 1000) + 100;

    const resetCaptureTimeout = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const captureTimeoutMs = Math.max(
        MEDIA_DECODE_MIN_TIMEOUT_MS,
        Math.ceil(duration * 1000 * 2) + 60_000,
      );
      timeoutHandle = setTimeout(() => {
        captureDone = true;
        spn.onaudioprocess = null;
        media.pause();
      }, captureTimeoutMs);
    };

    const endedPromise = new Promise((resolve, reject) => {
      const finish = () => {
        if (captureDone) return;
        captureDone = true;
        spn.onaudioprocess = null;
        setTimeout(resolve, flushTailMs);
      };
      media.addEventListener('ended', finish, { once: true });
      media.addEventListener('error', () => {
        reject(new Error(media.error?.message || 'Media playback failed'));
      }, { once: true });
      media.addEventListener('durationchange', () => {
        if (Number.isFinite(media.duration) && media.duration > duration) {
          duration = media.duration;
          resetCaptureTimeout();
        }
      });
    });

    resetCaptureTimeout();

    await media.play();
    await endedPromise;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    spn.onaudioprocess = null;

    if (!chunks.length) {
      throw new Error('Media element produced an empty audio buffer.');
    }

    const reportedDuration = Number.isFinite(media.duration) && media.duration > 0
      ? media.duration
      : duration;
    const targetFrames = Math.max(1, Math.ceil(reportedDuration * SAMPLE_RATE));
    const capturedFrames = chunks.length * SPN_BLOCK_SIZE;
    const outFrames = Math.min(capturedFrames, targetFrames);

    const result = new AudioBuffer({
      numberOfChannels: numChannels,
      length: outFrames,
      sampleRate: SAMPLE_RATE,
    });
    for (let ch = 0; ch < numChannels; ch++) {
      const dest = result.getChannelData(ch);
      let offset = 0;
      for (const block of chunks) {
        const remain = outFrames - offset;
        if (remain <= 0) break;
        const copyLen = Math.min(SPN_BLOCK_SIZE, remain);
        dest.set(block[ch].subarray(0, copyLen), offset);
        offset += copyLen;
      }
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
    const timer = setTimeout(
      () => reject(new Error('Media metadata load timeout')),
      MEDIA_DECODE_MIN_TIMEOUT_MS,
    );
    const done = () => { clearTimeout(timer); resolve(); };
    const fail = () => {
      clearTimeout(timer);
      const code = media.error?.code;
      const msg  = media.error?.message || 'Media element failed to load';
      reject(new Error(`${msg}${code ? ` (code ${code})` : ''}`));
    };
    if (media.readyState >= HAVE_METADATA) { done(); return; }
    media.addEventListener('loadedmetadata', done, { once: true });
    media.addEventListener('error', fail, { once: true });
  });
}

export default decodeBlobToAudioBuffer;