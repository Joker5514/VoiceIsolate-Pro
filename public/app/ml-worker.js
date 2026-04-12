// ─────────────────────────────────────────────────────────────────────────────
//  ml-worker.js  —  VoiceIsolate Pro · Threads from Space v8
//  Standard Web Worker (NOT AudioWorklet).
//
//  Responsibilities:
//    1. Load ONNX models via onnxruntime-web (WebGPU → WASM fallback)
//    2. Poll SharedArrayBuffer for new magnitude frames from dsp-processor
//    3. Run inference pipeline to produce a combined soft mask
//    4. Write mask back to outputSAB for dsp-processor to apply in-band
//
//  Tier gating:
//    Main thread passes allowedModels[] and allowedStages from auth.js getCaps()
//    so this worker never attempts to load models above the user's tier.
// ─────────────────────────────────────────────────────────────────────────────

// ort loaded from CDN — no bundler required
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/ort.esm.min.js';

const NUM_BINS = 2049; // (4096 / 2) + 1

let inputView  = null; // Float32Array view of inputSAB  (magnitudes written by DSP)
let outputView = null; // Float32Array view of outputSAB (mask written here)
let flagsIn    = null; // Int32Array: [frameCounter, ...]
let flagsOut   = null; // Int32Array: [..., maskReady]

let sessions      = {}; // { modelId: ort.InferenceSession }
let allowedModels = [];
let allowedStages = 8;
let lastFrame     = -1;
let pollTimer     = null;

// ── Model filename registry ───────────────────────────────────────────────────
const MODEL_FILES = {
  'silero-vad':  'silero_vad.onnx',
  'rnnoise':     'rnnoise.onnx',
  'demucs-v4':   'demucs_v4_int8.onnx',
  'ecapa-tdnn':  'ecapa_tdnn.onnx',
  'voicefixer':  'voicefixer.onnx',
};

// ── 1. Receive init message from app.js ──────────────────────────────────────
self.onmessage = async (ev) => {
  const { type, payload } = ev.data;

  if (type === 'init') {
    const {
      inputSAB,
      outputSAB,
      modelBasePath,
      preferredProviders = ['webgpu', 'wasm'],
      allowedModels: am = [],
      allowedStages: as_ = 8,
    } = payload;

    allowedModels = am;
    allowedStages = as_;

    // Attach typed array views onto the SharedArrayBuffers
    inputView  = new Float32Array(inputSAB);
    outputView = new Float32Array(outputSAB);
    flagsIn    = new Int32Array(inputSAB,  NUM_BINS * 4, 4);
    flagsOut   = new Int32Array(outputSAB, NUM_BINS * 4, 4);

    // Configure ORT WASM paths (CDN)
    ort.env.wasm.wasmPaths =
      'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/';

    await loadModels(modelBasePath, preferredProviders);
    startPollLoop();
    self.postMessage({ type: 'ready', models: Object.keys(sessions) });
  }

  if (type === 'unload') {
    clearInterval(pollTimer);
    sessions = {};
    self.postMessage({ type: 'unloaded' });
  }

  if (type === 'update_params') {
    if (payload.allowedModels) allowedModels = payload.allowedModels;
    if (payload.allowedStages) allowedStages = payload.allowedStages;
  }
};

// ── 2. Model loader ───────────────────────────────────────────────────────────
async function loadModels(basePath, providers) {
  for (const modelId of allowedModels) {
    const file = MODEL_FILES[modelId];
    if (!file) continue;

    const modelUrl = basePath + file;

    // Resolve available execution providers
    const eps = [];
    for (const p of providers) {
      if (p === 'webgpu') {
        try {
          const adapter = await navigator?.gpu?.requestAdapter();
          if (adapter) eps.push('webgpu');
        } catch { /* WebGPU unavailable */ }
      } else if (p === 'wasm') {
        eps.push('wasm');
      }
    }
    if (eps.length === 0) eps.push('wasm'); // guaranteed fallback

    try {
      sessions[modelId] = await ort.InferenceSession.create(modelUrl, {
        executionProviders:    eps,
        graphOptimizationLevel: 'all',
      });
      self.postMessage({ type: 'model_loaded', modelId, providers: eps });
      console.info(`[ml-worker] ${modelId} loaded via ${eps.join(',')}`);
    } catch (err) {
      console.warn(`[ml-worker] Failed to load ${modelId}:`, err.message);
      self.postMessage({ type: 'model_error', modelId, error: err.message });
    }
  }
}

// ── 3. SAB polling loop (50 Hz) ───────────────────────────────────────────────
function startPollLoop() {
  pollTimer = setInterval(pollOnce, 20);
}

async function pollOnce() {
  if (!flagsIn) return;
  const currentFrame = Atomics.load(flagsIn, 0);
  if (currentFrame === lastFrame) return;
  lastFrame = currentFrame;

  const magnitudes = new Float32Array(inputView.subarray(0, NUM_BINS));
  const mask       = await buildMask(magnitudes);

  outputView.set(mask);
  Atomics.store(flagsOut, 1, 1); // signal: mask ready
}

// ── 4. Combined mask inference pipeline ──────────────────────────────────────
async function buildMask(magnitudes) {
  const mask = new Float32Array(NUM_BINS).fill(1.0);

  // Stage 5 equivalent: Silero VAD — voice activity gate
  if (sessions['silero-vad'] && allowedStages >= 5) {
    try {
      const vadInput  = new ort.Tensor('float32', magnitudes, [1, NUM_BINS]);
      const result    = await sessions['silero-vad'].run({ input: vadInput });
      const vadProb   = result.output.data;
      if (vadProb.length === 1) {
        const gate = Math.max(0, vadProb[0] * 2 - 0.5);
        for (let k = 0; k < NUM_BINS; k++) mask[k] *= gate;
      } else {
        for (let k = 0; k < NUM_BINS; k++) mask[k] *= vadProb[k];
      }
    } catch (e) {
      console.warn('[ml-worker] silero-vad error:', e.message);
    }
  }

  // Stage 10 equivalent: Demucs v4 — vocal source separation mask
  if (sessions['demucs-v4'] && allowedStages >= 10) {
    try {
      const demucsIn  = new ort.Tensor('float32', magnitudes, [1, 1, NUM_BINS]);
      const result    = await sessions['demucs-v4'].run({ mag_input: demucsIn });
      const vocalMask = result.vocal_mask.data;
      for (let k = 0; k < NUM_BINS; k++) {
        mask[k] = Math.min(mask[k], Math.max(0, vocalMask[k]));
      }
    } catch (e) {
      console.warn('[ml-worker] demucs-v4 error:', e.message);
    }
  }

  // Stage 8 equivalent: RNNoise — residual noise suppression
  if (sessions['rnnoise'] && allowedStages >= 8) {
    try {
      const rnIn   = new ort.Tensor('float32', magnitudes, [1, NUM_BINS]);
      const result = await sessions['rnnoise'].run({ input: rnIn });
      const rnMask = result.output.data;
      for (let k = 0; k < NUM_BINS; k++) {
        mask[k] *= Math.max(0.01, rnMask[k]); // floor prevents total silence
      }
    } catch (e) {
      console.warn('[ml-worker] rnnoise error:', e.message);
    }
  }

  // Stage 14 equivalent: VoiceFixer — harmonic restoration (ENTERPRISE only)
  if (sessions['voicefixer'] && allowedStages >= 14) {
    try {
      const vfIn   = new ort.Tensor('float32', magnitudes, [1, NUM_BINS]);
      const result = await sessions['voicefixer'].run({ input: vfIn });
      const vfGain = result.gain.data;
      for (let k = 0; k < NUM_BINS; k++) {
        mask[k] = mask[k] * (0.5 + 0.5 * Math.min(2, vfGain[k]));
      }
    } catch (e) {
      console.warn('[ml-worker] voicefixer error:', e.message);
    }
  }

  return mask;
}
