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
    maxBatchFrames: 96,
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
    sizeBytes: 148932181,
    quantization: 'int8',
    // Not shipped in the default git tree (~84–149 MB). Drop the ONNX under
    // public/app/models/ to enable. Engineer default chain uses BSRNN only.
    delivery: 'optional',
    optional: true,
    shipped: false,
    sha256: '19be0f2c8e617e5ee2da0c2861f2f96e1a7f656ebf4b696b485e16f64b3bdac2',
    strategy: 'waveform',
    sampleRate: 44100,
    segmentSamples: 344520,
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
    // Larger base batches cut session.run overhead (effectiveBatchFrames multiplies further).
    maxBatchFrames: 128,
    sampleRate: 48000,
    io: Object.freeze({
      input: 'input',                // [batch, 2049] Float32 magnitudes
      output: 'output',              // [batch, 2049] Float32 vocal mask
    }),
  }),

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

  // ── Speaker embedding (optional ECAPA) ────────────────────────────────
  // When a pinned ECAPA-TDNN ONNX is placed here, TargetSpeaker can switch
  // from local mel voiceprint to neural embeddings. Until then, enrollment
  // uses src/core/TargetSpeaker.js (melBands) — still fully local.
  ecapa_tdnn: Object.freeze({
    id: 'ecapa_tdnn',
    name: 'ECAPA-TDNN Speaker Embedding (optional)',
    task: 'speaker-embedding',
    url: '/app/models/ecapa_tdnn.onnx',
    sizeBytes: null,
    quantization: 'fp32',
    delivery: 'optional',
    optional: true,
    shipped: false,
    sha256: null,
    strategy: 'speaker-embedding',
    sampleRate: 16000,
    io: Object.freeze({
      input: 'input',
      output: 'embedding',
    }),
  }),

  // ── SAM-Audio ONNX (optional) — Android WebView / browser ORT path ─────
  // Place a verified SAM-Audio ONNX export at this path for on-device ORT.
  // Desktop prefers the Python local worker (real Meta weights). Without the
  // file, prompted isolation uses USM query priors (always local).
  sam_audio: Object.freeze({
    id: 'sam_audio',
    name: 'SAM-Audio (ONNX, optional)',
    task: 'prompted-source-separation',
    url: '/app/models/sam_audio.onnx',
    sizeBytes: null,
    quantization: 'fp16',
    delivery: 'optional',
    optional: true,
    shipped: false,
    sha256: null,
    strategy: 'sam-audio-onnx',
    sampleRate: 48000,
    io: Object.freeze({
      input: 'input',
      output: 'output',
    }),
  }),

  // ── Universal / query-based source separation (optional AudioSep-class) ──
  // Weights are optional. When missing, USMNode falls back to classical NMF +
  // language-prior masks in src/core/UniversalSourceMatrix.js (always available).
  // Drop an ONNX export at the URL below and pin sha256 before shipping.
  universal_separator: Object.freeze({
    id: 'universal_separator',
    name: 'Universal Query Separator (AudioSep-class)',
    task: 'universal-source-separation',
    url: '/app/models/universal-separator.onnx',
    sizeBytes: null,
    quantization: 'fp32',
    delivery: 'optional',
    sha256: null,
    strategy: 'universal-query',
    fftSize: 4096,
    hopSize: 1024,
    bins: 2049,
    maxBatchFrames: 64,
    sampleRate: 48000,
    io: Object.freeze({
      // Expected when a real AudioSep-class ONNX is provided:
      //   audio  float32 [1, T]  and/or  mag [batch, 2049]
      //   query  optional text embedding path handled inside the graph
      //   masks  float32 [K, frames, bins] or [K, T]
      input: 'input',
      output: 'output',
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
    (entry.sizeBytes === null || (Number.isInteger(entry.sizeBytes) && entry.sizeBytes > 0)) &&
    (entry.sha256 === null || /^[0-9a-f]{64}$/.test(entry.sha256)) &&
    entry.io && typeof entry.io.input === 'string' && typeof entry.io.output === 'string'
  );
}

export default MODEL_MANIFEST;
