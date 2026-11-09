/* ============================================
   VoiceIsolate Pro v24.0 — DSP Worker
   Threads from Space v13 · ML Inference Thread
   Runs in a dedicated Worker. Owns all ONNX sessions.
   ============================================ */

'use strict';

// BUG-K FIX: explicit relative path prevents failure in some worker origins
importScripts('/src/core/wav-encoder-impl.js');
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
      case 'condition':  result = handleChannels('conditionFallbackChannel', payload); break;
      case 'eqDynamics': result = handleChannels('eqDynamicsChannel', payload);        break;
      default: throw new Error(`Unknown message type: ${type}`);
    }
    // Transfer any ArrayBuffer payload (processedData) instead of structured-cloning
    // — this saves a full PCM copy on every processed block.
    let transfers;
    if (result && result.processedData instanceof ArrayBuffer) transfers = [result.processedData];
    else if (result && Array.isArray(result.channels)) transfers = result.channels;
    self.postMessage({ type: 'result', id, result }, transfers);
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
      // out[key].data is already a Float32Array — reference it directly instead of copying.
      processed = out[Object.keys(out)[0]].data;
    } catch (err) {
      console.warn('[dsp-worker] Demucs failed, continuing classical DSP:', err.message);
      try {
        self.postMessage({
          type:  'modelFailed',
          model: 'demucs',
          error: err?.message || String(err)
        });
      } catch { /* postMessage can fail during teardown */ }
    }
  }

  // Single spectral pass. Spectra are produced in bounded chunks so a long
  // file cannot allocate a whole-file STFT. Overlap-add state stays inside
  // processChunked. Wiener uses a real noise profile (lowest-energy frames
  // of the same 4096/1024 padded geometry); a null profile is not a reduction.
  const FFT = 4096;
  const HOP = 1024;
  let noiseProfile = null;
  if (params && (params.nrAmount ?? 0) > 0) {
    noiseProfile = dspCore.estimateNoiseProfile(processed, null, FFT, HOP);
    const expectBins = FFT / 2 + 1;
    if (!noiseProfile || noiseProfile.length !== expectBins) {
      throw new Error(`Wiener noise profile length ${noiseProfile ? noiseProfile.length : 0} != ${expectBins}`);
    }
  }
  const gateState = params ? {} : null;
  const output = dspCore.processChunked(processed, FFT, HOP, {
    chunkFrames: 48,
    onChunk: params
      ? (mag) => {
          dspCore.spectralGate(mag, params.nrFloor ?? -60, sampleRate, HOP, gateState);
          if (noiseProfile) dspCore.wienerMMSE(mag, noiseProfile, params.nrAmount);
        }
      : null,
  });

  return {
    processedData: output.buffer,
    metrics: dspCore.getMetrics ? dspCore.getMetrics() : {}
  };
}

/**
 * Whole-file DSP fallback passes off the main thread: 'condition' (DC, clicks,
 * gate, de-ess, edge fades) and 'eqDynamics' (HP/LP, EQ, compressor, limiter).
 * Same DSPCore methods the in-thread path uses; channel buffers arrive and
 * leave as transfers, so no PCM is copied.
 */
function handleChannels(method, { channels, sampleRate, params }) {
  const core = dspCore || DSPCoreLocal;
  const out = (channels || []).map((buf) => {
    const data = core[method](new Float32Array(buf), params || {}, sampleRate);
    return data.buffer;
  });
  return { channels: out };
}

function handleGetMetrics() {
  return dspCore?.getMetrics ? dspCore.getMetrics() : {};
}

function handleReset() {
  if (dspCore?.reset) dspCore.reset();
  return { status: 'reset' };
}
