/**
 * VoiceIsolate Pro — File Ingestion (Layer 3: Pipeline)
 *
 * Accepts user-supplied audio/video blobs, decodes them, and resamples to
 * the canonical 48 000 Hz so every downstream consumer (MLWorker,
 * PlaybackMixer) sees one uniform format.
 *
 * Decode strategy:
 *   1. Blob → ArrayBuffer → decodeAudioData (fast path)
 *   2. On failure: hidden <audio>/<video> + OfflineAudioContext
 *      (handles M4A/MP4/AAC containers Web Audio cannot demux directly)
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
import { inferMediaKind } from '../core/media-types.js';
import { pickAudioFile, isDesktopShell } from '../core/DesktopBridge.js';
import { decodeBlobToAudioBuffer } from './media-decode.js';

export { isDesktopShell, pickAudioFile } from '../core/DesktopBridge.js';

/** Accepted MIME prefixes. Container formats vary; the decoder is the judge. */
const ACCEPTED_TYPES = ['audio/', 'video/'];

/** Refuse absurd inputs before burning memory (2 GB). */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Map isolation mode to model IDs array for MLWorker.
 * This is the bridge between UI mode selection and backend model chaining.
 */
const MODE_TO_MODELS = Object.freeze({
  'standard': ['demucs'],
  'maximum': ['demucs', 'rnnoise'],
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
  const kind = inferMediaKind(blob);
  if (kind === 'midi') {
    throw new TypeError(
      '[VIP][FileIngestion] MIDI files are not supported. Use an audio file (WAV, MP3, etc).'
    );
  }
  const type = blob.type || '';
  // Some OSes hand over files with an empty or generic MIME type — fall back to
  // filename extension before rejecting.
  if (type && !ACCEPTED_TYPES.some((p) => type.startsWith(p)) && kind === null) {
    throw new TypeError(
      `[VIP][FileIngestion] Unsupported type '${type}'. Provide an audio or video file.`
    );
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
 * @param {(stage: 'decoding'|'resampling'|'done', percent?: number) => void} [hooks.onProgress]
 * @param {string} [hooks.isolationMode] - Isolation mode ('standard', 'maximum', 'noise-suppression')
 * @returns {Promise<IngestedAudio>}
 */
/**
 * Open the native desktop file picker (Electron) and ingest the selection.
 * Returns null when the user cancels or when not running in the desktop shell.
 *
 * @param {object} [hooks] — same hooks as ingestFile()
 * @returns {Promise<IngestedAudio|null>}
 */
export async function pickAndIngestFile(hooks = {}) {
  if (!isDesktopShell()) {
    throw new Error(
      '[VIP][FileIngestion] pickAndIngestFile() requires the Electron desktop shell.'
    );
  }
  const file = await pickAudioFile();
  if (!file) return null;
  return ingestFile(file, hooks);
}

export async function ingestFile(file, hooks = {}) {
  const { onProgress = () => {}, isolationMode } = hooks;
  assertIngestible(file);

  onProgress('decoding', 5);
  // Yield so the presentation layer can paint a loading state before the
  // (potentially heavy) main-thread decode call.
  await new Promise((resolve) => queueMicrotask(resolve));
  onProgress('decoding', 15);
  const decoded = await decodeBlobToAudioBuffer(file);
  onProgress('decoding', 100);

  onProgress('resampling', 10);
  const canonical = await resampleToCanonical(decoded);
  onProgress('resampling', 100);

  onProgress('done', 100);
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