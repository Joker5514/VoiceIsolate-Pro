'use strict';

import { SAMPLE_RATE } from '../core/audio-config.js';
import { inferMediaKind } from '../core/media-types.js';

const MEDIA_DECODE_TIMEOUT_MS = 60000;

/**
 * Decode any supported blob to an AudioBuffer.
 * 1. Web Audio decodeAudioData (fast path)
 * 2. Hidden <audio>/<video> + OfflineAudioContext (M4A/MP4/AAC fallbacks)
 *
 * @param {Blob|File} blob
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeBlobToAudioBuffer(blob) {
  let primaryErr = null;
  try {
    return await decodeWithAudioData(blob);
  } catch (err) {
    primaryErr = err;
  }

  const kind = inferMediaKind(blob) || 'audio';
  try {
    return await decodeViaMediaElement(blob, kind);
  } catch (fallbackErr) {
    throw new Error(
      `[VIP][FileIngestion] Could not decode '${blob.name || 'file'}'. ` +
      `(Web Audio: ${primaryErr?.message || primaryErr}; ` +
      `media fallback: ${fallbackErr?.message || fallbackErr})`
    );
  }
}

async function decodeWithAudioData(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const abCopy = arrayBuffer.slice(0);
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) {
    throw new Error('Web Audio API is not available.');
  }
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(abCopy);
  } finally {
    try { await ctx.close(); } catch { /* already closed */ }
  }
}

function mediaElementTag(kind, blob) {
  if (kind === 'video') return 'video';
  // .m4a is often mis-tagged video/mp4; always route audio extensions through <audio>.
  return 'audio';
}

async function waitForMediaReady(media, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Media load timeout')), timeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    const fail = () => {
      clearTimeout(timer);
      const code = media.error?.code;
      const msg = media.error?.message || 'Media element failed to load';
      reject(new Error(`${msg}${code ? ` (code ${code})` : ''}`));
    };
    if (media.readyState >= 1) {
      done();
      return;
    }
    media.addEventListener('loadedmetadata', done, { once: true });
    media.addEventListener('error', fail, { once: true });
  });
}

async function decodeViaMediaElement(blob, kind) {
  const doc = globalThis.document;
  if (!doc?.createElement || !doc.body) {
    throw new Error('Media element decode requires a browser document.');
  }

  const url = URL.createObjectURL(blob);
  const tag = mediaElementTag(kind, blob);
  const media = doc.createElement(tag);
  media.preload = 'auto';
  media.muted = false;
  media.setAttribute('playsinline', '');
  media.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  doc.body.appendChild(media);
  media.src = url;

  try {
    await waitForMediaReady(media, MEDIA_DECODE_TIMEOUT_MS);

    const duration = media.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Media has no decodable audio duration');
    }

    const channels = 2;
    // Pad frames so OfflineAudioContext does not truncate the tail of short clips.
    const frameCount = Math.ceil(duration * SAMPLE_RATE) + 2048;
    const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!OfflineCtx) {
      throw new Error('OfflineAudioContext is not available.');
    }

    const offline = new OfflineCtx(channels, frameCount, SAMPLE_RATE);
    const source = offline.createMediaElementSource(media);
    source.connect(offline.destination);

    const renderingPromise = offline.startRendering();
    // Do NOT await play(): OfflineAudioContext ends playback when rendering
    // completes, which rejects play() with "interrupted by end of playback".
    void media.play().catch(() => {});

    const buffer = await renderingPromise;
    if (!buffer?.length) {
      throw new Error('Media element produced an empty audio buffer');
    }
    return buffer;
  } finally {
    try { media.pause(); } catch { /* ignore */ }
    try {
      media.removeAttribute('src');
      media.load();
      media.remove();
    } catch { /* ignore */ }
    URL.revokeObjectURL(url);
  }
}

export default decodeBlobToAudioBuffer;