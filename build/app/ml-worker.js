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

const NUM_BINS = 2049; // (4096 / 2) + 1

// ORT is loaded lazily inside initialize() — not at module top level —
// so importScripts failures can be caught and reported gracefully.
let ort = null;

let inputView  = null; // Float32Array view of inputSAB  (magnitudes written by DSP)
let outputView = null; // Float32Array view of outputSAB (mask written here)
let flagsIn    = null; // Int32Array: [frameCounter, ...]
let flagsOut   = null; // Int32Array: [..., maskReady]

let sessions      = {}; // { modelId: ort.InferenceSession }
let allowedModels = [];
let allowedStages = 8;
let lastFrame     = -1;
let pollTimer     = null;

// ── Default models loaded on bare init (no payload) ──────────────────────────
const DEFAULT_MODELS = ['vad', 'deepfilter', 'demucs'];

// ── Model filename registry ───────────────────────────────────────────────────
const MODEL_FILES = {
  'vad':         'silero_vad.onnx',
  'deepfilter':  'deepfilter.onnx',
  'demucs':      'demucs_v4_int8.onnx',
  'silero-vad':  'silero_vad.onnx',
  'rnnoise':     'rnnoise.onnx',
  'demucs-v4':   'demucs_v4_int8.onnx',
  'ecapa-tdnn':  'ecapa_tdnn.onnx',
  'voicefixer':  'voicefixer.onnx',
};

// ── ORT lazy initializer ──────────────────────────────────────────────────────
// Called at the start of every message handler that needs ORT.
// If self.ort is already populated (e.g. by a prior importScripts call or
// injected in tests), it is reused; otherwise importScripts loads the local
// vendored file (copied by scripts/setup-ort.js postinstall).
function initialize() {
  if (self.ort) {
    ort = self.ort;
    return;
  }
  // Load ORT from local vendored file (copied by scripts/setup-ort.js postinstall)
  importScripts('/lib/ort.min.js');
  ort = self.ort;
  ort.env.wasm.wasmPaths = '/lib/';
}

// ── 1. Message dispatcher ─────────────────────────────────────────────────────
self.onmessage = async (ev) => {
  const { type, payload, models: msgModels } = ev.data || {};

  // ── init: full SAB + model init (called by app-init.js) ─────────────────────
  if (type === 'init') {
    try {
      initialize();
    } catch (err) {
      self.postMessage({ type: 'error', msg: err.message });
      return;
    }

    if (payload) {
      const {
        inputSAB,
        outputSAB,
        modelBasePath      = './models/',
        preferredProviders = ['webgpu', 'wasm'],
        allowedModels: am  = DEFAULT_MODELS,
        allowedStages: as_ = 8,
      } = payload;

      allowedModels = am;
      allowedStages = as_;

      if (inputSAB && outputSAB) {
        inputView  = new Float32Array(inputSAB);
        outputView = new Float32Array(outputSAB);
        flagsIn    = new Int32Array(inputSAB,  NUM_BINS * 4, 4);
        flagsOut   = new Int32Array(outputSAB, NUM_BINS * 4, 4);
        startPollLoop();
      }

      const modelStatus = await loadModels(modelBasePath, preferredProviders, allowedModels);
      self.postMessage({ type: 'ready', models: modelStatus });
    } else {
      // Bare init (no payload — used in tests and simple invocations)
      const modelStatus = await loadModels('./models/', ['webgpu', 'wasm'], DEFAULT_MODELS);
      self.postMessage({ type: 'ready', models: modelStatus });
    }
  }

  // ── loadModel: load a specific set of models and report status ───────────────
  if (type === 'loadModel') {
    try {
      initialize();
    } catch (err) {
      self.postMessage({ type: 'error', msg: err.message });
      return;
    }

    const modelList   = msgModels || DEFAULT_MODELS;
    const modelStatus = await loadModels('./models/', ['webgpu', 'wasm'], modelList);
    self.postMessage({ type: 'ready', models: modelStatus });
  }

  // ── process: run inference on a single frame of magnitude data ───────────────
  if (type === 'process') {
    if (!ort || (!inputView && !(payload && payload.magnitudes))) return;

    const magnitudes = new Float32Array((payload && payload.magnitudes) || inputView.subarray(0, NUM_BINS));
    const mask = await buildMask(magnitudes);

    const output = new Float32Array(mask);
    self.postMessage({ type: 'processed', output }, [output.buffer]);
  }

  // ── reset: clear inference sessions and polling state ───────────────────────
  if (type === 'reset') {
    clearInterval(pollTimer);
    sessions  = {};
    lastFrame = -1;
    pollTimer = null;
    self.postMessage({ type: 'reset_done' });
  }

  // ── unload: full cleanup ─────────────────────────────────────────────────────
  if (type === 'unload') {
    clearInterval(pollTimer);
    sessions = {};
    self.postMessage({ type: 'unloaded' });
  }

  // ── update_params: adjust tier caps at runtime ───────────────────────────────
  if (type === 'update_params') {
    if (payload && payload.allowedModels) allowedModels = payload.allowedModels;
    if (payload && payload.allowedStages) allowedStages = payload.allowedStages;
  }
};

// ── 2. Multi-speaker separation ───────────────────────────────────────────────
async function handleMultiSeparate(streams) {
  if (!streams || !streams.length) {
    self.postMessage({ type: 'multi_done', streams: [] });
    return;
  }

  // Null-guard: filter out invalid stream entries before extracting buffers
  const transferables = streams
    .map(s => s && s.data && s.data.buffer)
    .filter(Boolean);

  self.postMessage({ type: 'multi_done', streams }, transferables);
}

// ── 3. Model loader ───────────────────────────────────────────────────────────
async function loadModels(basePath, providers, modelList) {
  const modelStatus = {};

  for (const modelId of modelList) {
    const file = MODEL_FILES[modelId];
    if (!file) {
      modelStatus[modelId] = false;
      continue;
    }

    const modelUrl = basePath + file;
    const eps      = await resolveProviders(providers);

    try {
      sessions[modelId] = await ort.InferenceSession.create(modelUrl, {
        executionProviders:     eps,
        graphOptimizationLevel: 'all',
      });
      modelStatus[modelId] = true;
      self.postMessage({ type: 'model_loaded', modelId, providers: eps });
      console.info(`[ml-worker] ${modelId} loaded via ${eps.join(',')}`);
    } catch (err) {
      modelStatus[modelId] = false;
      const errMsg = modelId === 'vad'
        ? `VAD unavailable: ${err.message}`
        : `Failed to load ${modelId}: ${err.message}`;
      self.postMessage({ type: 'log', level: 'warn', msg: errMsg });
      console.warn(`[ml-worker] ${errMsg}`);
    }
  }

  return modelStatus;
}

async function resolveProviders(providers) {
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
  if (eps.length === 0) eps.push('wasm');
  return eps;
}

// ── 4. SAB polling loop (50 Hz) ───────────────────────────────────────────────
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

// ── 5. Combined mask inference pipeline ──────────────────────────────────────
async function buildMask(magnitudes) {
  const mask = new Float32Array(NUM_BINS).fill(1.0);

  // VAD gate (silero-vad / vad)
  const vadSess = sessions['vad'] || sessions['silero-vad'];
  if (vadSess && allowedStages >= 5) {
    try {
      const vadInput = new ort.Tensor('float32', magnitudes, [1, NUM_BINS]);
      const result   = await vadSess.run({ input: vadInput });
      const vadProb  = result.output.data;
      if (vadProb.length === 1) {
        const gate = Math.max(0, vadProb[0] * 2 - 0.5);
        for (let k = 0; k < NUM_BINS; k++) mask[k] *= gate;
      } else {
        for (let k = 0; k < NUM_BINS; k++) mask[k] *= vadProb[k];
      }
    } catch (e) {
      console.warn('[ml-worker] vad error:', e.message);
    }
  }

  // Demucs v4 vocal separation mask
  const demucsSess = sessions['demucs'] || sessions['demucs-v4'];
  if (demucsSess && allowedStages >= 10) {
    try {
      const demucsIn  = new ort.Tensor('float32', magnitudes, [1, 1, NUM_BINS]);
      const result    = await demucsSess.run({ mag_input: demucsIn });
      const vocalMask = result.vocal_mask.data;
      for (let k = 0; k < NUM_BINS; k++) {
        mask[k] = Math.min(mask[k], Math.max(0, vocalMask[k]));
      }
    } catch (e) {
      console.warn('[ml-worker] demucs error:', e.message);
    }
  }

  // RNNoise residual noise suppression
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

  // VoiceFixer harmonic restoration (ENTERPRISE only)
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
}
