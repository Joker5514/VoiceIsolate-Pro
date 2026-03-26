/* ============================================
   VoiceIsolate Pro v20.0 — ML Worker
   Threads from Space v10 · ONNX Inference
   Demucs v4 + BSRNN + Silero VAD + ECAPA-TDNN
   WebGPU > WASM fallback · Tensor disposal
   ============================================ */

'use strict';

/**
 * Dedicated Web Worker for ML model inference.
 * - Initializes ONNX Runtime sessions with WebGPU > WASM fallback
 * - Continuous processing loop using Atomics.wait for ring buffer
 * - Explicit tensor disposal to prevent VRAM leaks
 * - Supports: Demucs v4, BSRNN, Silero VAD, ECAPA-TDNN
 */

let ort = null;             // ONNX Runtime reference
let sessions = {};          // { demucs, bsrnn, vad, ecapa }
let provider = 'wasm';      // active execution provider
let inputRing = null;        // SharedRingBuffer (read side)
let maskRing = null;         // SharedRingBuffer (write side)
let running = false;
let frameSize = 4096;
let frameCount = 10;

// Model paths (relative to app root)
const MODEL_PATHS = {
  demucs: 'models/demucs-v4-int8.onnx',
  bsrnn: 'models/bsrnn-int8.onnx',
  vad: 'models/silero_vad.onnx',
  ecapa: 'models/ecapa-tdnn-int8.onnx',
  deepfilter: 'models/deepfilter-int8.onnx'
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
    await handleInfer(msg);
  } else if (msg.type === 'vad') {
    await handleVAD(msg);
  } else if (msg.type === 'separate') {
    await handleSeparate(msg);
  } else if (msg.type === 'process') {
    // Alias for separate — process audio chunk
    await handleSeparate(msg);
  } else if (msg.type === 'reset') {
    // Reset all loaded models and ring buffers
    await disposeAll();
    inputRing = null;
    maskRing = null;
    running = false;
    self.postMessage({ type: 'reset_ok' });
  } else if (msg.type === 'loadModel') {
    await initModels(msg);
  } else if (msg.type === 'enroll') {
    await handleEnroll(msg);
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
 * Load a specific set of ONNX models according to the provided initialization message.
 * @param {Object} msg - Initialization message that may include:
 *   - `models` {string[]} : list of model names to load (e.g. `['vad','deepfilter','demucs']`).
 *   - `modelPaths` {{[name:string]: string}} : optional per-model path overrides.
 *   - `ortUrl` {string} : optional URL to the ONNX Runtime script.
 */
async function initModels(msg) {
  await initialize(msg);
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
  } catch (_) { /* fallback */ }

  try {
    // Test WebGL2
    const canvas = new OffscreenCanvas(1, 1);
    const gl = canvas.getContext('webgl2');
    if (gl) return 'webgl';
  } catch (_) { /* fallback */ }

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

  // Demucs inference
  if (sessions.demucs && weights.demucs > 0) {
    const tensor = new ort.Tensor('float32', frame, [1, 1, frameSize]);
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
    const tensor = new ort.Tensor('float32', frame, [1, 1, frameSize]);
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
  const mask = new Float32Array(frameSize);
  for (let i = 0; i < frameSize; i++) {
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

// ---- Disposal ----
async function disposeAll() {
  running = false;
  for (const [name, session] of Object.entries(sessions)) {
    try {
      await session.release?.();
      log('info', `Disposed model: ${name}`);
    } catch (_) {}
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
