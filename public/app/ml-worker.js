/* ============================================
   VoiceIsolate Pro v22.1 — ML Worker
   Threads from Space v11 · ONNX Inference
   Demucs v4 + BSRNN + Silero VAD + ECAPA-TDNN
   DNS v2 · Noise Classifier · Multi-Speaker Sep
   WebGPU > WASM fallback · Tensor disposal
   FIX: Issue #15 — updated from v20.0/v10 to v22.1/v11
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
 * @param {string} [msg.ortUrl] - Unused. ONNX Runtime is always loaded from /lib/ort.min.js. CDN fallback is prohibited by architecture constraint.
 * @param {string[]} [msg.models] - Optional list of model names to load (defaults to `['vad','deepfilter','demucs']`).
 * @param {Object.<string,string>} [msg.modelPaths] - Optional per-model path overrides keyed by model name.
 */
async function initialize(msg) {
  try {
    if (!self.ort) {
      importScripts('/lib/ort.min.js');
    }

    provider = await detectProvider();
    log('info', `ONNX provider: ${provider}`);

    const sessionOpts = {
      executionProviders: provider !== 'wasm' ? [provider, 'wasm'] : ['wasm'],
      graphOptimizationLevel: 'all',
      enableCpuMemArena: true,
      enableMemPattern: true
    };

    const models = msg.models || ['vad', 'deepfilter', 'demucs'];
    for (const name of models) {
      const path = msg.modelPaths?.[name] || MODEL_PATHS[name];
      try {
        sessions[name] = await self.ort.InferenceSession.create(path, sessionOpts);
        log('info', `Loaded model: ${name}`);
      } catch (err) {
        const displayName = name === 'vad' ? 'VAD' : name;
        log('warn', `${displayName} unavailable: ${err.message}`);
      }
    }

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
  } catch (e) {
    console.warn("WebGPU not available, falling back to wasm");
  }
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
    if (inputRing) {
      if (ringAvailable(inputRing) < frameSize) {
        await new Promise(r => setTimeout(r, 0));
        continue;
      }
    } else {
      await new Promise(r => setTimeout(r, 10));
      continue;
    }

    // Pull frame from input ring
    const frame = ringPull(inputRing, frameSize, pullBuf);
    if (!frame) continue;

    // Produce time-domain processed audio (not a raw gain mask).
    // The worklet reads these samples directly as mlOut.
    let processedAudio = null;
    try {
      const session = sessions.deepfilter || sessions.dns2 || sessions.demucs || null;
      processedAudio = await processChunkWithMask(frame, session);
    } catch (err) {
      log('warn', `Inference error: ${err.message}`);
      // Fallback: passthrough (copy input as-is)
      processedAudio = new Float32Array(frame);
    }

    // Push reconstructed audio into the ring buffer read by the worklet
    if (maskRing && processedAudio) {
      ringPush(maskRing, processedAudio);
    }
  }
}

/**
 * Run spectral masking inference on one audio chunk and return time-domain output.
 * Steps: window → FFT → model inference (gain mask) → apply mask → iFFT → return audio.
 * Falls back to a passthrough (all-ones mask) if no session is available.
 *
 * @param {Float32Array} chunk   - Input audio samples (up to fftSize)
 * @param {object|null}  session - ONNX InferenceSession, or null for passthrough
 * @returns {Float32Array} Reconstructed time-domain audio (same length as chunk)
 */
async function processChunkWithMask(chunk, session) {
  const fftSize = 4096;
  const halfN = fftSize / 2 + 1;

  // Zero-pad to fftSize and apply Hann window
  const padded = new Float32Array(fftSize);
  padded.set(chunk.subarray(0, Math.min(chunk.length, fftSize)));
  for (let i = 0; i < fftSize; i++) {
    padded[i] *= 0.5 * (1 - Math.cos(2 * Math.PI * i / fftSize));
  }

  // Forward FFT
  const re = new Float32Array(padded);
  const im = new Float32Array(fftSize);
  simpleRadix2FFT(re, im, false);

  // Polar form (magnitude + phase) for positive frequencies
  const mag = new Float32Array(halfN);
  const phase = new Float32Array(halfN);
  for (let k = 0; k < halfN; k++) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    phase[k] = Math.atan2(im[k], re[k]);
  }

  // Model inference → per-bin gain mask
  let gainMask;
  if (session) {
    try {
      const tensor = new self.ort.Tensor('float32', mag, [1, 1, halfN]);
      const results = await session.run({ input: tensor });
      const outputKey = Object.keys(results)[0];
      const rawMask = results[outputKey];
      gainMask = new Float32Array(rawMask.data);
      rawMask.dispose?.();
      tensor.dispose?.();
    } catch (err) {
      gainMask = new Float32Array(halfN).fill(1);
    }
  } else {
    gainMask = new Float32Array(halfN).fill(1);
  }

  // Apply gain mask in spectral domain and reconstruct complex spectrum
  const outRe = new Float32Array(fftSize);
  const outIm = new Float32Array(fftSize);
  for (let k = 0; k < halfN; k++) {
    const gain = Math.max(0, Math.min(1, gainMask[k]));
    const m = mag[k] * gain;
    outRe[k] = m * Math.cos(phase[k]);
    outIm[k] = m * Math.sin(phase[k]);
    // Conjugate symmetry for real IFFT
    if (k > 0 && k < fftSize - k) {
      outRe[fftSize - k] = outRe[k];
      outIm[fftSize - k] = -outIm[k];
    }
  }

  // Inverse FFT — simpleRadix2FFT divides by N internally when inverse=true
  simpleRadix2FFT(outRe, outIm, true);

  const audioOut = new Float32Array(chunk.length);
  const copyLen = Math.min(chunk.length, fftSize);
  for (let i = 0; i < copyLen; i++) {
    audioOut[i] = outRe[i];
  }
  return audioOut;
}

async function generateMask(frame) {
  let demucsMask = null;
  let bsrnnMask = null;
  const len = frame.length;

  // Demucs inference
  if (sessions.demucs && weights.demucs > 0) {
    // Duplicate mono to channel 2 for demucs (stereo expected)
    const stereo = new Float32Array(len * 2);
    stereo.set(frame, 0);
    stereo.set(frame, len);
    const tensor = new self.ort.Tensor('float32', stereo, [1, 2, len]);
    try {
      const result = await sessions.demucs.run({ input: tensor });
      const output = result[Object.keys(result)[0]];
      const outData = new Float32Array(output.data);
      demucsMask = new Float32Array(len);
      // Average stereo mask back to mono
      for(let i=0; i<len; i++) demucsMask[i] = (outData[i] + outData[len + i]) / 2;
      output.dispose?.();
    } finally {
      tensor.dispose?.();
    }
  }

  // BSRNN inference
  if (sessions.bsrnn && weights.bsrnn > 0) {
    // Duplicate mono to channel 2 for demucs (stereo expected)
    const stereo = new Float32Array(len * 2);
    stereo.set(frame, 0);
    stereo.set(frame, len);
    const tensor = new self.ort.Tensor('float32', stereo, [1, 2, len]);
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
    const stateSize = sr === 16000 ? 64 : 128;
    let state = new Float32Array(2 * 1 * stateSize).fill(0); // LSTM state
    for (let i = 0; i < confidence.length; i++) {
      const start = i * windowSize;
      const end = Math.min(start + windowSize, data.length);
      let chunk = data.subarray(start, end);
      if (chunk.length < windowSize) {
         const padded = new Float32Array(windowSize);
         padded.set(chunk);
         chunk = padded;
      }

      const inputTensor = new self.ort.Tensor('float32', chunk, [1, chunk.length]);
      const srTensor = new self.ort.Tensor('int64', BigInt64Array.from([BigInt(sr)]), [1]);
      const stateTensor = new self.ort.Tensor('float32', state, [2, 1, stateSize]);

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
    const chunkSize = msg.chunkSize || 4096; // Need pow2 for FFT
    const result = new Float32Array(data.length);
    const totalChunks = Math.ceil(data.length / chunkSize);

    for (let c = 0; c < totalChunks; c++) {
      const start = c * chunkSize;
      const end = Math.min(start + chunkSize, data.length);
      const chunk = data.subarray(start, end);

      const re = new Float32Array(chunkSize);
      re.set(chunk);
      const im = new Float32Array(chunkSize);

      simpleRadix2FFT(re, im, false);

      const mag = new Float32Array(chunkSize);
      for(let i=0; i<chunkSize; i++) mag[i] = Math.sqrt(re[i]*re[i] + im[i]*im[i]);

      // Inference on magnitude using generateMask (which handles bsrnn/demucs internally)
      const mask = await generateMask(mag);

      for(let i=0; i<chunkSize; i++) {
        re[i] *= mask[i];
        im[i] *= mask[i];
      }

      simpleRadix2FFT(re, im, true);

      for(let i=0; i<chunk.length; i++) {
        result[start + i] = re[i];
      }

      self.postMessage({ type: 'progress', id, stage: 'separation', pct: Math.round(((c+1)/totalChunks)*100) });
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
    const tensor = new self.ort.Tensor('float32', data, [1, 1, data.length]);
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
    const tensor = new self.ort.Tensor('float32', data, [1, 1, data.length]);
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
    const mask = new Float32Array(magnitude ? magnitude.length : 513).fill(1);
    self.postMessage({ type: 'dns2_mask', id, mask }, [mask.buffer]);
    return;
  }

  try {
    const tensor = new self.ort.Tensor('float32', magnitude, [1, 1, magnitude.length]);
    try {
      const result = await sessions.dns2.run({ input: tensor });
      const output = result[Object.keys(result)[0]];
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
    log('warn', `DNS v2 inference failed: ${err.message}`);
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
    const tensor = new self.ort.Tensor('float32', features, [1, features.length]);
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
    const tensor = new self.ort.Tensor('float32', data, [1, 1, data.length]);
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

    // Transfer all stream buffers zero-copy (guard against null entries)
    const transferables = streams
      .map(s => s && s.data && s.data.buffer)
      .filter(Boolean);
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
      await session?.dispose?.();
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

function simpleRadix2FFT(re, im, inverse) {
  const N = re.length;
  let j = 0;
  for (let i = 0; i < N - 1; i++) {
    if (i < j) {
      let tr = re[i]; let ti = im[i];
      re[i] = re[j]; im[i] = im[j];
      re[j] = tr; im[j] = ti;
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  const dir = inverse ? 1 : -1;
  for (let m = 2; m <= N; m <<= 1) {
    const w = 2 * Math.PI / m;
    const wpr = Math.cos(w);
    const wpi = dir * Math.sin(w);
    let wr = 1; let wi = 0;
    const m2 = m >> 1;
    for (let j = 0; j < m2; j++) {
      for (let i = j; i < N; i += m) {
        const k = i + m2;
        const tr = wr * re[k] - wi * im[k];
        const ti = wr * im[k] + wi * re[k];
        re[k] = re[i] - tr; im[k] = im[i] - ti;
        re[i] += tr; im[i] += ti;
      }
      let tpr = wr;
      wr = wr * wpr - wi * wpi;
      wi = wi * wpr + tpr * wpi;
    }
  }
  if (inverse) {
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }
}
