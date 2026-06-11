/**
 * VoiceIsolate Pro — Canonical ML Model Manifest (Layer 1: Core)
 *
 * Single source of truth for every ONNX model the pipeline may execute:
 * delivery URL, size, expected SHA-256 integrity hash, and I/O contract.
 *
 * MLWorker.js receives entries from this manifest via its `init` message
 * (classic workers cannot import ES modules) — never duplicate this data.
 *
 * Both shipped models are trained spectral-mask networks committed to the
 * repo under public/app/models/ (provenance and training notes live in
 * public/app/models/models-manifest.json). They share one inference
 * contract enforced by MLWorker's 'spectral-mask' strategy:
 *
 *   input  'input'  float32 [batch, 2049]  — STFT magnitude frames
 *                                            (fft 4096, hop 1024, Hann, 48 kHz)
 *   output 'output' float32 [batch, 2049]  — sigmoid mask in [0, 1],
 *                                            multiplied into the complex
 *                                            spectrum before the inverse STFT
 *
 * INTEGRITY: `sha256` is the lowercase hex digest of the .onnx file and is
 * verified by MLWorker before a session is created. Recompute when swapping
 * a binary:
 *   node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" public/app/models/<file>.onnx
 * A `null` hash disables verification, logs a loud warning, and is tolerated
 * ONLY in development (see CLAUDE.md §3). Shipped entries must stay pinned.
 *
 * Pure data module: no DOM, no Web Audio, no I/O, no side effects.
 */
'use strict';

export const MODEL_MANIFEST = Object.freeze({
  rnnoise: Object.freeze({
    id: 'rnnoise',
    name: 'BiGRU Noise Suppressor',
    task: 'noise-suppression',
    url: '/app/models/rnnoise_suppressor.onnx',
    sizeBytes: 2027576,
    quantization: 'fp32',
    sha256: '0bc4319f433f9b19411cbc1727f0b6eab83b3ccb89825d8229cbb28ccc3b62b6',
    /** Inference strategy: STFT magnitude → mask → masked iSTFT overlap-add. */
    strategy: 'spectral-mask',
    fftSize: 4096,
    hopSize: 1024,
    bins: 2049,
    maxBatchFrames: 32,
    sampleRate: 48000,
    io: Object.freeze({
      input: 'input',                // [batch, 2049] Float32 magnitudes
      output: 'output',              // [batch, 2049] Float32 mask (sigmoid)
    }),
  }),

  bsrnn_vocals: Object.freeze({
    id: 'bsrnn_vocals',
    name: 'Band-Split RNN Vocal Extractor',
    task: 'vocal-separation',
    url: '/app/models/bsrnn_vocals.onnx',
    sizeBytes: 3870554,
    quantization: 'fp32',
    sha256: '7edd7c51962e21086841b6c65ec1304deed75555e1bb05d64ec7c134a39c8141',
    /** Inference strategy: STFT magnitude → mask → masked iSTFT overlap-add. */
    strategy: 'spectral-mask',
    fftSize: 4096,
    hopSize: 1024,
    bins: 2049,
    maxBatchFrames: 32,
    sampleRate: 48000,
    io: Object.freeze({
      input: 'input',                // [batch, 2049] Float32 magnitudes
      output: 'output',              // [batch, 2049] Float32 vocal mask
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
