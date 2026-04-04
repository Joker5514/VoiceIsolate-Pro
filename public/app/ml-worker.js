/* ============================================
   VoiceIsolate Pro v20.0 — ML Worker
   Threads from Space v10 · ONNX Inference
   Demucs v4 + BSRNN + Silero VAD + ECAPA-TDNN
   DNS v2 · Noise Classifier · Multi-Speaker Sep
   WebGPU > WASM fallback · Tensor disposal
   ============================================ */

'use strict';

/**
 * Dedicated Web Worker for ML model inference.
 * - Initializes ONNX Runtime sessions with WebGPU > WASM fallback
 * - Continuous processing loop using Atomics.wait for ring buffer
 * - Explicit tensor disposal to prevent VRAM leaks
 * - Supports: Demucs v4, BSRNN, Silero VAD, ECAPA-TDNN,
 *             DNS v2 (conformer), noise classifier, ConvTasNet multi-speaker sep
 */

let ort = null;             // ONNX Runtime reference
let sessions = {};          // { demucs, bsrnn, vad, ecapa }
let provider = 'wasm';      // active execution provider
let inputRing = null;        // SharedRingBuffer (read side)
let maskRing = null;         // SharedRingBuffer (write side)
let running = false;
let frameSize = 4096;
let frameCount = 10;
let activePromises = new Set(); // Track in-flight async inference

// Model paths (relative to app root)
const MODEL_PATHS = {
  demucs: 'models/demucs-v4-int8.onnx',
  bsrnn: 'models/bsrnn-int8.onnx',
  vad: 'models/silero_vad.onnx',
  ecapa: 'models/ecapa-tdnn-int8.onnx',
  deepfilter: 'models/deepfilter-int8.onnx',
  dns2: 'models/dns2_conformer_small.onnx',
  noiseClassifier: 'models/noise_classifier.onnx',
  convtasnet: 'models/convtasnet-int8.onnx'
};

// Default blend weights
let weights = { demucs: 0.7, bsrnn: 0.3 };

// ---- Message Handler ----
self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    await initialize(msg);
  } else if (msg.type === 'initRingBuffers') {
    setupRingBuffers(msg);
  } else if (msg.type === 'startLoop') {
    startProcessingLoop();
  } else if (msg.type === 'stopLoop') {
    running = false;
  } else if (msg.type === 'setWeights') {
    weights.demucs = msg.demucs ?? weights.demucs;
    weights.bsrnn = msg.bsrnn ?? weights.bsrnn;
  } else if (msg.type === 'infer') {
    // One-shot inference for offline pipeline
    const promise = handleInfer(msg);
    activePromises.add(promise);
    await promise.finally(() => activePromises.delete(promise));
  } else if (msg.type === 'vad') {
    const promise = handleVAD(msg);
    activePromises.add(promise);
    await promise.finally(() => activePromises.delete(promise));
  } else if (msg.type === 'separate') {
    const promise = handleSeparate(msg);
    activePromises.add(promise);
    await promise.finally(() => activePromises.delete(promise));
  } else if (msg.type === 'process') {
    // Alias for separate — process audio chunk
    const promise = handleSeparate(msg);
    activePromises.add(promise);
    await promise.finally(() => activePromises.delete(promise));
  } else if (msg.type === 'reset') {
    // Reset all loaded models and ring buffers
    // Wait for all in-flight inference to complete before resetting
    await Promise.all([...activePromises]);
    await disposeAll();
    inputRing = null;
    maskRing = null;
    running = false;
    self.postMessage({ type: 'reset_ok' });
  } else if (msg.type === 'loadModel') {
    await initialize(msg);
  } else if (msg.type === 'enroll') {
    const promise = handleEnroll(msg);
    activePromises.add(promise);
    await promise.finally(() => activePromises.delete(promise));
  } else if (msg.type === 'identify') {
    const promise = handleIdentify(msg);
    activePromises.add(promise);
    await promise.finally(() => activePromises.delete(promise));
  } else if (msg.type === 'dns2') {
    // DNS v2 ONNX model: compute per-bin gain mask from STFT magnitude frame
    const promise = handleDNS2(msg);
    activePromises.add(promise);
    await promise.finally(() => activePromises.delete(promise));
  } else if (msg.type === 'classifyNoise') {
    // Noise classifier: identify noise type from magnitude spectrum
    const promise = handleClassifyNoise(msg);
    activePromises.add(promise);
    await promise.finally(() => activePromises.delete(promise));
  } else if (msg.type === 'multiSeparate') {
    // Multi-speaker source separation using ConvTasNet
    const promise = handleMultiSeparate(msg);
    activePromises.add(promise);
    await promise.finally(() => activePromises.delete(promise));
  } else if (msg.type === 'dispose') {
    await disposeAll();
  }
};

/**
 * Initialize ONNX Runtime, select the best execution provider, and load the requested models into the worker's sessions.
 *
 * Imports ONNX Runtime if not already present, detects an execution provider, attempts to create inference sessions for
 * the models specified by the message (or the default set), and posts a `{ type: 'ready', provider, models }` message
 * containing a `{[modelName]: boolean}` status map on success. If initialization fails, posts a `{ type: 'error', msg }`
 * message instead.
 *
 * @param {Object} msg - Initialization options and overrides.
 * @param {string} [msg.ortUrl] - Optional URL to load the ONNX Runtime script from (falls back to a bundled CDN URL).
 * @param {string[]} [msg.models] - Optional list of model names to load (defaults to `['vad','deepfilter','demucs']`).
 * @param {Object.<string,string>} [msg.modelPaths] - Optional per-model path overrides keyed by model name.
 */
async function initialize(msg) {
  try {
    // Import ONNX Runtime
    if (!ort) {
      importScripts(msg.ortUrl || 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.0/dist/ort.min.js');
      ort = self.ort;
    }

    // Detect best execution provider
    provider = await detectProvider();
    log('info', `ONNX provider: ${provider}`);

    // Configure session options
    const sessionOpts = {
      executionProviders: [provider],
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true
    };

    // Load available models
    const models = msg.models || ['vad', 'deepfilter', 'demucs']; // load core models by default
    for (const name of models) {
      const path = msg.modelPaths?.[name] || MODEL_PATHS[name];
      try {
        sessions[name] = await ort.InferenceSession.create(path, sessionOpts);
        log('info', `Loaded model: ${name}`);
      } catch (err) {
        const displayName = name === 'vad' ? 'VAD' : name;
        log('warn', `${displayName} unavailable: ${err.message}`);
      }
    }

    // Build models status object: { modelName: true/false }
    const modelsStatus = {};
    for (const name of models) {
      modelsStatus[name] = name in sessions;
    }

    self.postMessage({
      type: 'ready',
      provider,
      models: modelsStatus
    });

  } catch (err) {
    log('error', `Init failed: ${err.message}`);
    self.postMessage({ type: 'error', msg: err.message });
  }
}

/**
 * Selects the best available ONNX Runtime execution provider for the current environment.
 * @returns {'webgpu'|'webgl'|'wasm'} `webgpu` if WebGPU is available, `webgl` if WebGL2 is available, `wasm` otherwise.
 */
async function detectProvider() {
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch { /* fallback */ }

  try {
    // Test WebGL2
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext('webgl2');
    if (gl) return 'webgl';
  } catch { /* fallback */ }

  return 'wasm';
}

// ---- Ring Buffer Setup ----
function setupRingBuffers(msg) {
  frameSize = msg.frameSize || 4096;
  frameCount = msg.frameCount || 10;
  const capacity = frameSize * frameCount;

  if (msg.inputSAB) {
    inputRing = {
      control: new Int32Array(msg.inputSAB, 0, 4),
      data: new Float32Array(msg.inputSAB, 16, capacity),
      capacity
    };
  }

  if (msg.maskSAB) {
    maskRing = {
      control: new Int32Array(msg.maskSAB, 0, 4),
      data: new Float32Array(msg.maskSAB, 16, capacity),
      capacity
    };
  }

  log('info', 'Ring buffers initialized');
}

// ---- Continuous Processing Loop ----
function startProcessingLoop() {
  running = true;
  processLoop();
}

async function processLoop() {
  const pullBuf = new Float32Array(frameSize);

  while (running) {
    // Wait for data notification from AudioWorklet
    if (inputRing) {
      const current = Atomics.load(inputRing.control, 0);
      const result = Atomics.wait(inputRing.control, 0, current, 10); // 10ms timeout
      if (result === 'timed-out' && ringAvailable(inputRing) < frameSize) {
        continue;
      }
    } else {
      // No ring buffer — yield
      await new Promise(r => setTimeout(r, 10));
      continue;
    }

    // Pull frame from input ring
    const frame = ringPull(inputRing, frameSize, pullBuf);
    if (!frame) continue;

    // Generate mask
    let mask = null;
    try {
      mask = await generateMask(frame);
    } catch (err) {
      log('warn', `Inference error: ${err.message}`);
      // Fallback: passthrough mask
      mask = new Float32Array(frameSize).fill(1);
    }

    // Push mask to output ring
    if (maskRing && mask) {
      ringPush(maskRing, mask);
    }
  }
}

async function generateMask(frame) {
  let demucsMask = null;
  let bsrnnMask = null;
  const len = frame.length;

  // Demucs inference
  if (sessions.demucs && weights.demucs > 0) {
    const tensor = new ort.Tensor('float32', frame, [1, 1, len]);
    try {
      const result = await sessions.demucs.run({ input: tensor });
      const output = result[Object.keys(result)[0]];
      demucsMask = new Float32Array(output.data);
      output.dispose?.();
    } finally {
      tensor.dispose?.();
    }
  }

  // BSRNN inference
  if (sessions.bsrnn && weights.bsrnn > 0) {
    const tensor = new ort.Tensor('float32', frame, [1, 1, len]);
    try {
      const result = await sessions.bsrnn.run({ input: tensor });
      const output = result[Object.keys(result)[0]];
      bsrnnMask = new Float32Array(output.data);
      output.dispose?.();
    } finally {
      tensor.dispose?.();
    }
  }

  // Ensemble fusion
  const mask = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const d = demucsMask ? demucsMask[i] * weights.demucs : 0;
    const b = bsrnnMask ? bsrnnMask[i] * weights.bsrnn : 0;
    const total = (demucsMask ? weights.demucs : 0) + (bsrnnMask ? weights.bsrnn : 0);
    mask[i] = total > 0 ? Math.min(1, (d + b) / total) : 1;
  }

  return mask;
}

// ---- One-Shot Handlers ----
async function handleInfer(msg) {
  const id = msg.id;
  try {
    const data = msg.data; // Float32Array
    const mask = await generateMask(data);
    self.postMessage({ type: 'inferResult', id, mask }, [mask.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id, msg: err.message });
  }
}

async function handleVAD(msg) {
  const id = msg.id;
  if (!sessions.vad) {
    self.postMessage({ type: 'vadResult', id, confidence: new Float32Array(0) });
    return;
  }

  try {
    const data = msg.data;
    const sr = msg.sampleRate || 16000;
    const windowSize = 512;
    const confidence = new Float32Array(Math.ceil(data.length / windowSize));

    // Process in windows
    let state = new Float32Array(2 * 1 * 128).fill(0); // LSTM state
    for (let i = 0; i < confidence.length; i++) {
      const start = i * windowSize;
      const end = Math.min(start + windowSize, data.length);
      const chunk = data.subarray(start, end);

      const inputTensor = new ort.Tensor('float32', chunk, [1, chunk.length]);
      const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(sr)]), [1]);
      const stateTensor = new ort.Tensor('float32', state, [2, 1, 128]);

      try {
        const result = await sessions.vad.run({
          input: inputTensor,
          sr: srTensor,
          state: stateTensor
        });
        confidence[i] = result.output?.data?.[0] ?? 0.5;
        if (result.stateN?.data) {
          state = new Float32Array(result.stateN.data);
        }
        // Dispose outputs
        for (const val of Object.values(result)) val.dispose?.();
      } finally {
        inputTensor.dispose?.();
        srTensor.dispose?.();
        stateTensor.dispose?.();
      }
    }

    self.postMessage({ type: 'vadResult', id, confidence }, [confidence.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id, msg: err.message });
  }
}

/**
 * Perform chunked source separation on the provided audio buffer, post progress updates, and send the separated result.
 *
 * @param {Object} msg - Message containing separation parameters.
 * @param {string|number} msg.id - Identifier echoed back with progress and result messages.
 * @param {Float32Array} msg.data - Mono audio samples to separate.
 * @param {number} [msg.chunkSize] - Optional chunk size in samples; defaults to 44100 * 10 (10 seconds).
 */
async function handleSeparate(msg) {
  const id = msg.id;
  try {
    const data = msg.data;
    const chunkSize = msg.chunkSize || 44100 * 10; // 10s chunks
    const result = new Float32Array(data.length);
    const totalChunks = Math.ceil(data.length / chunkSize);

    for (let c = 0; c < totalChunks; c++) {
      const start = c * chunkSize;
      const end = Math.min(start + chunkSize, data.length);
      const chunk = data.subarray(start, end);

      const mask = await generateMask(chunk);
      for (let i = 0; i < chunk.length; i++) {
        result[start + i] = chunk[i] * mask[i];
      }

      self.postMessage({
        type: 'progress',
        id,
        stage: 'separation',
        pct: Math.round(((c + 1) / totalChunks) * 100)
      });
    }

    const output = result;
    self.postMessage({ type: 'separateResult', id, data: output }, [output.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id, msg: err.message });
  }
}

async function handleEnroll(msg) {
  const id = msg.id;
  if (!sessions.ecapa) {
    self.postMessage({ type: 'enrollResult', id, embedding: null, msg: 'ECAPA-TDNN not loaded' });
    return;
  }

  try {
    const data = msg.data;
    const tensor = new ort.Tensor('float32', data, [1, 1, data.length]);
    try {
      const result = await sessions.ecapa.run({ input: tensor });
      const output = result[Object.keys(result)[0]];
      const embedding = new Float32Array(output.data);
      output.dispose?.();
      self.postMessage({ type: 'enrollResult', id, embedding }, [embedding.buffer]);
    } finally {
      tensor.dispose?.();
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, msg: err.message });
  }
}

/**
 * Extract a speaker embedding from an audio segment for real-time identification.
 * Posts { type: 'identifyResult', id, embedding } — or embedding: null when model unavailable.
 *
 * @param {Object} msg
 * @param {string|number} msg.id    - Call identifier echoed back in the result.
 * @param {Float32Array}  msg.data  - Mono audio samples (any sample rate, model normalises internally).
 */
async function handleIdentify(msg) {
  const id = msg.id;
  if (!sessions.ecapa) {
    self.postMessage({ type: 'identifyResult', id, embedding: null });
    return;
  }

  try {
    const data = msg.data;
    const tensor = new ort.Tensor('float32', data, [1, 1, data.length]);
    try {
      const result = await sessions.ecapa.run({ input: tensor });
      const output = result[Object.keys(result)[0]];
      const embedding = new Float32Array(output.data);
      output.dispose?.();
      self.postMessage({ type: 'identifyResult', id, embedding }, [embedding.buffer]);
    } finally {
      tensor.dispose?.();
    }
  } catch (err) {
    self.postMessage({ type: 'identifyResult', id, embedding: null, error: err.message });
    log('warn', `Speaker identification error: ${err.message}`);
  }
}

/**
 * DNS v2 (Microsoft DNS Challenge v2) ONNX inference.
 * Computes a per-frequency-bin gain mask from a 512-point STFT magnitude frame
 * at 16 kHz. The mask (0..1) is posted as { type: 'dns2_mask', id, mask }.
 *
 * Graceful fallback: if the dns2 model failed to load, posts an all-ones mask
 * (passthrough) instead of crashing.
 *
 * @param {object} msg
 * @param {string|number} msg.id        - Call identifier
 * @param {Float32Array}  msg.magnitude - 512-point STFT magnitude (16 kHz)
 */
async function handleDNS2(msg) {
  const id = msg.id;
  const magnitude = msg.magnitude;

  if (!sessions.dns2 || !magnitude) {
    // Graceful fallback: passthrough mask
    const mask = new Float32Array(magnitude ? magnitude.length : 257).fill(1);
    self.postMessage({ type: 'dns2_mask', id, mask }, [mask.buffer]);
    return;
  }

  try {
    const tensor = new ort.Tensor('float32', magnitude, [1, 1, magnitude.length]);
    try {
      const result = await sessions.dns2.run({ input: tensor });
      const output = result[Object.keys(result)[0]];
      // Clamp gain mask to [0, 1]
      const rawMask = new Float32Array(output.data);
      for (let i = 0; i < rawMask.length; i++) {
        rawMask[i] = Math.max(0, Math.min(1, rawMask[i]));
      }
      output.dispose?.();
      self.postMessage({ type: 'dns2_mask', id, mask: rawMask }, [rawMask.buffer]);
    } finally {
      tensor.dispose?.();
    }
  } catch (err) {
    log('warn', `DNS v2 inference failed: ${err.message} — using passthrough mask`);
    const mask = new Float32Array(magnitude.length).fill(1);
    self.postMessage({ type: 'dns2_mask', id, mask }, [mask.buffer]);
  }
}

/**
 * Noise classifier: identify the dominant background noise type from a
 * compact spectral feature vector derived from STFT magnitude frames.
 *
 * Attempts ONNX inference with the noiseClassifier model. Falls back to
 * posting { noiseClass: 'unknown', confidence: 0 } on failure.
 *
 * @param {object} msg
 * @param {string|number} msg.id       - Call identifier
 * @param {Float32Array}  msg.features - Compact feature vector (e.g. 64-dim mel-band energies)
 * @param {string[]}      [msg.labels] - Optional class label array (overrides default)
 */
async function handleClassifyNoise(msg) {
  const id = msg.id;
  const features = msg.features;
  const labels = msg.labels || ['music', 'white_noise', 'crowd', 'HVAC', 'keyboard', 'traffic', 'silence'];

  if (!sessions.noiseClassifier || !features) {
    self.postMessage({ type: 'noiseClassResult', id, noiseClass: 'unknown', confidence: 0 });
    return;
  }

  try {
    const tensor = new ort.Tensor('float32', features, [1, features.length]);
    try {
      const result = await sessions.noiseClassifier.run({ input: tensor });
      const output = result[Object.keys(result)[0]];
      const logits = new Float32Array(output.data);
      output.dispose?.();

      // Softmax over logits
      const maxLogit = Math.max(...logits);
      let sumExp = 0;
      const probs = new Float32Array(logits.length);
      for (let i = 0; i < logits.length; i++) {
        probs[i] = Math.exp(logits[i] - maxLogit);
        sumExp += probs[i];
      }
      for (let i = 0; i < probs.length; i++) probs[i] /= sumExp;

      // Best class
      let bestIdx = 0;
      for (let i = 1; i < probs.length; i++) {
        if (probs[i] > probs[bestIdx]) bestIdx = i;
      }
      const noiseClass = labels[bestIdx] || `class_${bestIdx}`;
      const confidence = probs[bestIdx];

      self.postMessage({ type: 'noiseClassResult', id, noiseClass, confidence });
    } finally {
      tensor.dispose?.();
    }
  } catch (err) {
    log('warn', `Noise classifier inference failed: ${err.message}`);
    self.postMessage({ type: 'noiseClassResult', id, noiseClass: 'unknown', confidence: 0 });
  }
}

/**
 * Multi-speaker source separation using ConvTasNet (or SepFormer variant).
 * Separates the mixed audio into up to 4 speaker streams.
 *
 * Each separated stream is tagged with a speaker index (0-based). If the
 * ConvTasNet model is unavailable, the original mix is returned as the sole
 * stream (graceful fallback, no crash).
 *
 * @param {object}        msg
 * @param {string|number} msg.id             - Call identifier
 * @param {Float32Array}  msg.data           - Mixed mono audio samples
 * @param {string}        [msg.mode]         - 'target-only' | 'all-speakers' | 'off'
 * @param {number}        [msg.targetSpeaker] - 0-based index of the target speaker
 * @param {number}        [msg.attenuationDb] - Attenuation for non-target streams (default -24 dB)
 */
async function handleMultiSeparate(msg) {
  const id = msg.id;
  const data = msg.data;
  const mode = msg.mode || 'target-only';
  const targetSpeaker = msg.targetSpeaker ?? 0;
  const attenuationLin = Math.pow(10, (msg.attenuationDb ?? -24) / 20);

  if (mode === 'off' || !sessions.convtasnet || !data) {
    // Passthrough: single stream = original mix
    self.postMessage({
      type: 'multiSeparateResult',
      id,
      streams: [{ speakerId: 0, data: new Float32Array(data || []) }]
    }, data ? [data.buffer] : []);
    return;
  }

  try {
    const tensor = new ort.Tensor('float32', data, [1, 1, data.length]);
    let streams;
    try {
      const result = await sessions.convtasnet.run({ input: tensor });
      const output = result[Object.keys(result)[0]];
      // Expected output shape: [1, numSpeakers, numSamples]
      const numSpeakers = Math.min(4, output.dims[1] || 1);
      const numSamples = data.length;
      streams = [];
      for (let s = 0; s < numSpeakers; s++) {
        const start = s * numSamples;
        const streamData = new Float32Array(output.data.slice(start, start + numSamples));

        if (mode === 'target-only' && s !== targetSpeaker) {
          // Attenuate non-target speakers (kept at -24 dB for monitoring)
          for (let i = 0; i < streamData.length; i++) streamData[i] *= attenuationLin;
        }

        streams.push({ speakerId: s, data: streamData });
      }
      output.dispose?.();
    } finally {
      tensor.dispose?.();
    }

    // Transfer all stream buffers zero-copy
    const transferables = streams.map(s => s.data.buffer);
    self.postMessage({ type: 'multiSeparateResult', id, streams }, transferables);

  } catch (err) {
    log('warn', `Multi-speaker separation failed: ${err.message} — passthrough`);
    // Graceful fallback: return original mix as single stream
    const fallback = new Float32Array(data);
    self.postMessage({
      type: 'multiSeparateResult',
      id,
      streams: [{ speakerId: 0, data: fallback }]
    }, [fallback.buffer]);
  }
}

// ---- Disposal ----
async function disposeAll() {
  running = false;
  for (const [name, session] of Object.entries(sessions)) {
    try {
      await session.release?.();
      log('info', `Disposed model: ${name}`);
    } catch (e) {
      log('error', `Failed to dispose model ${name}: ${e.message || e}`);
    }
  }
  sessions = {};
}

// ---- Ring Buffer Helpers ----
function ringAvailable(ring) {
  const w = Atomics.load(ring.control, 0);
  const r = Atomics.load(ring.control, 1);
  return (w - r + ring.capacity) % ring.capacity;
}

function ringPull(ring, count, dest) {
  if (ringAvailable(ring) < count) return null;
  let r = Atomics.load(ring.control, 1);
  const first = Math.min(count, ring.capacity - r);
  dest.set(ring.data.subarray(r, r + first));
  if (first < count) dest.set(ring.data.subarray(0, count - first), first);
  Atomics.store(ring.control, 1, (r + count) % ring.capacity);
  return dest;
}

function ringPush(ring, samples) {
  const len = samples.length;
  const avail = ringAvailable(ring);
  const space = ring.capacity - 1 - avail;
  if (len > space) { Atomics.add(ring.control, 3, 1); return false; }
  let w = Atomics.load(ring.control, 0);
  const first = Math.min(len, ring.capacity - w);
  ring.data.set(samples.subarray(0, first), w);
  if (first < len) ring.data.set(samples.subarray(first), 0);
  Atomics.store(ring.control, 0, (w + len) % ring.capacity);
  return true;
}

// ---- Logging ----
function log(level, message) {
  self.postMessage({ type: 'log', level, msg: message });
}