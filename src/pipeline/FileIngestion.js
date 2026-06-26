/**
 * VoiceIsolate Pro — File Ingestion (Layer 3: Pipeline)
 *
 * Accepts user-supplied audio/video blobs, decodes them, and resamples to
 * the canonical 48 000 Hz so every downstream consumer (MLWorker,
 * PlaybackMixer) sees one uniform format.
 *
 * Decode strategy:
 *   1. Blob → ArrayBuffer
 *   2. decodeAudioData on a short-lived AudioContext (handles audio AND the
 *      audio track of video containers the browser can demux)
 *   3. If the decoded rate ≠ 48 000 Hz, render through an OfflineAudioContext
 *      sized for the target rate (high-quality browser-native resampling)
 *
 * Output contract: { channelData: Float32Array[], sampleRate, duration }.
 * channelData arrays are detached-safe copies — they may be transferred to
 * MLWorker without invalidating the caller.
 *
 * Model Chaining Support:
 * Accepts an optional `isolationMode` parameter that maps to modelIds array:
 *   - "standard" → ['bsrnn_vocals'] (default)
 *   - "maximum" → ['bsrnn_vocals', 'rnnoise'] (chain)
 *   - "noise-suppression" → ['rnnoise']
 */
'use strict';

import { SAMPLE_RATE, MAX_CHANNELS, resampledLength } from '../core/audio-config.js';

/** Accepted MIME prefixes. Container formats vary; the decoder is the judge. */
const ACCEPTED_TYPES = ['audio/', 'video/'];

/** Refuse absurd inputs before burning memory (2 GB). */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** Cap for the real-time media-element fallback (30 min). */
const MAX_MEDIA_FALLBACK_SECONDS = 30 * 60;

/**
 * Map isolation mode to model IDs array for MLWorker.
 * This is the bridge between UI mode selection and backend model chaining.
 */
const MODE_TO_MODELS = Object.freeze({
  'standard': ['bsrnn_vocals'],
  'maximum': ['bsrnn_vocals', 'rnnoise'],
  'noise-suppression': ['rnnoise'],
});

/** Default isolation mode when none is specified. */
const DEFAULT_ISOLATION_MODE = 'standard';

/**
 * Get model IDs for a given isolation mode.
 * @param {string} [mode] - Isolation mode ('standard', 'maximum', 'noise-suppression')
 * @returns {string[]} Array of model IDs to process in sequence
 */
export function getModelIdsForMode(mode) {
  const normalizedMode = mode || DEFAULT_ISOLATION_MODE;
  const modelIds = MODE_TO_MODELS[normalizedMode];
  
  if (!modelIds) {
    console.warn(
      `[VIP][FileIngestion] Unknown isolation mode '${normalizedMode}', ` +
      `falling back to '${DEFAULT_ISOLATION_MODE}'`
    );
    return MODE_TO_MODELS[DEFAULT_ISOLATION_MODE];
  }
  
  return modelIds;
}

/**
 * Validate that an isolation mode is known.
 * @param {string} mode
 * @returns {boolean}
 */
export function isValidIsolationMode(mode) {
  return Object.prototype.hasOwnProperty.call(MODE_TO_MODELS, mode);
}

/**
 * @typedef {object} IngestedAudio
 * @property {Float32Array[]} channelData  one Float32Array per channel (≤ 2)
 * @property {number} sampleRate           always SAMPLE_RATE (48 000)
 * @property {number} duration             seconds
 * @property {number} numberOfChannels     channelData.length
 * @property {string} sourceName           original file name (when available)
 */

/**
 * Validate that a blob looks ingestible. Throws descriptive errors so the
 * presentation layer can surface them verbatim.
 * @param {Blob} blob
 */
export function assertIngestible(blob) {
  if (!(blob instanceof Blob)) {
    throw new TypeError('[VIP][FileIngestion] Expected a File or Blob.');
  }
  if (blob.size === 0) {
    throw new RangeError('[VIP][FileIngestion] File is empty.');
  }
  if (blob.size > MAX_FILE_BYTES) {
    throw new RangeError('[VIP][FileIngestion] File exceeds the 2 GB limit.');
  }
  const type = blob.type || '';
  // Some OSes hand over files with an empty MIME type — let the decoder try.
  if (type && !ACCEPTED_TYPES.some((p) => type.startsWith(p))) {
    throw new TypeError(
      `[VIP][FileIngestion] Unsupported type '${type}'. Provide an audio or video file.`
    );
  }
}

/**
 * Fallback decoder for formats that decodeAudioData() rejects (e.g. HE-AAC v2
 * in .m4a files from Android voice recorders).  Routes the file through an
 * HTMLMediaElement → MediaElementSource → MediaStreamDestination → MediaRecorder
 * pipeline, captures the re-encoded WebM, then decodes that with decodeAudioData.
 *
 * Requires a browser environment (DOM + MediaRecorder).
 * @param {Blob} blob
 * @param {(stage: string) => void} onProgress
 * @returns {Promise<AudioBuffer>}
 */
async function decodeViaMediaElement(blob, onProgress = () => {}) {
  const url = URL.createObjectURL(blob);
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  const actx = new Ctx();
  try {
    // Resume the context — it may start suspended outside the original user-gesture
    // call stack. Most browsers permit resume() after any prior page interaction.
    if (actx.state === 'suspended') {
      await actx.resume().catch(() => { /* proceed regardless */ });
    }

    const audio = document.createElement('audio');
    audio.preload = 'auto';
    // muted=true lets the element autoplay without a live user gesture;
    // createMediaElementSource() still captures the audio for Web Audio.
    audio.muted = true;

    const duration = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Media load timed out after 15 s')), 15_000
      );
      audio.addEventListener('loadedmetadata', () => {
        clearTimeout(timeout);
        resolve(audio.duration);
      }, { once: true });
      audio.addEventListener('error', () => {
        clearTimeout(timeout);
        const e = audio.error;
        reject(new Error(e ? `Media error ${e.code}` : 'Browser could not load this file'));
      }, { once: true });
      audio.src = url;
    });

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('Media element reported no valid duration.');
    }
    if (duration > MAX_MEDIA_FALLBACK_SECONDS) {
      throw new Error(
        `File is ${Math.round(duration / 60)} min long; the real-time fallback ` +
        'decoder is capped at 30 min. Convert to MP3 or WAV first.'
      );
    }

    onProgress('transcoding');

    const source = actx.createMediaElementSource(audio);
    const dest = actx.createMediaStreamDestination();
    source.connect(dest);

    const mimeType =
      ['audio/webm;codecs=pcm', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg']
        .find((m) => MediaRecorder.isTypeSupported(m)) || '';
    const chunks = [];
    const recorder = new MediaRecorder(dest.stream, mimeType ? { mimeType } : {});

    const capturePromise = new Promise((resolve, reject) => {
      recorder.addEventListener('dataavailable', (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      });
      recorder.addEventListener('stop', () =>
        resolve(new Blob(chunks, { type: mimeType || 'audio/webm' }))
      );
      recorder.addEventListener('error', (e) =>
        reject(e.error || new Error('MediaRecorder error'))
      );
    });

    recorder.start();
    await audio.play();
    await new Promise((resolve, reject) => {
      audio.addEventListener('ended', resolve, { once: true });
      audio.addEventListener('error', () =>
        reject(new Error('Playback error during capture')), { once: true }
      );
    });
    recorder.stop();

    const capturedBlob = await capturePromise;
    if (capturedBlob.size < 128) {
      throw new Error(
        'Capture produced no audio — the browser may not support this codec.'
      );
    }
    const capturedBuffer = await capturedBlob.arrayBuffer();
    return await actx.decodeAudioData(capturedBuffer);
  } finally {
    URL.revokeObjectURL(url);
    try { await actx.close(); } catch { /* already closed */ }
  }
}

/**
 * Decode a blob into an AudioBuffer.
 * Primary: decodeAudioData on a temporary AudioContext (fast, memory-efficient).
 * Fallback: media-element real-time capture via MediaRecorder — used when
 * decodeAudioData rejects (e.g. HE-AAC v2 in .m4a files).
 * @param {Blob} blob
 * @param {(stage: string) => void} [onProgress]
 * @returns {Promise<AudioBuffer>}
 */
async function decodeBlob(blob, onProgress = () => {}) {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) {
    throw new Error('[VIP][FileIngestion] Web Audio API is not available.');
  }
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } catch (primaryErr) {
    // Attempt the media-element fallback only in a full browser environment.
    const canFallback =
      typeof document !== 'undefined' &&
      typeof MediaRecorder !== 'undefined';
    if (!canFallback) {
      throw new Error(
        `[VIP][FileIngestion] Could not decode '${blob.name || 'file'}': ${primaryErr?.message || primaryErr}`
      );
    }
    try {
      console.warn(
        `[VIP][FileIngestion] decodeAudioData failed for '${blob.name || 'file'}'; ` +
        'trying media-element fallback (real-time capture).'
      );
      return await decodeViaMediaElement(blob, onProgress);
    } catch (fallbackErr) {
      const name = blob.name || 'file';
      const lname = name.toLowerCase();
      const mime  = (blob.type || '').toLowerCase();
      const isM4a = lname.endsWith('.m4a') || mime.includes('mp4') || mime.includes('x-m4a');
      const hint = isM4a
        ? ' Tip: converting to MP3 or WAV first (e.g. via Audacity or FFmpeg) will always work.'
        : '';
      throw new Error(
        `[VIP][FileIngestion] Could not decode '${name}'.${hint} ` +
        `(Web Audio: ${primaryErr?.message || primaryErr}; ` +
        `fallback: ${fallbackErr?.message || fallbackErr})`
      );
    }
  } finally {
    // Decode contexts are throwaway; never leak hardware handles.
    try { await ctx.close(); } catch { /* already closed */ }
  }
}

/**
 * Resample an AudioBuffer to SAMPLE_RATE via OfflineAudioContext.
 * Returns the input untouched when it is already canonical.
 * @param {AudioBuffer} buffer
 * @returns {Promise<AudioBuffer>}
 */
export async function resampleToCanonical(buffer) {
  if (buffer.sampleRate === SAMPLE_RATE) return buffer;

  const channels = Math.min(buffer.numberOfChannels, MAX_CHANNELS);
  const length = resampledLength(buffer.length, buffer.sampleRate);
  const OfflineCtx = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OfflineCtx) {
    throw new Error('[VIP][FileIngestion] OfflineAudioContext is not available.');
  }

  const offline = new OfflineCtx(channels, length, SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start(0);
  return offline.startRendering();
}

/**
 * Extract ≤ MAX_CHANNELS channel arrays as independent copies.
 * @param {AudioBuffer} buffer
 * @returns {Float32Array[]}
 */
function extractChannels(buffer) {
  const channels = Math.min(buffer.numberOfChannels, MAX_CHANNELS);
  const out = [];
  for (let ch = 0; ch < channels; ch++) {
    // Copy: getChannelData views internal storage we must not transfer away.
    out.push(new Float32Array(buffer.getChannelData(ch)));
  }
  return out;
}

/**
 * Ingest a user file: validate → decode → resample → extract channels.
 *
 * @param {File|Blob} file
 * @param {object} [hooks]
 * @param {(stage: 'decoding'|'resampling'|'done') => void} [hooks.onProgress]
 * @param {string} [hooks.isolationMode] - Isolation mode ('standard', 'maximum', 'noise-suppression')
 * @returns {Promise<IngestedAudio>}
 */
export async function ingestFile(file, hooks = {}) {
  const { onProgress = () => {}, isolationMode } = hooks;
  assertIngestible(file);

  onProgress('decoding');
  const decoded = await decodeBlob(file, onProgress);

  onProgress('resampling');
  const canonical = await resampleToCanonical(decoded);

  onProgress('done');
  const channelData = extractChannels(canonical);
  
  // Get model IDs for the selected isolation mode
  const modelIds = getModelIdsForMode(isolationMode);
  
  return {
    channelData,
    sampleRate: SAMPLE_RATE,
    duration: canonical.duration,
    numberOfChannels: channelData.length,
    sourceName: file.name || 'untitled',
    modelIds, // Pass model IDs to caller for MLWorker processing
    isolationMode: isolationMode || DEFAULT_ISOLATION_MODE,
  };
}

export default ingestFile;
