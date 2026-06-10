/**
 * VoiceIsolate Pro — Canonical ML Model Manifest (Layer 1: Core)
 *
 * Single source of truth for every ONNX model the pipeline may execute:
 * delivery URL, size, expected SHA-256 integrity hash, and I/O contract.
 *
 * MLWorker.js receives entries from this manifest via its `init` message
 * (classic workers cannot import ES modules) — never duplicate this data.
 *
 * INTEGRITY: `sha256` is the lowercase hex digest of the .onnx file.
 * When provisioning a model binary, compute its hash:
 *   node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" public/models/<file>.onnx
 * and pin it here. A `null` hash disables verification, logs a loud warning,
 * and is tolerated ONLY in development (see CLAUDE.md §3).
 *
 * Pure data module: no DOM, no Web Audio, no I/O, no side effects.
 */
'use strict';

export const MODEL_MANIFEST = Object.freeze({
  deepfilternet: Object.freeze({
    id: 'deepfilternet',
    name: 'DeepFilterNet3 (INT8)',
    task: 'noise-suppression',
    url: '/models/deepfilternet3_int8.onnx',
    sizeBytes: 5_242_880,            // ~5 MB
    quantization: 'int8',
    // TODO(provisioning): pin the real digest when the binary is committed.
    sha256: null,
    /** Inference strategy: frame-based, overlap-add reconstruction. */
    strategy: 'overlap-add',
    frameSize: 2048,
    hopSize: 512,
    io: Object.freeze({
      input: 'input_frame',          // [1, frameSize] Float32
      output: 'enhanced_frame',      // [1, frameSize] Float32
    }),
  }),

  mdx_net: Object.freeze({
    id: 'mdx_net',
    name: 'MDX-Net Vocal Separator (INT8)',
    task: 'vocal-separation',
    url: '/models/mdx_net_vocals_int8.onnx',
    sizeBytes: 41_943_040,           // ~40 MB
    quantization: 'int8',
    // TODO(provisioning): pin the real digest when the binary is committed.
    sha256: null,
    /** Inference strategy: fixed-length waveform segments, cross-faded. */
    strategy: 'segment-crossfade',
    segmentSamples: 48000 * 8,       // 8 s segments at the canonical rate
    overlapSamples: 48000,           // 1 s cross-fade between segments
    io: Object.freeze({
      input: 'mixture',              // [1, channels, segmentSamples] Float32
      output: 'vocals',              // [1, channels, segmentSamples] Float32
    }),
  }),
});

/** Stable list of model ids. */
export const MODEL_IDS = Object.freeze(Object.keys(MODEL_MANIFEST));

/**
 * Look up a manifest entry, throwing on unknown ids so typos fail fast.
 * @param {string} id
 * @returns {(typeof MODEL_MANIFEST)[keyof typeof MODEL_MANIFEST]}
 */
export function getModel(id) {
  const entry = MODEL_MANIFEST[id];
  if (!entry) {
    throw new Error(
      `[VIP][ModelManifest] Unknown model '${id}'. Known: ${MODEL_IDS.join(', ')}`
    );
  }
  return entry;
}

/**
 * Validate a manifest entry's shape before sending it to MLWorker.
 * @param {object} entry
 * @returns {boolean}
 */
export function isValidEntry(entry) {
  return Boolean(
    entry &&
    typeof entry.id === 'string' &&
    typeof entry.url === 'string' && entry.url.startsWith('/') &&
    Number.isInteger(entry.sizeBytes) && entry.sizeBytes > 0 &&
    (entry.sha256 === null || /^[0-9a-f]{64}$/.test(entry.sha256)) &&
    entry.io && typeof entry.io.input === 'string' && typeof entry.io.output === 'string'
  );
}

export default MODEL_MANIFEST;
