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
import { inferMediaKind, isGenericMimeType, resolveMediaKind } from '../core/media-types.js';
import { pickAudioFile, isDesktopShell } from '../core/DesktopBridge.js';
import { decodeBlobToAudioBuffer } from './media-decode.js';
import { stageEnd, stageStart } from './PipelineTiming.js';

export { isDesktopShell, pickAudioFile } from '../core/DesktopBridge.js';

/** Accepted MIME prefixes. Container formats vary; the decoder is the judge. */
const ACCEPTED_TYPES = ['audio/', 'video/'];

/** No practical upload size cap — whole files are decoded on-device. */
const MAX_FILE_BYTES = Number.MAX_SAFE_INTEGER;
const RESAMPLE_MIN_TIMEOUT_MS = 30_000;
const RESAMPLE_MAX_TIMEOUT_MS = 180_000;

function createAbortError() {
  return typeof DOMException !== 'undefined'
    ? new DOMException('Ingestion cancelled', 'AbortError')
    : Object.assign(new Error('Ingestion cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw createAbortError();
}

/**
 * Map isolation mode to model IDs array for MLWorker.
 * This is the bridge between UI mode selection and backend model chaining.
 */
const MODE_TO_MODELS = Object.freeze({
  'standard': ['bsrnn_vocals'],
  'maximum': ['bsrnn_vocals', 'rnnoise'],
  'noise-suppression': ['rnnoise'],
  // Prompted / SAM path — no ONNX chain; ProcessingOrchestrator routes to providers.
  'prompted': [],
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
 *
 * Generic MIME types (`application/octet-stream`, empty) are allowed through —
 * Windows often tags valid media this way. The decoder is the final judge.
 *
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
    throw new RangeError('[VIP][FileIngestion] File exceeds the maximum supported size.');
  }
  const kind = inferMediaKind(blob);
  if (kind === 'midi') {
    throw new TypeError(
      '[VIP][FileIngestion] MIDI files are not supported. Use an audio file (WAV, MP3, etc).'
    );
  }
  const type = blob.type || '';
  // Some OSes hand over files with an empty or generic MIME type — fall back to
  // filename extension (and later magic-byte sniff) before rejecting.
  if (
    type &&
    !isGenericMimeType(type) &&
    !ACCEPTED_TYPES.some((p) => type.startsWith(p)) &&
    kind === null
  ) {
    throw new TypeError(
      `[VIP][FileIngestion] Unsupported type '${type}'. Provide an audio or video file.`
    );
  }
}

/**
 * Async validation that also sniffs magic bytes when MIME/extension are useless.
 * Prefer this over assertIngestible for user-facing upload paths.
 * @param {Blob} blob
 * @returns {Promise<'audio'|'video'>}
 */
export async function assertIngestibleAsync(blob) {
  assertIngestible(blob);
  let kind = inferMediaKind(blob);
  if (kind === 'midi') {
    throw new TypeError(
      '[VIP][FileIngestion] MIDI files are not supported. Use an audio file (WAV, MP3, etc).'
    );
  }
  if (!kind) {
    kind = await resolveMediaKind(blob);
  }
  if (kind !== 'audio' && kind !== 'video') {
    // Still allow empty/generic types into the decoder — many valid files sniff poorly.
    if (isGenericMimeType(blob.type) || !blob.type) {
      return 'audio';
    }
    throw new TypeError(
      `[VIP][FileIngestion] Unsupported type '${blob.type || 'unknown'}'. Provide an audio or video file.`
    );
  }
  return kind;
}

/**
 * Resample an AudioBuffer to SAMPLE_RATE via OfflineAudioContext.
 * Returns the input untouched when it is already canonical.
 * @param {AudioBuffer} buffer
 * @param {object} [options]
 * @param {AbortSignal} [options.signal]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<AudioBuffer>}
 */
export async function resampleToCanonical(buffer, options = {}) {
  const signal = options.signal || null;
  throwIfCancelled(signal);
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
  const durationMs = Math.ceil((buffer.duration || (buffer.length / buffer.sampleRate) || 0) * 1000);
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Number(options.timeoutMs)
    : Math.min(RESAMPLE_MAX_TIMEOUT_MS, Math.max(RESAMPLE_MIN_TIMEOUT_MS, 30_000 + durationMs));

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    };
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const stopRendering = () => {
      try {
        const stopping = offline.suspend?.(0);
        stopping?.catch?.(() => {});
      } catch { /* best effort */ }
    };
    const onAbort = () => {
      stopRendering();
      settle(() => reject(createAbortError()));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      stopRendering();
      const error = new Error('[VIP][FileIngestion] Resampling timeout');
      error.name = 'TimeoutError';
      error.code = 'RESAMPLE_TIMEOUT';
      settle(() => reject(error));
    }, timeoutMs);

    let rendering;
    try {
      rendering = offline.startRendering();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    Promise.resolve(rendering).then(
      (result) => settle(() => resolve(result)),
      (error) => settle(() => reject(error)),
    );
  });
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
  const { onProgress = () => {}, isolationMode, signal = null, audioContext = null } = hooks;
  throwIfCancelled(signal);
  // Magic-byte sniff for Windows octet-stream / extensionless renames.
  await assertIngestibleAsync(file);
  throwIfCancelled(signal);

  onProgress('decoding', 5);
  stageStart('decode');
  const decoded = await decodeBlobToAudioBuffer(file, {
    onProgress: (pct) => onProgress('decoding', pct),
    audioContext,
    signal,
    decodeTimeoutMs: hooks.decodeTimeoutMs,
    readTimeoutMs: hooks.readTimeoutMs,
  });
  throwIfCancelled(signal);
  stageEnd('decode');
  onProgress('decoding', 100);

  onProgress('resampling', 10);
  stageStart('resample');
  const canonical = await resampleToCanonical(decoded, {
    signal,
    timeoutMs: hooks.resampleTimeoutMs,
  });
  throwIfCancelled(signal);
  stageEnd('resample');
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
