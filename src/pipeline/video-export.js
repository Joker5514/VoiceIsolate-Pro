/**
 * VoiceIsolate Pro — Video export (Layer 3: Pipeline)
 *
 * Remuxes processed audio onto the original video picture using browser APIs
 * only (no cloud, no ffmpeg dependency). Strategy:
 *   1. <video>.captureStream() for the picture track(s)
 *   2. AudioBufferSourceNode → MediaStreamDestination for the new audio
 *   3. MediaRecorder on the combined stream
 *
 * Falls back with a clear error so callers can offer WAV instead.
 */
'use strict';

import { isVideoSource } from '../core/media-types.js';

export { isVideoSource };

/**
 * Pick a MediaRecorder MIME type the browser can actually record.
 * @returns {string}
 */
export function pickVideoRecorderMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
  ];
  for (const type of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch { /* ignore */ }
  }
  return '';
}

/**
 * @param {string} mime
 * @returns {string} file extension without the leading dot
 */
export function extensionForVideoMime(mime) {
  if ((mime || '').includes('mp4')) return 'mp4';
  return 'webm';
}

/**
 * Build a download filename: "clip.mp4" + processed → "clip-processed.webm".
 * @param {string} [sourceName]
 * @param {string} ext
 * @param {string} [suffix='processed']
 */
export function processedVideoFilename(sourceName, ext, suffix = 'processed') {
  const base = String(sourceName || 'export')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w.\- ()[\]]+/g, '_')
    .slice(0, 80) || 'export';
  return `${base}-${suffix}.${ext}`;
}

/**
 * Trigger a browser download (or return the blob for desktop save).
 * @param {Blob} blob
 * @param {string} filename
 */
export function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { a.remove(); } catch { /* ignore */ }
    try { URL.revokeObjectURL(url); } catch { /* ignore */ }
  }, 4000);
}

/**
 * Remux processed audio onto the original video picture.
 *
 * @param {File|Blob} sourceVideo
 * @param {AudioBuffer} audioBuffer  processed mix (mono or stereo)
 * @param {object} [opts]
 * @param {(pct: number, stage: string) => void} [opts.onProgress]
 * @param {number} [opts.startSec=0] crop in
 * @param {number} [opts.endSec] crop out (defaults to full audio)
 * @returns {Promise<{ blob: Blob, filename: string, mime: string }>}
 */
export async function exportVideoWithProcessedAudio(sourceVideo, audioBuffer, opts = {}) {
  if (!(sourceVideo instanceof Blob)) {
    throw new TypeError('[VIP][video-export] sourceVideo must be a File or Blob.');
  }
  if (!audioBuffer || !audioBuffer.length || !audioBuffer.sampleRate) {
    throw new TypeError('[VIP][video-export] audioBuffer is required.');
  }
  if (typeof document === 'undefined' || !document.createElement) {
    throw new Error('[VIP][video-export] Browser document required for video export.');
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('[VIP][video-export] MediaRecorder is not available in this browser.');
  }

  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const startSec = Math.max(0, Number(opts.startSec) || 0);
  const endSec = Number.isFinite(opts.endSec)
    ? Math.max(startSec + 0.05, opts.endSec)
    : audioBuffer.duration;
  const exportDuration = Math.max(0.05, endSec - startSec);

  const mime = pickVideoRecorderMime();
  if (!mime) {
    throw new Error('[VIP][video-export] No supported video MediaRecorder MIME type.');
  }

  onProgress(2, 'loading-video');

  const objectUrl = URL.createObjectURL(sourceVideo);
  const video = document.createElement('video');
  video.playsInline = true;
  video.muted = true; // picture only — audio comes from the AudioBuffer
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
  document.body.appendChild(video);
  video.src = objectUrl;

  let audioCtx = null;
  let recorder = null;

  try {
    await waitForVideoReady(video);
    onProgress(8, 'preparing');

    // Seek video to crop start before capturing the stream.
    try {
      video.currentTime = startSec;
      await waitForSeek(video);
    } catch { /* best-effort */ }

    if (typeof video.captureStream !== 'function' && typeof video.mozCaptureStream !== 'function') {
      throw new Error('[VIP][video-export] Video captureStream() is not supported.');
    }
    const captureFn = video.captureStream || video.mozCaptureStream;
    /** @type {MediaStream} */
    const pictureStream = captureFn.call(video);

    const videoTracks = pictureStream.getVideoTracks();
    if (!videoTracks.length) {
      throw new Error('[VIP][video-export] No video track available to remux.');
    }

    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    audioCtx = new AudioCtx({ sampleRate: audioBuffer.sampleRate });
    if (audioCtx.state === 'suspended') {
      try { await audioCtx.resume(); } catch { /* ignore */ }
    }

    const dest = audioCtx.createMediaStreamDestination();
    const sliced = sliceAudioBufferWindow(audioCtx, audioBuffer, startSec, endSec);
    const bufferSource = audioCtx.createBufferSource();
    bufferSource.buffer = sliced;
    bufferSource.connect(dest);

    const mixed = new MediaStream([
      ...videoTracks,
      ...dest.stream.getAudioTracks(),
    ]);

    const chunks = [];
    recorder = new MediaRecorder(mixed, {
      mimeType: mime,
      videoBitsPerSecond: 4_000_000,
      audioBitsPerSecond: 192_000,
    });

    const recorded = new Promise((resolve, reject) => {
      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunks.push(ev.data);
      };
      recorder.onerror = () => reject(new Error('[VIP][video-export] MediaRecorder failed.'));
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mime.split(';')[0] || 'video/webm' });
        if (!blob.size) {
          reject(new Error('[VIP][video-export] Recorded video is empty.'));
          return;
        }
        resolve(blob);
      };
    });

    onProgress(12, 'recording');
    recorder.start(250);

    // Start audio + picture together.
    const playPromise = video.play();
    bufferSource.start(0);
    if (playPromise && typeof playPromise.then === 'function') {
      await playPromise.catch(() => {
        /* muted autoplay should succeed; ignore if not */
      });
    }

    // Progress ticker while recording in (near) real time.
    const t0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const elapsed = (performance.now() - t0) / 1000;
        const pct = Math.min(96, 12 + Math.round((elapsed / exportDuration) * 84));
        onProgress(pct, 'recording');
        if (elapsed >= exportDuration - 0.02) {
          resolve();
          return;
        }
        // Prefer requestVideoFrameCallback when available for smoother progress.
        if (typeof video.requestVideoFrameCallback === 'function') {
          video.requestVideoFrameCallback(() => tick());
        } else {
          setTimeout(tick, 100);
        }
      };
      setTimeout(tick, 50);
      setTimeout(resolve, Math.ceil(exportDuration * 1000) + 400);
    });

    try { video.pause(); } catch { /* ignore */ }
    try { bufferSource.stop(); } catch { /* ignore */ }
    if (recorder.state !== 'inactive') recorder.stop();

    const blob = await recorded;
    onProgress(100, 'complete');

    const ext = extensionForVideoMime(mime);
    const filename = processedVideoFilename(sourceVideo.name, ext);
    return { blob, filename, mime: blob.type || mime };
  } finally {
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
    try { video.pause(); } catch { /* ignore */ }
    try { video.removeAttribute('src'); video.load(); } catch { /* ignore */ }
    try { video.remove(); } catch { /* ignore */ }
    try { URL.revokeObjectURL(objectUrl); } catch { /* ignore */ }
    if (audioCtx) {
      try { await audioCtx.close(); } catch { /* ignore */ }
    }
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function waitForVideoReady(video) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('[VIP][video-export] Timed out loading source video.'));
    }, 120_000);
    const done = () => {
      if (settled) return;
      if ((video.videoWidth || 0) <= 0 && (video.readyState || 0) < 1) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const fail = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(video.error?.message || 'Source video failed to load.'));
    };
    video.addEventListener('loadeddata', done, { once: true });
    video.addEventListener('loadedmetadata', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    if (video.readyState >= 2) done();
  });
}

function waitForSeek(video) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    const onSeeked = () => {
      clearTimeout(timer);
      resolve();
    };
    video.addEventListener('seeked', onSeeked, { once: true });
  });
}

/**
 * Copy a time window of an AudioBuffer into a new buffer on the given context.
 * @param {AudioContext} ctx
 * @param {AudioBuffer} buffer
 * @param {number} startSec
 * @param {number} endSec
 * @returns {AudioBuffer}
 */
function sliceAudioBufferWindow(ctx, buffer, startSec, endSec) {
  const sr = buffer.sampleRate;
  const start = Math.max(0, Math.floor(startSec * sr));
  const end = Math.min(buffer.length, Math.ceil(endSec * sr));
  const length = Math.max(1, end - start);
  const channels = Math.min(2, buffer.numberOfChannels || 1);
  const out = ctx.createBuffer(channels, length, sr);
  for (let ch = 0; ch < channels; ch++) {
    const src = buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1));
    out.copyToChannel(src.subarray(start, start + length), ch);
  }
  return out;
}

export default exportVideoWithProcessedAudio;
