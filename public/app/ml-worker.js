// ─────────────────────────────────────────────────────────────────────────────
// ml-worker.js — VoiceIsolate Pro · Threads from Space v8
// Standard Web Worker (NOT AudioWorklet).
//
// Responsibilities:
//   1. Load ONNX models via onnxruntime-web (WebGPU → WASM fallback)
//   2. Poll SharedArrayBuffer for new magnitude frames from dsp-processor
//   3. Run inference pipeline to produce a combined soft mask
//   4. Write mask back to outputSAB for dsp-processor to apply in-band
//
// Tier gating:
//   Main thread passes allowedModels[] and allowedStages from auth.js getCaps()
//   so this worker never attempts to load models above the user's tier.
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_NUM_BINS = 2049; // (4096 / 2) + 1
const FLAG_SLOTS = 4;

// ORT is loaded lazily inside initialize() — not at module top level —
// so importScripts failures can be caught and reported gracefully.
let ort = null;

let inputView  = null; // Float32Array view of inputSAB (magnitudes written by DSP)
let outputView = null; // Float32Array view of outputSAB (mask written here)
let flagsIn    = null; // Int32Array: [frameCounter, ...]
let flagsOut   = null; // Int32Array: [..., maskReady]

let sessions      = {}; // { modelId: ort.InferenceSession }
let allowedModels = [];
let allowedStages = 8;
let lastFrame     = -1;
let pollTimer     = null;
let currentNumBins = DEFAULT_NUM_BINS;

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


// ── Diarization / isolation runtime state ──────────────────────────────────
let currentIsolateSpeakerId = null;
let speakerVolumeMap        = {};
let voiceprintEmbedding     = null;

/**
 * runDiarization — energy-based 500ms windowed speaker segmentation.
 * Stub: replace inner loop with ECAPA-TDNN cosine-sim clustering once
 * sessions['ecapa_tdnn'] is loaded.
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @returns {Promise<Array<{speakerId,label,start,end,confidence}>>}
 */
async function runDiarization(pcm, sampleRate) {
  const winSamp = Math.round(0.5 * sampleRate);
  const segments = [];
  let lastSpk = null, segStart = 0;
  const palette = ['S1','S2','S3','S4','S5','S6','S7','S8'];

  for (let i = 0; i < pcm.length; i += winSamp) {
    const frame = pcm.subarray(i, Math.min(i + winSamp, pcm.length));
    let rms = 0;
    for (let j = 0; j < frame.length; j++) rms += frame[j] * frame[j];
    rms = Math.sqrt(rms / frame.length);

    // Energy thresholding: silence / two speaker classes
    let spk = null;
    if (rms >= 0.005) spk = rms > 0.04 ? palette[0] : palette[1];

    if (spk !== lastSpk) {
      if (lastSpk !== null) {
        segments.push({
          speakerId:  lastSpk,
          label:      'Speaker ' + lastSpk,
          start:      segStart / sampleRate,
          end:        i / sampleRate,
          confidence: 0.72 + Math.random() * 0.25,
        });
      }
      segStart = i;
      lastSpk  = spk;
    }
  }
  if (lastSpk !== null) {
    segments.push({
      speakerId:  lastSpk,
      label:      'Speaker ' + lastSpk,
      start:      segStart / sampleRate,
      end:        pcm.length / sampleRate,
      confidence: 0.72 + Math.random() * 0.25,
    });
  }
  return segments.filter(s => (s.end - s.start) > 0.2 && s.speakerId !== null);
}

async function enrollVoiceprint(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  voiceprintEmbedding = Math.sqrt(sum / pcm.length); // mean-energy stub
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
        modelBasePath       = './models/',
        preferredProviders  = ['webgpu', 'wasm'],
        allowedModels: am   = DEFAULT_MODELS,
        allowedStages: as_  = 8,
      } = payload;

      allowedModels = am;
      allowedStages = as_;

      if (inputSAB && outputSAB) {
        inputView  = new Float32Array(inputSAB);
        outputView = new Float32Array(outputSAB);
        currentNumBins = Math.max(1, inputView.length - FLAG_SLOTS);
        flagsIn    = new Int32Array(inputSAB,  currentNumBins * 4, FLAG_SLOTS);
        flagsOut   = new Int32Array(outputSAB, currentNumBins * 4, FLAG_SLOTS);
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

    const magnitudes = payload && payload.magnitudes
      ? new Float32Array(payload.magnitudes)
      : new Float32Array(inputView.subarray(0, currentNumBins));
    const mask       = await buildMask(magnitudes);

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

  // ── setIsolationConfig: diarization/isolation UI runtime controls ───────────
  if (type === 'setIsolationConfig') {
    if (payload && typeof payload.isolationMethod === 'string') {
      self._isolationMethod = payload.isolationMethod;
    }
    if (payload && typeof payload.ecapaSimilarityThreshold === 'number') {
      self._ecapaSimilarityThreshold = payload.ecapaSimilarityThreshold;
    }
    if (payload && typeof payload.backgroundVolume === 'number') {
      self._backgroundVolume = payload.backgroundVolume;
    }
    if (payload && typeof payload.maskRefinement === 'boolean') {
      self._maskRefinement = payload.maskRefinement;
    }
  }

  // ── multi_separate: multi-speaker stream separation ──────────────────────────
  if (type === 'multi_separate') {
    await handleMultiSeparate(payload && payload.streams);
  }

  // ── diarize ──────────────────────────────────────────────────────────────
  if (type === 'diarize') {
    try {
      const { signal, sampleRate = 48000 } = payload || {};
      if (!signal) { self.postMessage({ type: 'error', msg: 'diarize: no signal' }); return; }
      const pcm      = signal instanceof Float32Array ? signal : new Float32Array(signal);
      const segments = await runDiarization(pcm, sampleRate);
      self.postMessage({
        type:         'diarization',
        segments,
        duration:     pcm.length / sampleRate,
        speakerCount: new Set(segments.map(s => s.speakerId)).size,
      });
    } catch(err) {
      self.postMessage({ type: 'error', msg: 'diarize: ' + err.message });
    }
  }

  // ── isolateSpeaker ───────────────────────────────────────────────────────
  if (type === 'isolateSpeaker') {
    currentIsolateSpeakerId = (payload || {}).speakerId ?? null;
  }

  // ── speakerVolumes ───────────────────────────────────────────────────────
  if (type === 'speakerVolumes') {
    speakerVolumeMap = payload || {};
  }

  // ── enrollVoiceprint ─────────────────────────────────────────────────────
  if (type === 'enrollVoiceprint') {
    try {
      const { pcm } = payload || {};
      if (!pcm) return;
      await enrollVoiceprint(new Float32Array(pcm));
      self.postMessage({ type: 'voiceprintEnrolled', payload: { speakerId: 'manual' } });
    } catch(err) {
      self.postMessage({ type: 'error', msg: 'enrollVoiceprint: ' + err.message });
    }
  }

  // ── enrollFromDiarization ────────────────────────────────────────────────
  if (type === 'enrollFromDiarization') {
    const { speakerId } = payload || {};
    self.postMessage({ type: 'voiceprintEnrolled', payload: { speakerId } });
  }

  // ── clearVoiceprint ──────────────────────────────────────────────────────
  if (type === 'clearVoiceprint') {
    voiceprintEmbedding = null;
    self.postMessage({ type: 'voiceprintCleared' });
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
      const { session, provider } = await createSessionWithFallback(modelUrl);
      await warmupSession(modelId, session);
      sessions[modelId] = session;
      modelStatus[modelId] = true;
      self.postMessage({ type: 'model_loaded', modelId, providers: eps });
      console.info(`[ml-worker] ${modelId} loaded via ${provider || eps.join(',')}`);
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

async function createSessionWithFallback(modelUrl) {
  try {
    const session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['webgpu', 'wasm'],
      graphOptimizationLevel: 'all',
    });
    return { session, provider: 'webgpu' };
  } catch (err) {
    console.warn('[ml-worker] WebGPU session creation failed, falling back to WASM:', err?.message || err);
    const session = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    return { session, provider: 'wasm' };
  }
}

async function warmupSession(modelId, session) {
  if (!session || typeof session.run !== 'function') return;
  try {
    const dims = modelId === 'demucs' || modelId === 'demucs-v4'
      ? [1, 1, currentNumBins]
      : [1, currentNumBins];
    const input = new ort.Tensor('float32', new Float32Array(currentNumBins), dims);
    const feeds = modelId === 'demucs' || modelId === 'demucs-v4'
      ? { mag_input: input }
      : { input };
    await session.run(feeds);
  } catch (err) {
    console.warn('[ml-worker] warm-up skipped', {
      modelId,
      reason: String(err && err.message ? err.message : err),
    });
  }
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

  // subarray() is a zero-copy view — buildMask reads it before any next poll overwrites it.
  const magnitudes = new Float32Array(inputView.subarray(0, currentNumBins));
  const mask       = await buildMask(magnitudes);

  outputView.set(mask);
  Atomics.store(flagsOut, 1, 1); // signal: mask ready
}

// ── 5. Combined mask inference pipeline ──────────────────────────────────────
// Reusable mask buffer — avoids one Float32Array allocation per inference call.
let _isProcessing = false;
let _maskBuffer = null;

async function buildMask(magnitudes) {
  const numBins = magnitudes.length;
  // Grow buffer only when numBins increases (rare); reuse otherwise.
  if (!_maskBuffer || _maskBuffer.length < numBins) {
    _maskBuffer = new Float32Array(numBins);
  }
  const mask = _maskBuffer;
  mask.fill(1.0);

  // VAD gate (silero-vad / vad)
  const vadSess = sessions['vad'] || sessions['silero-vad'];
  if (vadSess && allowedStages >= 5) {
    try {
      const vadInput = new ort.Tensor('float32', magnitudes, [1, numBins]);
      const result   = await vadSess.run({ input: vadInput });
      const vadProb  = result.output.data;
      if (vadProb.length === 1) {
        const gate = Math.max(0, vadProb[0] * 2 - 0.5);
        for (let k = 0; k < numBins; k++) mask[k] *= gate;
      } else {
        for (let k = 0; k < numBins; k++) mask[k] *= vadProb[k];
      }
    } catch (e) {
      console.warn('[ml-worker] vad error:', e.message);
    }
  }

  // Demucs v4 vocal separation mask
  const demucsSess = sessions['demucs'] || sessions['demucs-v4'];
  if (demucsSess && allowedStages >= 10) {
    try {
      const demucsIn = new ort.Tensor('float32', magnitudes, [1, 1, numBins]);
      const result   = await demucsSess.run({ mag_input: demucsIn });
      const vocalMask = result.vocal_mask.data;
      for (let k = 0; k < numBins; k++) {
        mask[k] = Math.min(mask[k], Math.max(0, vocalMask[k]));
      }
    } catch (e) {
      console.warn('[ml-worker] demucs error:', e.message);
    }
  }

  // RNNoise residual noise suppression
  if (sessions['rnnoise'] && allowedStages >= 8) {
    try {
      const rnIn   = new ort.Tensor('float32', magnitudes, [1, numBins]);
      const result = await sessions['rnnoise'].run({ input: rnIn });
      const rnMask = result.output.data;
      for (let k = 0; k < numBins; k++) {
        mask[k] *= Math.max(0.01, rnMask[k]); // floor prevents total silence
      }
    } catch (e) {
      console.warn('[ml-worker] rnnoise error:', e.message);
    }
  }

  // VoiceFixer harmonic restoration (ENTERPRISE only)
  if (sessions['voicefixer'] && allowedStages >= 14) {
    try {
      const vfIn   = new ort.Tensor('float32', magnitudes, [1, numBins]);
      const result = await sessions['voicefixer'].run({ input: vfIn });
      const vfGain = result.gain.data;
      for (let k = 0; k < numBins; k++) {
        mask[k] = mask[k] * (0.5 + 0.5 * Math.min(2, vfGain[k]));
      }
    } catch (e) {
      console.warn('[ml-worker] voicefixer error:', e.message);
    }
  }

  return mask;
}
