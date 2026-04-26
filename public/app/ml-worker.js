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
const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS;
const NOISE_WARMUP_FRAMES = 90;
const FORENSIC_ALPHA_FLOOR_THRESHOLD = 0.005;
const ALPHA_CAP_DEFAULT = 2.0;
const ALPHA_CAP_FORENSIC = 3.0;
const SNR_MAX = 1e6;

const VAD_FALLBACK_RMS_BASELINE = 1e-4;
const VAD_FALLBACK_RMS_RANGE = 7e-4;
const VAD_FALLBACK_RATIO_BASELINE = 0.35;
const VAD_FALLBACK_RATIO_RANGE = 0.45;
const VAD_FALLBACK_BLEND_RMS = 0.45;
const VAD_FALLBACK_BLEND_RATIO = 0.55;
const NOISE_SEED_SCALE = 1.5;

// ORT is loaded lazily inside initialize() — not at module top level —
// so importScripts failures can be caught and reported gracefully.
let ort = null;

let inputView  = null; // Float32Array view of inputSAB payload: [mag | phase]
let outputView = null; // Float32Array view of outputSAB payload: [mask]
let flagsIn    = null; // Int32Array: [frameCounter, ...]
let flagsOut   = null; // Int32Array: [..., maskReady]

let sessions      = {}; // { modelId: ort.InferenceSession }
let allowedModels = [];
let allowedStages = 8;
let pollTimer     = null;
let currentNumBins = DEFAULT_NUM_BINS;
let currentHalfN = DEFAULT_NUM_BINS;
let currentFFTSize = 4096;
let latestPcmChunk = null;
let vadModelMissing = false;
let vadMissingWarned = false;
let speechConfidence = 0;
let speechStreak = 0;
let noiseProfile = null;
let noiseFrames = 0;
let warmupComplete = false;
let demucsPcmMissingWarned = false;

let runtimeParams = {
  spectralFloor: 0.005,
  noiseReduce: 0.7,
  forensicMode: false,
  nonVoiceSuppression: 2.0,
};

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
// Stubbed state: populated by message handlers below; will be consumed once
// ECAPA-TDNN cosine-sim clustering replaces the energy-based stub.
let _currentIsolateSpeakerId = null; // eslint-disable-line no-unused-vars
let _speakerVolumeMap        = {};
let _voiceprintEmbedding     = null; // eslint-disable-line no-unused-vars

/**
 * Compute a 3-element feature vector [rms, spectralCentroid, zcr] for a PCM frame.
 * Used for speaker clustering without requiring a neural model.
 */
function _frameFeatures(frame, sampleRate) {
  const n = frame.length;
  if (n === 0) return [0, 0, 0];

  // RMS energy
  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += frame[i] * frame[i];
  const rms = Math.sqrt(sumSq / n);

  // Spectral centroid via zero-crossing approximation (cheap, no FFT)
  let zcr = 0;
  for (let i = 1; i < n; i++) {
    if ((frame[i] >= 0) !== (frame[i - 1] >= 0)) zcr++;
  }
  zcr = zcr / (2 * n / sampleRate); // crossings per second → approx Hz

  // Short-term spectral flatness via ratio of arithmetic to geometric mean of |x|
  let sumAbs = 0, logSum = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(frame[i]) + 1e-9;
    sumAbs += a;
    logSum += Math.log(a);
  }
  const flatness = Math.exp(logSum / n) / (sumAbs / n);

  return [rms, zcr / sampleRate, flatness]; // normalise zcr to [0,1] range
}

/**
 * Simple online k-means clustering (k=2..4) on feature vectors.
 * Returns cluster ID (0-indexed) for each frame index.
 */
function _kMeans(features, k, maxIter = 20) {
  if (features.length === 0) return [];
  const dim  = features[0].length;
  const n    = features.length;

  // Initialise centroids by spreading across the feature array
  const centroids = Array.from({ length: k }, (_, ci) => {
    const fi = Math.floor((ci / k) * n);
    return features[fi].slice();
  });

  let labels = new Int32Array(n);

  for (let iter = 0; iter < maxIter; iter++) {
    // Assign
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        let d = 0;
        for (let d2 = 0; d2 < dim; d2++) {
          const diff = features[i][d2] - centroids[c][d2];
          d += diff * diff;
        }
        if (d < bestDist) { bestDist = d; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; changed = true; }
    }
    if (!changed) break;

    // Recompute centroids
    const sums   = Array.from({ length: k }, () => new Float64Array(dim));
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      const c = labels[i];
      counts[c]++;
      for (let d2 = 0; d2 < dim; d2++) sums[c][d2] += features[i][d2];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        for (let d2 = 0; d2 < dim; d2++) centroids[c][d2] = sums[c][d2] / counts[c];
      }
    }
  }

  return labels;
}

/**
 * runDiarization — multi-speaker segmentation using spectral features + k-means.
 * Uses RMS, zero-crossing rate, and spectral flatness across 200ms windows.
 * Falls back gracefully to energy-only if audio is very short.
 * @param {Float32Array} pcm
 * @param {number} sampleRate
 * @returns {Promise<Array<{speakerId,label,start,end,confidence}>>}
 */
async function runDiarization(pcm, sampleRate) {
  const winSamp     = Math.round(0.2 * sampleRate); // 200ms windows
  const hopSamp     = Math.round(0.1 * sampleRate); // 100ms hop
  const silThresh   = 0.003;                        // RMS below this = silence
  const palette     = ['S1','S2','S3','S4','S5','S6','S7','S8'];

  // Extract features for every hop
  const features = [];
  const frameStarts = [];
  for (let i = 0; i + winSamp <= pcm.length; i += hopSamp) {
    const frame = pcm.subarray(i, i + winSamp);
    features.push(_frameFeatures(frame, sampleRate));
    frameStarts.push(i);
  }

  if (features.length === 0) return [];

  // Determine number of clusters (2–4) based on audio length
  const durSec = pcm.length / sampleRate;
  const k = durSec < 10 ? 2 : durSec < 30 ? 3 : 4;

  // Normalise features to [0,1] per dimension for balanced clustering
  const dim = features[0].length;
  const fMin = new Float64Array(dim).fill(Infinity);
  const fMax = new Float64Array(dim).fill(-Infinity);
  for (const f of features) {
    for (let d = 0; d < dim; d++) {
      if (f[d] < fMin[d]) fMin[d] = f[d];
      if (f[d] > fMax[d]) fMax[d] = f[d];
    }
  }
  const normed = features.map(f =>
    f.map((v, d) => fMax[d] > fMin[d] ? (v - fMin[d]) / (fMax[d] - fMin[d]) : 0)
  );

  const labels = _kMeans(normed, k);

  // Build segments: merge adjacent frames with same label
  const segments = [];
  let segLabel = null, segStart = 0;
  const isSilent = (fi) => features[fi][0] < silThresh;

  for (let fi = 0; fi < frameStarts.length; fi++) {
    const spk = isSilent(fi) ? null : palette[labels[fi]];
    if (spk !== segLabel) {
      if (segLabel !== null) {
        const endSamp = frameStarts[fi];
        const conf    = 0.68 + normed[fi][0] * 0.29; // energy-weighted confidence
        segments.push({
          speakerId:  segLabel,
          label:      'Speaker ' + segLabel,
          start:      segStart / sampleRate,
          end:        endSamp / sampleRate,
          confidence: Math.min(0.97, conf),
        });
      }
      segStart = frameStarts[fi];
      segLabel = spk;
    }
  }
  // Close last segment
  if (segLabel !== null) {
    segments.push({
      speakerId:  segLabel,
      label:      'Speaker ' + segLabel,
      start:      segStart / sampleRate,
      end:        pcm.length / sampleRate,
      confidence: 0.72,
    });
  }

  // Filter out very short segments (< 300ms)
  return segments.filter(s => s.speakerId !== null && (s.end - s.start) >= 0.3);
}

async function enrollVoiceprint(pcm) {
  // Store a compact feature embedding: mean of per-window feature vectors
  const winSamp = Math.round(0.2 * 16000);
  const vecs = [];
  for (let i = 0; i + winSamp <= pcm.length; i += winSamp) {
    vecs.push(_frameFeatures(pcm.subarray(i, i + winSamp), 16000));
  }
  if (vecs.length === 0) { _voiceprintEmbedding = null; return; }
  const dim = vecs[0].length;
  const mean = new Float32Array(dim);
  for (const v of vecs) for (let d = 0; d < dim; d++) mean[d] += v[d] / vecs.length;
  _voiceprintEmbedding = mean;
}

// ── 1. Message dispatcher ─────────────────────────────────────────────────────
self.onmessage = async (ev) => {
  const { type, payload, models: msgModels } = ev.data || {};

  switch (type) {

    // ── init: full SAB + model init (called by app-init.js) ───────────────────
    case 'init': {
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
          pcmChunk,
          fftSize             = 4096,
          halfN               = Math.floor(fftSize / 2) + 1,
          modelBasePath       = './models/',
          preferredProviders  = ['webgpu', 'wasm'],
          allowedModels: am   = DEFAULT_MODELS,
          allowedStages: as_  = 8,
          params              = null,
        } = payload;

        allowedModels = am;
        allowedStages = as_;
        currentFFTSize = fftSize;
        currentHalfN = halfN;
        currentNumBins = halfN;
        if (params && typeof params === 'object') {
          runtimeParams = { ...runtimeParams, ...params };
        }
        if (pcmChunk) {
          latestPcmChunk = pcmChunk instanceof Float32Array ? pcmChunk : new Float32Array(pcmChunk);
        }

        if (inputSAB && outputSAB) {
          const inputPayloadFloats = currentHalfN * 2;
          const outputPayloadFloats = currentHalfN;
          const inputBytes = SAB_HEADER_BYTES + Float32Array.BYTES_PER_ELEMENT * inputPayloadFloats;
          const outputBytes = SAB_HEADER_BYTES + Float32Array.BYTES_PER_ELEMENT * outputPayloadFloats;
          if (inputSAB.byteLength < inputBytes || outputSAB.byteLength < outputBytes) {
            console.error('[ml-worker] SAB size mismatch', {
              expectedInputBytes: inputBytes,
              actualInputBytes: inputSAB.byteLength,
              expectedOutputBytes: outputBytes,
              actualOutputBytes: outputSAB.byteLength,
            });
          } else {
            console.info('[ml-worker] SAB payload sizes verified', {
              halfN: currentHalfN,
              inputBytes,
              outputBytes,
            });
          }
          flagsIn    = new Int32Array(inputSAB, 0, FLAG_SLOTS);
          flagsOut   = new Int32Array(outputSAB, 0, FLAG_SLOTS);
          inputView  = new Float32Array(inputSAB, SAB_HEADER_BYTES, inputPayloadFloats);
          outputView = new Float32Array(outputSAB, SAB_HEADER_BYTES, outputPayloadFloats);
          startPollLoop();
        }

        const modelStatus = await loadModels(modelBasePath, preferredProviders, allowedModels);
        vadModelMissing = !modelStatus.vad && !modelStatus['silero-vad'];
        if (vadModelMissing) {
          const msg = 'Silero VAD unavailable, using fallback VAD';
          console.warn('[ml-worker] ' + msg);
          self.postMessage({ type: 'log', level: 'warn', msg });
          self.postMessage({ type: 'vad_status', vadModelMissing: true });
        } else {
          self.postMessage({ type: 'vad_status', vadModelMissing: false });
        }
        self.postMessage({ type: 'ready', models: modelStatus });
      } else {
        // Bare init (no payload — used in tests and simple invocations)
        const modelStatus = await loadModels('./models/', ['webgpu', 'wasm'], DEFAULT_MODELS);
        vadModelMissing = !modelStatus.vad && !modelStatus['silero-vad'];
        self.postMessage({ type: 'ready', models: modelStatus });
      }
      break;
    }

    // ── loadModel: load a specific set of models and report status ─────────────
    case 'loadModel': {
      try {
        initialize();
      } catch (err) {
        self.postMessage({ type: 'error', msg: err.message });
        return;
      }

      const modelList   = msgModels || DEFAULT_MODELS;
      const modelStatus = await loadModels('./models/', ['webgpu', 'wasm'], modelList);
      vadModelMissing = !modelStatus.vad && !modelStatus['silero-vad'];
      self.postMessage({ type: 'ready', models: modelStatus });
      break;
    }

    // ── process: run inference on a single frame of magnitude data ─────────────
    case 'process': {
      if (!ort || (!inputView && !(payload && payload.magnitudes))) return;

      const magnitudes = payload && payload.magnitudes
        ? new Float32Array(payload.magnitudes)
        : new Float32Array(inputView.subarray(0, currentNumBins));
      const pcmChunk = payload && payload.pcmChunk
        ? (payload.pcmChunk instanceof Float32Array ? payload.pcmChunk : new Float32Array(payload.pcmChunk))
        : latestPcmChunk;
      const mask       = await buildMask(magnitudes, pcmChunk);

      const output = new Float32Array(mask);
      self.postMessage({ type: 'processed', output }, [output.buffer]);
      break;
    }

    // ── reset: clear inference sessions and polling state ─────────────────────
    case 'reset': {
      clearInterval(pollTimer);
      sessions  = {};
      pollTimer = null;
      noiseProfile = null;
      noiseFrames = 0;
      warmupComplete = false;
      speechConfidence = 0;
      speechStreak = 0;
      latestPcmChunk = null;
      demucsPcmMissingWarned = false;
      self.postMessage({ type: 'reset_done' });
      break;
    }

    // ── unload: full cleanup ───────────────────────────────────────────────────
    case 'unload': {
      clearInterval(pollTimer);
      sessions = {};
      latestPcmChunk = null;
      demucsPcmMissingWarned = false;
      self.postMessage({ type: 'unloaded' });
      break;
    }

    // ── update_params: adjust tier caps at runtime ─────────────────────────────
    case 'update_params': {
      if (payload && payload.allowedModels) allowedModels = payload.allowedModels;
      if (payload && payload.allowedStages) allowedStages = payload.allowedStages;
      break;
    }

    case 'setParams': {
      if (payload && typeof payload === 'object') {
        runtimeParams = { ...runtimeParams, ...payload };
      }
      break;
    }

    case 'pcmChunk': {
      const chunk = payload && payload.pcmChunk;
      if (chunk) {
        latestPcmChunk = chunk instanceof Float32Array ? chunk : new Float32Array(chunk);
      }
      break;
    }

    // ── setIsolationConfig: diarization/isolation UI runtime controls ──────────
    case 'setIsolationConfig': {
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
      break;
    }

    // ── multi_separate: multi-speaker stream separation ────────────────────────
    case 'multi_separate': {
      await handleMultiSeparate(payload && payload.streams);
      break;
    }

    // ── diarize ────────────────────────────────────────────────────────────────
    case 'diarize': {
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
      break;
    }

    // ── isolateSpeaker ─────────────────────────────────────────────────────────
    case 'isolateSpeaker': {
      _currentIsolateSpeakerId = (payload || {}).speakerId ?? null;
      break;
    }

    // ── speakerVolumes ─────────────────────────────────────────────────────────
    case 'speakerVolumes': {
      _speakerVolumeMap = payload || {};
      break;
    }

    // ── enrollVoiceprint ───────────────────────────────────────────────────────
    case 'enrollVoiceprint': {
      try {
        const { pcm } = payload || {};
        if (!pcm) return;
        await enrollVoiceprint(new Float32Array(pcm));
        self.postMessage({ type: 'voiceprintEnrolled', payload: { speakerId: 'manual' } });
      } catch(err) {
        self.postMessage({ type: 'error', msg: 'enrollVoiceprint: ' + err.message });
      }
      break;
    }

    // ── enrollFromDiarization ──────────────────────────────────────────────────
    case 'enrollFromDiarization': {
      const { speakerId } = payload || {};
      self.postMessage({ type: 'voiceprintEnrolled', payload: { speakerId } });
      break;
    }

    // ── clearVoiceprint ────────────────────────────────────────────────────────
    case 'clearVoiceprint': {
      _voiceprintEmbedding = null;
      self.postMessage({ type: 'voiceprintCleared' });
      break;
    }

    default:
      console.warn('[ml-worker] unknown message type:', type);
  }

};

// ── 2. Multi-speaker separation ───────────────────────────────────────────────
async function handleMultiSeparate(streams) {
  if (!streams || !streams.length) {
    self.postMessage({ type: 'multi_done', streams: [] });
    return;
  }

  // Apply per-speaker volume from the current speakerVolumeMap.
  // A volume of 0 silences the stream (muted, or not the solo/isolated speaker).
  // _speakerVolumeMap keys may be strings or numbers; check both.
  streams.forEach(s => {
    if (!s || !s.data) return;
    const id = s.speakerId;
    const vol = id in _speakerVolumeMap ? _speakerVolumeMap[id]
              : String(id) in _speakerVolumeMap ? _speakerVolumeMap[String(id)]
              : 1;
    if (vol === 0) {
      s.data.fill(0);
    } else if (vol !== 1) {
      for (let i = 0; i < s.data.length; i++) s.data[i] *= vol;
    }
  });

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
  if (modelId === 'demucs' || modelId === 'demucs-v4') return;
  try {
    let dims, size;
    if (modelId === 'vad' || modelId === 'silero-vad') {
      size = 512; dims = [1, 512]; // Silero VAD fixed input
    } else {
      size = currentNumBins; dims = [1, currentNumBins];
    }
    const input = new ort.Tensor('float32', new Float32Array(size), dims);
    await session.run({ input });
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
  const frameReady = Atomics.load(flagsIn, 2);
  if (frameReady === 0) return;
  Atomics.store(flagsIn, 2, 0); // consume flag

  // subarray() is a zero-copy view — buildMask reads it before any next poll overwrites it.
  const magnitudes = new Float32Array(inputView.subarray(0, currentNumBins));
  const mask       = await buildMask(magnitudes, latestPcmChunk);

  outputView.set(mask);
  Atomics.store(flagsOut, 2, 1); // signal: mask ready
}

// ── 5. Combined mask inference pipeline ──────────────────────────────────────
// Reusable mask buffer — avoids one Float32Array allocation per inference call.
let _maskBuffer = null;
// Reusable 3-bin smoothing scratch — avoids a full-spectrum Float32Array
// allocation per applyWienerFilter() call (~400KB/s GC churn at 50 Hz).
let _smoothBuffer = null;

async function buildMask(magnitudes, pcmChunk = null) {
  const numBins = magnitudes.length;
  // Grow buffer only when numBins increases (rare); reuse otherwise.
  if (!_maskBuffer || _maskBuffer.length < numBins) {
    _maskBuffer = new Float32Array(numBins);
  }
  const mask = _maskBuffer.subarray(0, numBins);
  mask.fill(1.0);

  const fallbackVAD = runVADFallback(magnitudes);

  // VAD gate (silero-vad / vad)
  const vadSess = sessions['vad'] || sessions['silero-vad'];
  let hasModelVAD = false;
  let isVoice = fallbackVAD.isVoice;
  if (vadSess && allowedStages >= 5) {
    try {
      const vadInput = new ort.Tensor('float32', magnitudes, [1, numBins]);
      const result   = await vadSess.run({ input: vadInput });
      const vadProb  = result.output.data;
      hasModelVAD = true;
      if (vadProb.length === 1) {
        const gate = Math.max(0, vadProb[0] * 2 - 0.5);
        isVoice = vadProb[0] >= 0.5;
        for (let k = 0; k < numBins; k++) mask[k] *= gate;
      } else {
        let meanProb = 0;
        for (let k = 0; k < numBins; k++) {
          mask[k] *= vadProb[k];
          meanProb += vadProb[k];
        }
        isVoice = (meanProb / numBins) >= 0.5;
      }
    } catch (e) {
      console.warn('[ml-worker] vad error:', e.message);
    }
  }
  if (!hasModelVAD && vadModelMissing && !vadMissingWarned) {
    vadMissingWarned = true;
    console.warn('[ml-worker] Silero VAD unavailable, fallback VAD enabled');
  }
  if (!isVoice) {
    const nonVoiceMask = 1 / Math.max(1, Number(runtimeParams.nonVoiceSuppression) || 2);
    for (let k = 0; k < numBins; k++) mask[k] *= nonVoiceMask;
  }

  if (!warmupComplete) {
    updateNoiseProfile(magnitudes);
    // Ramp mask from near-silence up to full passthrough over the warmup
    // window instead of clamping to 0. Users previously heard ~1.8s of dead
    // silence before the noise profile was considered converged.
    const ramp = Math.min(1, noiseFrames / NOISE_WARMUP_FRAMES);
    const rampGain = 0.05 + 0.95 * ramp * ramp;
    for (let k = 0; k < numBins; k++) mask[k] *= rampGain;
    return mask;
  }

  applyWienerFilter(magnitudes, mask, isVoice);

  // Demucs v4 vocal separation mask
  const demucsSess = sessions['demucs'] || sessions['demucs-v4'];
  if (demucsSess && allowedStages >= 10 && pcmChunk && pcmChunk.length > 0) {
    try {
      const demucsIn = new ort.Tensor('float32', pcmChunk, [1, 1, pcmChunk.length]);
      const result = await demucsSess.run({ input: demucsIn });
      const vocalMask = result.vocal_mask?.data || result.output?.data || null;
      if (vocalMask) for (let k = 0; k < numBins; k++) {
        mask[k] = Math.min(mask[k], Math.max(0, vocalMask[k]));
      }
    } catch (e) {
      console.warn('[ml-worker] demucs error:', e.message);
    }
  } else if (demucsSess && allowedStages >= 10) {
    // Intentional no-op: never feed magnitude spectra to Demucs.
    // Unity mask is safer than invalid spectral approximation.
    if (!demucsPcmMissingWarned) {
      demucsPcmMissingWarned = true;
      console.warn('[ml-worker] Demucs skipped: PCM chunk unavailable; using unity fallback');
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

  // Final safety pass: clamp all values to [0, 1]; replace NaN/Inf with 1 (passthrough)
  for (let k = 0; k < numBins; k++) {
    const v = mask[k];
    mask[k] = (Number.isFinite(v) && v >= 0) ? Math.min(v, 1) : 1;
  }

  return mask;
}

function runVADFallback(magnitudes) {
  let sum = 0;
  let voiceBand = 0;
  const voiceLo = Math.round((300 / (currentFFTSize / 2)) * (magnitudes.length - 1));
  const voiceHi = Math.round((3400 / (currentFFTSize / 2)) * (magnitudes.length - 1));
  for (let k = 0; k < magnitudes.length; k++) {
    const e = magnitudes[k] * magnitudes[k];
    sum += e;
    if (k >= voiceLo && k <= voiceHi) voiceBand += e;
  }
  const totalRMS = Math.sqrt(sum / Math.max(1, magnitudes.length));
  const energyRatio = voiceBand / Math.max(sum, 1e-9);
  const rmsScore = Math.max(0, Math.min(1, (totalRMS - VAD_FALLBACK_RMS_BASELINE) / VAD_FALLBACK_RMS_RANGE));
  const ratioScore = Math.max(0, Math.min(1, (energyRatio - VAD_FALLBACK_RATIO_BASELINE) / VAD_FALLBACK_RATIO_RANGE));
  const rawScore = VAD_FALLBACK_BLEND_RMS * rmsScore + VAD_FALLBACK_BLEND_RATIO * ratioScore;
  speechConfidence = speechConfidence * 0.85 + rawScore * 0.15;
  speechStreak = speechConfidence > 0.6 ? speechStreak + 1 : Math.max(0, speechStreak - 1);
  return { isVoice: speechStreak >= 3, speechConfidence };
}

function updateNoiseProfile(magnitudes) {
  if (!noiseProfile || noiseProfile.length !== magnitudes.length) {
    noiseProfile = new Float32Array(magnitudes.length);
    noiseFrames = 0;
    warmupComplete = false;
  }
  let sumSq = 0;
  for (let k = 0; k < magnitudes.length; k++) sumSq += magnitudes[k] * magnitudes[k];
  // Seed with a conservative broadband estimate so warmup starts suppressing
  // immediately instead of passing near-raw noise during early frames.
  const broadbandSeed = Math.sqrt(sumSq / Math.max(1, magnitudes.length)) * NOISE_SEED_SCALE + 1e-6;
  const alpha = noiseFrames < 5 ? 0.5 : 0.92;
  for (let k = 0; k < magnitudes.length; k++) {
    if (noiseFrames === 0) noiseProfile[k] = broadbandSeed;
    noiseProfile[k] = alpha * noiseProfile[k] + (1 - alpha) * magnitudes[k];
  }
  noiseFrames++;
  if (noiseFrames >= NOISE_WARMUP_FRAMES) warmupComplete = true;
}

function applyWienerFilter(magnitudes, mask, isVoice) {
  updateNoiseProfile(magnitudes);
  const spectralFloor = Math.max(0.001, Math.min(0.05, Number(runtimeParams.spectralFloor) || 0.005));
  const forensicMode = !!runtimeParams.forensicMode;
  const noiseReduce = Math.max(0, Math.min(1, Number(runtimeParams.noiseReduce) || 0.7));
  // For forensic mode with very low floor, allow stronger subtraction.
  // Otherwise keep alpha capped for voice quality to reduce musical noise.
  const alphaCap = (forensicMode && spectralFloor < FORENSIC_ALPHA_FLOOR_THRESHOLD)
    ? ALPHA_CAP_FORENSIC
    : ALPHA_CAP_DEFAULT;
  const alpha = Math.min(alphaCap, 1.0 + noiseReduce);

  for (let k = 0; k < magnitudes.length; k++) {
    const signalPow = magnitudes[k] * magnitudes[k];
    const noisePow = Math.max(1e-12, noiseProfile[k] * noiseProfile[k] * alpha);
    const snr = Math.min(SNR_MAX, signalPow / noisePow);
    const gain = snr / (snr + 1.0);
    mask[k] *= Math.max(spectralFloor, Math.min(1, gain));
  }

  // 3-bin moving-average smoothing reduces isolated spectral holes (musical noise).
  // Boundary-unrolled to avoid per-bin Math.max/Math.min; buffer is cached.
  const len = mask.length;
  if (!_smoothBuffer || _smoothBuffer.length < len) _smoothBuffer = new Float32Array(len);
  const smooth = _smoothBuffer;
  if (len > 0) {
    smooth[0] = len > 1 ? (mask[0] + mask[0] + mask[1]) / 3 : mask[0];
    const last = len - 1;
    for (let k = 1; k < last; k++) smooth[k] = (mask[k - 1] + mask[k] + mask[k + 1]) / 3;
    if (last > 0) smooth[last] = (mask[last - 1] + mask[last] + mask[last]) / 3;
  }
  const voiceFloor = isVoice ? spectralFloor : Math.min(1, spectralFloor * runtimeParams.nonVoiceSuppression);
  for (let k = 0; k < len; k++) {
    const s = smooth[k];
    mask[k] = s > 1 ? 1 : (s < voiceFloor ? voiceFloor : s);
  }
}
