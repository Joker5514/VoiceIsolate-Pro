/* ============================================
   VoiceIsolate Pro v22.1 — DSP Worker
   Threads from Space v11 · ML Inference Thread
   Runs in a dedicated Worker. Owns all ONNX sessions.
   ============================================ */

'use strict';

// BUG-K FIX: explicit relative path prevents failure in some worker origins
importScripts('./dsp-core.js');

// eslint-disable-next-line no-undef
const DSPCoreLocal = self.DSPCore || DSPCore;

// ONNX Runtime is loaded by the main thread before creating this worker.
// Never importScripts ort.min.js here — it must come from /lib/ort.min.js
// and be loaded via WorkerManager before this worker is spawned.

const ML_TIMEOUT_MS = 30000;

let dspCore = null;
let ortSessions = {};
let isInitialized = false;

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
self.onmessage = async function (e) {
  const { type, id, payload } = e.data;
  try {
    let result;
    switch (type) {
      case 'init':       result = await handleInit(payload);      break;
      case 'process':    result = await handleProcess(payload);   break;
      case 'loadModel':  result = await handleLoadModel(payload); break;
      case 'getMetrics': result = handleGetMetrics();             break;
      case 'reset':      result = handleReset();                  break;
      default: throw new Error(`Unknown message type: ${type}`);
    }
    self.postMessage({ type: 'result', id, result });
  } catch (err) {
    self.postMessage({ type: 'error', id, error: err.message, stack: err.stack });
  }
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function handleInit(payload) {
  // DSPCore is a plain-object singleton, not a class — do not call with `new`
  dspCore = DSPCoreLocal;
  isInitialized = true;
  return { status: 'initialized', sampleRate: payload.sampleRate || 48000 };
}

// ---------------------------------------------------------------------------
// Load ONNX model
// ---------------------------------------------------------------------------
async function handleLoadModel({ modelName, modelPath, ortEnvConfig }) {
  if (!self.ort) {
    throw new Error('onnxruntime-web (ort) not available. Ensure /lib/ort.min.js is loaded before worker creation.');
  }

  // BUG-O FIX: timeout now calls reject() so callers use .catch() properly.
  // Previously returned { error } which callers silently consumed as success.
  const session = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ML model load timeout after ${ML_TIMEOUT_MS / 1000}s — model: ${modelName}`));
    }, ML_TIMEOUT_MS);

    const opts = {
      executionProviders: ortEnvConfig?.providers || ['webgpu', 'wasm'],
      graphOptimizationLevel: 'all',
    };

    self.ort.InferenceSession.create(modelPath, opts)
      .then(s => { clearTimeout(timer); resolve(s); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });

  ortSessions[modelName] = session;
  return { status: 'loaded', modelName, inputNames: session.inputNames, outputNames: session.outputNames };
}

// ---------------------------------------------------------------------------
// Run inference with timeout (BUG-O pattern applied here too)
// ---------------------------------------------------------------------------
async function runInference(modelName, inputTensor) {
  const session = ortSessions[modelName];
  if (!session) throw new Error(`Model not loaded: ${modelName}`);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ML inference timeout after ${ML_TIMEOUT_MS / 1000}s — model: ${modelName}`));
    }, ML_TIMEOUT_MS);

    const feeds = {};
    feeds[session.inputNames[0]] = inputTensor;

    session.run(feeds)
      .then(out => { clearTimeout(timer); resolve(out); })
      .catch(err => { clearTimeout(timer); reject(err); });
  });
}

// ---------------------------------------------------------------------------
// Process audio block
// ---------------------------------------------------------------------------
async function handleProcess(payload) {
  if (!isInitialized) throw new Error('Worker not initialized — send init message first');

  const { audioData, sampleRate, params, enabledModels } = payload;
  const input = new Float32Array(audioData);
  let processed = input;

  // ML separation first (time-domain) — must run before STFT so spectral ops see ML output
  if (enabledModels?.includes('demucs') && ortSessions['demucs']) {
    try {
      const tensor = new self.ort.Tensor('float32', processed, [1, 1, processed.length]);
      const out = await runInference('demucs', tensor);
      processed = new Float32Array(out[Object.keys(out)[0]].data);
    } catch (err) {
      console.warn('[dsp-worker] Demucs failed, continuing classical DSP:', err.message);
    }
  }

  // Single Forward STFT — do not add a second one anywhere in this function
  const { mag, phase } = dspCore.forwardSTFT(processed);

  // In-place spectral operations on mag/phase arrays
  if (params) {
    // ERB spectral gate using noise floor parameter
    dspCore.spectralGate(mag, params.nrFloor ?? -60, sampleRate);
    // Wiener noise subtraction (no pre-computed profile available at worker level)
    if ((params.nrAmount ?? 0) > 0) {
      dspCore.wienerMMSE(mag, null, params.nrAmount);
    }
  }

  // Single Inverse STFT — do not add a second one anywhere
  const output = dspCore.inverseSTFT(mag, phase);

  return {
    processedData: output.buffer,
    metrics: dspCore.getMetrics ? dspCore.getMetrics() : {}
  };
}

function handleGetMetrics() {
  return dspCore?.getMetrics ? dspCore.getMetrics() : {};
}

function handleReset() {
  if (dspCore?.reset) dspCore.reset();
  return { status: 'reset' };
}
