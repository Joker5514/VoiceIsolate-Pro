/**
 * ModelManifest.js - Single Source of Truth for ONNX Models
 *
 * This is the ONLY place where model URLs, hashes, and metadata should be defined.
 * Do NOT create duplicate model registries elsewhere.
 *
 * All workers (MLWorker.js, legacy ml-worker.js) should reference this manifest.
 *
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
  // ── Voice Activity Detection ──────────────────────────────────────────
  vad: Object.freeze({
    id: 'vad',
    name: 'Silero VAD',
    task: 'voice-activity-detection',
    url: '/app/models/silero_vad.onnx',
    sizeBytes: 2327524,
    quantization: 'fp32',
    sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
    strategy: 'vad',
    sampleRate: 16000, // Silero VAD operates at 16kHz
    io: Object.freeze({
      input: 'input',
      output: 'output',
    }),
  }),

  vad_int8: Object.freeze({
    id: 'vad_int8',
    name: 'Silero VAD (INT8 Quantized)',
    task: 'voice-activity-detection',
    url: '/app/models/silero_vad_int8.onnx',
    sizeBytes: 2376297,
    quantization: 'int8',
    sha256: '16748abf8870b6e380fb3c56b662e2fd565504d28c30e6159a27017a569c8b05',
    strategy: 'vad',
    sampleRate: 16000,
    io: Object.freeze({
      input: 'input',
      output: 'output',
    }),
  }),

  // ── Noise Suppression ─────────────────────────────────────────────────
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

  // ── Source Separation ─────────────────────────────────────────────────
  demucs: Object.freeze({
    id: 'demucs',
    name: 'Demucs v4 (Quantized)',
    task: 'source-separation',
    url: '/app/models/demucs_v4_quantized.onnx',
    sizeBytes: null, // TODO: measure actual file size when model is downloaded
    quantization: 'int8',
    // TODO: Model file not yet available (placeholder exists at public/app/models/demucs_v4_quantized.onnx.placeholder).
    // Compute hash when model is obtained via scripts/download-models.sh or scripts/export_demucs_onnx.py:
    // node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" public/app/models/demucs_v4_quantized.onnx
    sha256: null,
    strategy: 'waveform', // Demucs operates on raw waveforms
    sampleRate: 44100, // Demucs v4 native sample rate
    io: Object.freeze({
      input: 'input',
      output: 'output',
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

  chain_voice_n4: Object.freeze({
    id: 'chain_voice_n4',
    name: '4-Stem Voice Isolation Chain',
    task: 'multi-stage-stem-split',
    strategy: 'multi-stage-chain',
    sampleRate: 48000,
    stages: Object.freeze([
      Object.freeze({
        modelId: 'rnnoise',
        output: 'denoised',
      }),
      Object.freeze({
        modelId: 'bsrnn_vocals',
        input: 'denoised',
        output: 'voice',
      }),
    ]),
    outputs: Object.freeze([
      Object.freeze({ id: 'voice', label: 'Voice', source: 'voice' }),
      Object.freeze({ id: 'background', label: 'Background', source: 'residual', from: 'denoised', subtract: 'voice' }),
      Object.freeze({ id: 'noise', label: 'Noise', source: 'residual', from: 'input', subtract: 'denoised' }),
      Object.freeze({ id: 'master', label: 'Master', source: 'input' }),
    ]),
  bsrnn_complex: Object.freeze({
    id: 'bsrnn_complex',
    name: 'Band-Split RNN Vocal Extractor (Complex Spectrogram)',
    task: 'vocal-separation',
    url: '/app/models/bsrnn_vocals_complex.onnx',
    sizeBytes: null, // TODO: measure actual file size when model is exported
    quantization: 'fp32',
    // TODO: Model file not yet available (future use for offline processing).
    // Export using scripts/export_bsrnn_onnx.py with complex spectrogram output, then compute hash:
    // node -e "const c=require('crypto'),f=require('fs');console.log(c.createHash('sha256').update(f.readFileSync(process.argv[1])).digest('hex'))" public/app/models/bsrnn_vocals_complex.onnx
    sha256: null,
    /** 4D complex-spectrogram BSRNN (pretrained crlandsc/bsrnn-vocals).
     * Offline-only: consumed by offline-processor.js. NOT loaded by the
     * real-time worklet path. See scripts/export_bsrnn_onnx.py. */
    strategy: 'complex-spectrogram',
    fftSize: 4096,
    hopSize: 1024,
    sampleRate: 48000,
    io: Object.freeze({
      input: 'input',   // 4D complex spectrogram tensor
      output: 'output', // 4D complex spectrogram tensor
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
  if (entry && entry.strategy === 'multi-stage-chain') {
    return Boolean(
      typeof entry.id === 'string' &&
      Array.isArray(entry.stages) && entry.stages.length > 0 &&
      Array.isArray(entry.outputs) && entry.outputs.length > 0 &&
      Number.isInteger(entry.sampleRate) && entry.sampleRate > 0
    );
  }
  return Boolean(
    entry &&
    typeof entry.id === 'string' &&
    typeof entry.url === 'string' && entry.url.startsWith('/') &&
    (entry.sizeBytes === null || (Number.isInteger(entry.sizeBytes) && entry.sizeBytes > 0)) &&
    (entry.sha256 === null || /^[0-9a-f]{64}$/.test(entry.sha256)) &&
    entry.io && typeof entry.io.input === 'string' && typeof entry.io.output === 'string'
  );
}

export default MODEL_MANIFEST;
