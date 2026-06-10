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
 */
'use strict';

import { SAMPLE_RATE, MAX_CHANNELS, resampledLength } from '../core/audio-config.js';

/** Accepted MIME prefixes. Container formats vary; the decoder is the judge. */
const ACCEPTED_TYPES = ['audio/', 'video/'];

/** Refuse absurd inputs before burning memory (2 GB). */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

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
 * Decode a blob into an AudioBuffer using a temporary AudioContext.
 * The context is closed immediately after decoding.
 * @param {Blob} blob
 * @returns {Promise<AudioBuffer>}
 */
async function decodeBlob(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctx) {
    throw new Error('[VIP][FileIngestion] Web Audio API is not available.');
  }
  const ctx = new Ctx();
  try {
    return await ctx.decodeAudioData(arrayBuffer);
  } catch (err) {
    throw new Error(
      `[VIP][FileIngestion] Could not decode '${blob.name || 'file'}': ${err?.message || err}`
    );
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
 * @returns {Promise<IngestedAudio>}
 */
export async function ingestFile(file, hooks = {}) {
  const { onProgress = () => {} } = hooks;
  assertIngestible(file);

  onProgress('decoding');
  const decoded = await decodeBlob(file);

  onProgress('resampling');
  const canonical = await resampleToCanonical(decoded);

  onProgress('done');
  const channelData = extractChannels(canonical);
  return {
    channelData,
    sampleRate: SAMPLE_RATE,
    duration: canonical.duration,
    numberOfChannels: channelData.length,
    sourceName: file.name || 'untitled',
  };
}

export default ingestFile;
