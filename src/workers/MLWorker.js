/**
 * VoiceIsolate Pro — ML Worker (Layer 2: Workers)
 *
 * Classic Web Worker that performs offline ONNX model inference for voice isolation.
 * Implements the spectral-mask strategy: STFT magnitude → mask → masked iSTFT overlap-add.
 *
 * Architecture:
 * - Receives model manifest entries via 'init' message (does not import ModelManifest.js)
 * - Loads ONNX Runtime via importScripts (classic worker, not ES module)
 * - Verifies model integrity using SHA-256 before creating sessions
 * - Caches loaded InferenceSessions to avoid reloading
 * - Processes audio in batches using overlap-add STFT/iSTFT
 *
 * Message Protocol:
 * - 'init': { models: Object } — Initialize with model manifest entries
 * - 'process': { audioData, sampleRate, modelId, options } — Process audio
 * - 'unload': { modelId } — Unload a cached model
 * - 'shutdown': {} — Clean up and terminate
 *
 * Response Messages:
 * - 'progress': { stage, progress, modelId } — Loading progress
 * - 'result': { audioData, metadata } — Processed audio result
 * - 'error': { error, details } — Error information
 *
 * IMPORTANT: This is a classic worker (not module worker) because ONNX Runtime
 * must be loaded via importScripts. It cannot use ES6 import/export.
 */
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_FFT_SIZE = 4096;
const DEFAULT_HOP_SIZE = 1024;
const DEFAULT_BINS = 2049; // (4096 / 2) + 1
const DEFAULT_SAMPLE_RATE = 48000;
const MAX_BATCH_FRAMES = 32;

// ─────────────────────────────────────────────────────────────────────────────
// Global State
// ─────────────────────────────────────────────────────────────────────────────

// ONNX Runtime instance - may be provided by test sandbox or initialized by worker
// Use var to allow checking if it exists in the global scope before assignment
// eslint-disable-next-line no-undef, no-use-before-define -- Intentional pattern:
// In test sandbox, ort is injected as a global before this code runs.
// In worker, ort is undefined here and set by initializeORT() via importScripts.
// The self-referential check (typeof ort !== 'undefined') is safe because it's
// inside a try-catch and only evaluates if ort exists in the global scope.
var ort = (function() {
  try {
    // In test sandbox, ort is provided as a global
    // In worker, it will be null and set by initializeORT()
    return (typeof ort !== 'undefined') ? ort : null;
  } catch (e) {
    return null;
  }
})();
let modelManifest = {}; // Model manifest entries received via 'init'
let sessions = new Map(); // Cached InferenceSessions: modelId → session
let loading = new Map(); // In-progress loads: modelId → Promise

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize ONNX Runtime. Called lazily on first use.
 */
function initializeORT() {
  if (ort) return;

  try {
    // Load ONNX Runtime from vendored file
    importScripts('/lib/ort.min.js');
    ort = self.ort;

    if (!ort) {
      throw new Error('ONNX Runtime failed to load');
    }

    // Configure WASM paths
    ort.env.wasm.wasmPaths = '/lib/';
    ort.env.wasm.numThreads = 1; // Single-threaded for stability

    console.log('[MLWorker] ONNX Runtime initialized');
  } catch (error) {
    console.error('[MLWorker] Failed to initialize ONNX Runtime:', error);
    throw error;
  }
}

/**
 * Compute SHA-256 hash of an ArrayBuffer.
 * @param {ArrayBuffer} buffer
 * @returns {Promise<string>} Lowercase hex digest
 */
async function computeSHA256(buffer) {
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Verify model integrity using SHA-256.
 * @param {ArrayBuffer} buffer
 * @param {string} expectedHash
 * @param {string} modelId
 * @throws {Error} If hash mismatch
 */
async function verifyModelIntegrity(buffer, expectedHash, modelId) {
  if (!expectedHash) {
    console.warn(`[MLWorker] No SHA-256 hash for model '${modelId}' — skipping integrity check`);
    return;
  }

  const actualHash = await computeSHA256(buffer);
  if (actualHash !== expectedHash.toLowerCase()) {
    throw new Error(
      `Model integrity check failed for '${modelId}': ` +
      `expected ${expectedHash}, got ${actualHash}`
    );
  }

  console.log(`[MLWorker] Model '${modelId}' integrity verified`);
}

/**
 * Load a model and create an InferenceSession.
 * @param {string} modelId
 * @returns {Promise<ort.InferenceSession>}
 */
async function loadModel(modelId) {
  // Check cache
  if (sessions.has(modelId)) {
    return sessions.get(modelId);
  }

  // Check if already loading
  if (loading.has(modelId)) {
    return loading.get(modelId);
  }

  // Get model info from manifest
  const modelInfo = modelManifest[modelId];
  if (!modelInfo) {
    throw new Error(`Unknown model ID: '${modelId}'. Available: ${Object.keys(modelManifest).join(', ')}`);
  }

  // Create loading promise
  const loadPromise = (async () => {
    try {
      // Send progress: loading
      self.postMessage({
        type: 'progress',
        stage: 'loading',
        progress: 0,
        modelId
      });

      console.log(`[MLWorker] Loading model '${modelId}' from ${modelInfo.url}`);

      // Fetch model
      const response = await fetch(modelInfo.url);
      if (!response.ok) {
        throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
      }

      const arrayBuffer = await response.arrayBuffer();

      // Verify integrity
      if (modelInfo.sha256) {
        await verifyModelIntegrity(arrayBuffer, modelInfo.sha256, modelId);
      }

      // Send progress: initializing
      self.postMessage({
        type: 'progress',
        stage: 'initializing',
        progress: 0.5,
        modelId
      });

      // Create inference session
      const session = await ort.InferenceSession.create(arrayBuffer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });

      console.log(`[MLWorker] Model '${modelId}' loaded successfully`);

      // Send progress: ready
      self.postMessage({
        type: 'progress',
        stage: 'ready',
        progress: 1,
        modelId
      });

      return session;
    } catch (error) {
      console.error(`[MLWorker] Failed to load model '${modelId}':`, error);
      throw error;
    }
  })();

  loading.set(modelId, loadPromise);

  try {
    const session = await loadPromise;
    sessions.set(modelId, session);
    loading.delete(modelId);
    return session;
  } catch (error) {
    loading.delete(modelId);
    throw error;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DSP Primitives (exposed for testing)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-place Cooley-Tukey FFT (radix-2, decimation-in-time).
 * @param {Float32Array} re - Real part (input/output)
 * @param {Float32Array} im - Imaginary part (input/output)
 * @param {boolean} inverse - If true, perform inverse FFT
 */
function fftInPlace(re, im, inverse) {
  const n = re.length;
  if (n < 2 || (n & (n - 1)) !== 0) {
    throw new Error('FFT size must be a power of 2');
  }

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
    let k = n >> 1;
    while (k <= j) {
      j -= k;
      k >>= 1;
    }
    j += k;
  }

  // Cooley-Tukey decimation-in-time
  const dir = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const angle = (dir * 2 * Math.PI) / len;
    const wStepReal = Math.cos(angle);
    const wStepImag = Math.sin(angle);

    for (let i = 0; i < n; i += len) {
      let wReal = 1;
      let wImag = 0;

      for (let j = 0; j < halfLen; j++) {
        const k = i + j;
        const l = k + halfLen;

        const tReal = wReal * re[l] - wImag * im[l];
        const tImag = wReal * im[l] + wImag * re[l];

        re[l] = re[k] - tReal;
        im[l] = im[k] - tImag;
        re[k] += tReal;
        im[k] += tImag;

        const nextWReal = wReal * wStepReal - wImag * wStepImag;
        wImag = wReal * wStepImag + wImag * wStepReal;
        wReal = nextWReal;
      }
    }
  }

  // Normalize inverse FFT
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * Process audio using spectral-mask strategy (exposed for testing).
 *
 * NOTE: This function is currently unused in production code but is preserved
 * for potential future use and testing purposes. It provides a complete
 * implementation of spectral masking with STFT/iSTFT that could be used
 * for alternative model architectures or testing scenarios.
 *
 * @param {object} entry - Model manifest entry
 * @param {object} session - ONNX InferenceSession
 * @param {Float32Array} audio - Input audio
 * @param {function} onProgress - Progress callback
 * @returns {Promise<Float32Array>} Processed audio
 */
// eslint-disable-next-line no-unused-vars -- Preserved for testing and future use
async function runSpectralMask(entry, session, audio, onProgress) {
  const fftSize = entry.fftSize || DEFAULT_FFT_SIZE;
  const hopSize = entry.hopSize || DEFAULT_HOP_SIZE;
  const bins = entry.bins || DEFAULT_BINS;
  const maxBatchFrames = entry.maxBatchFrames || MAX_BATCH_FRAMES;

  // Get ort reference - in test sandbox, ort is provided as a global variable
  // In production worker, ort is the module-level variable initialized by initializeORT()
  // Try multiple ways to access ort:
  // 1. Module variable (worker environment after initializeORT())
  // 2. globalThis (modern environments)
  // 3. this (function context)
  const ortRuntime = ort ||
                     (typeof globalThis !== 'undefined' && globalThis.ort) ||
                     (typeof this !== 'undefined' && this.ort) ||
                     null;
  
  if (!ortRuntime) {
    throw new Error('[MLWorker] ONNX Runtime not available');
  }

  // Perform STFT
  const { magnitudes, phases, numFrames } = stft(audio, fftSize, hopSize);

  // Process in batches
  const maskedMagnitudes = [];
  let processedFrames = 0;

  for (let i = 0; i < numFrames; i += maxBatchFrames) {
    const batchSize = Math.min(maxBatchFrames, numFrames - i);
    const batchMags = magnitudes.slice(i, i + batchSize);

    // Flatten batch into [batchSize, bins]
    const inputData = new Float32Array(batchSize * bins);
    for (let j = 0; j < batchSize; j++) {
      inputData.set(batchMags[j], j * bins);
    }

    // Create input tensor
    const inputTensor = new ortRuntime.Tensor('float32', inputData, [batchSize, bins]);

    // Run inference
    const feeds = { [entry.io.input]: inputTensor };
    const outputs = await session.run(feeds);
    const maskTensor = outputs[entry.io.output];

    // Validate output shape
    if (!maskTensor || !maskTensor.data || maskTensor.data.length !== batchSize * bins) {
      throw new Error(
        `[MLWorker] malformed output tensor: expected ${batchSize * bins} elements, got ${maskTensor?.data?.length || 0}`
      );
    }

    // Extract masks
    const maskData = maskTensor.data;
    for (let j = 0; j < batchSize; j++) {
      const mask = new Float32Array(bins);
      for (let k = 0; k < bins; k++) {
        mask[k] = maskData[j * bins + k];
      }
      maskedMagnitudes.push(mask);
    }

    processedFrames += batchSize;
    onProgress(processedFrames / numFrames);
  }

  // Apply masks to magnitudes
  const processedMagnitudes = magnitudes.map((mag, i) => {
    const mask = maskedMagnitudes[i];
    const masked = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      masked[k] = mag[k] * mask[k];
    }
    return masked;
  });

  // Perform inverse STFT
  const output = istft(processedMagnitudes, phases, fftSize, hopSize, audio.length);
  onProgress(1);
  return output;
}

// ─────────────────────────────────────────────────────────────────────────────
// STFT / iSTFT Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create Hann window.
 * @param {number} size
 * @returns {Float32Array}
 */
function createHannWindow(size) {
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return window;
}

/**
 * Perform STFT on audio data.
 * @param {Float32Array} audio
 * @param {number} fftSize
 * @param {number} hopSize
 * @returns {{ magnitudes: Float32Array[], phases: Float32Array[], numFrames: number }}
 */
function stft(audio, fftSize, hopSize) {
  const window = createHannWindow(fftSize);
  const numFrames = Math.floor((audio.length - fftSize) / hopSize) + 1;
  const bins = Math.floor(fftSize / 2) + 1;

  const magnitudes = [];
  const phases = [];

  // Reusable buffers
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);

  for (let i = 0; i < numFrames; i++) {
    const offset = i * hopSize;

    // Extract and window frame
    for (let j = 0; j < fftSize; j++) {
      real[j] = (offset + j < audio.length ? audio[offset + j] : 0) * window[j];
      imag[j] = 0;
    }

    // Compute FFT using in-place FFT
    fftInPlace(real, imag, false);

    // Compute magnitude and phase (only first half + DC/Nyquist)
    const mag = new Float32Array(bins);
    const phase = new Float32Array(bins);

    for (let k = 0; k < bins; k++) {
      mag[k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
      phase[k] = Math.atan2(imag[k], real[k]);
    }

    magnitudes.push(mag);
    phases.push(phase);
  }

  return { magnitudes, phases, numFrames };
}

/**
 * Perform inverse STFT with overlap-add.
 * @param {Float32Array[]} magnitudes
 * @param {Float32Array[]} phases
 * @param {number} fftSize
 * @param {number} hopSize
 * @param {number} outputLength
 * @returns {Float32Array}
 */
function istft(magnitudes, phases, fftSize, hopSize, outputLength) {
  const window = createHannWindow(fftSize);
  const output = new Float32Array(outputLength);
  const windowSum = new Float32Array(outputLength);

  const numFrames = magnitudes.length;
  const real = new Float32Array(fftSize);
  const imag = new Float32Array(fftSize);

  for (let i = 0; i < numFrames; i++) {
    const mag = magnitudes[i];
    const phase = phases[i];
    const offset = i * hopSize;
    const bins = mag.length;

    // Reconstruct complex spectrum from magnitude and phase
    for (let k = 0; k < bins; k++) {
      real[k] = mag[k] * Math.cos(phase[k]);
      imag[k] = mag[k] * Math.sin(phase[k]);
    }

    // Mirror for negative frequencies (Hermitian symmetry for real signals)
    for (let k = bins; k < fftSize; k++) {
      const mirrorK = fftSize - k;
      real[k] = real[mirrorK];
      imag[k] = -imag[mirrorK];
    }

    // Inverse FFT
    fftInPlace(real, imag, true);

    // Overlap-add with window
    for (let j = 0; j < fftSize; j++) {
      const idx = offset + j;
      if (idx < outputLength) {
        output[idx] += real[j] * window[j];
        windowSum[idx] += window[j] * window[j];
      }
    }
  }

  // Normalize by window sum
  for (let i = 0; i < outputLength; i++) {
    if (windowSum[i] > 1e-8) {
      output[i] /= windowSum[i];
    }
  }

  return output;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio Processing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process audio using spectral-mask strategy.
 * @param {Float32Array} audioData
 * @param {number} sampleRate
 * @param {string} modelId
 * @param {object} options
 * @returns {Promise<{ audioData: Float32Array, metadata: object }>}
 */
async function processAudio(audioData, sampleRate, modelId, options = {}) {
  const startTime = performance.now();

  // Initialize ORT if needed
  if (!ort) {
    initializeORT();
  }

  // Load model
  const session = await loadModel(modelId);
  const modelInfo = modelManifest[modelId];

  // Get processing parameters
  const fftSize = modelInfo.fftSize || DEFAULT_FFT_SIZE;
  const hopSize = modelInfo.hopSize || DEFAULT_HOP_SIZE;
  const bins = modelInfo.bins || DEFAULT_BINS;
  const strength = options.strength !== undefined ? options.strength : 1.0;

  console.log(`[MLWorker] Processing ${audioData.length} samples with model '${modelId}'`);

  // Perform STFT
  const { magnitudes, phases, numFrames } = stft(audioData, fftSize, hopSize);

  // Process in batches
  const maxBatchFrames = modelInfo.maxBatchFrames || MAX_BATCH_FRAMES;
  const maskedMagnitudes = [];

  for (let i = 0; i < numFrames; i += maxBatchFrames) {
    const batchSize = Math.min(maxBatchFrames, numFrames - i);
    const batchMags = magnitudes.slice(i, i + batchSize);

    // Flatten batch into [batchSize, bins]
    const inputData = new Float32Array(batchSize * bins);
    for (let j = 0; j < batchSize; j++) {
      inputData.set(batchMags[j], j * bins);
    }

    // Create input tensor
    const inputTensor = new ort.Tensor('float32', inputData, [batchSize, bins]);

    // Run inference
    const feeds = { [modelInfo.io.input]: inputTensor };
    const outputs = await session.run(feeds);
    const maskTensor = outputs[modelInfo.io.output];

    // Extract masks
    const maskData = maskTensor.data;
    for (let j = 0; j < batchSize; j++) {
      const mask = new Float32Array(bins);
      for (let k = 0; k < bins; k++) {
        // Apply strength parameter
        const maskValue = maskData[j * bins + k];
        mask[k] = strength * maskValue + (1 - strength);
      }
      maskedMagnitudes.push(mask);
    }
  }

  // Apply masks to magnitudes
  const processedMagnitudes = magnitudes.map((mag, i) => {
    const mask = maskedMagnitudes[i];
    const masked = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      masked[k] = mag[k] * mask[k];
    }
    return masked;
  });

  // Perform inverse STFT
  const processedAudio = istft(processedMagnitudes, phases, fftSize, hopSize, audioData.length);

  const processingTime = performance.now() - startTime;

  console.log(`[MLWorker] Processing complete in ${processingTime.toFixed(2)}ms`);

  return {
    audioData: processedAudio,
    metadata: {
      processingTime,
      modelUsed: modelId,
      numFrames,
      sampleRate
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle 'init' message.
 * @param {object} data
 */
function handleInit(data) {
  if (!data.models || typeof data.models !== 'object') {
    throw new Error("'init' message requires 'models' object");
  }

  modelManifest = data.models;
  console.log(`[MLWorker] Initialized with ${Object.keys(modelManifest).length} models:`, Object.keys(modelManifest));

  self.postMessage({
    type: 'initialized',
    models: Object.keys(modelManifest)
  });
}

/**
 * Handle 'process' message.
 * @param {object} data
 */
async function handleProcess(data) {
  const { audioData, sampleRate, modelId, options } = data;

  if (!audioData || !(audioData instanceof Float32Array)) {
    throw new Error("'process' message requires 'audioData' as Float32Array");
  }

  if (!modelId || typeof modelId !== 'string') {
    throw new Error("'process' message requires 'modelId' as string");
  }

  const result = await processAudio(audioData, sampleRate || DEFAULT_SAMPLE_RATE, modelId, options || {});

  self.postMessage({
    type: 'result',
    audioData: result.audioData,
    metadata: result.metadata
  }, [result.audioData.buffer]); // Transfer ownership
}

/**
 * Handle 'unload' message.
 * @param {object} data
 */
function handleUnload(data) {
  const { modelId } = data;

  if (!modelId) {
    throw new Error("'unload' message requires 'modelId'");
  }

  if (sessions.has(modelId)) {
    sessions.delete(modelId);
    console.log(`[MLWorker] Unloaded model '${modelId}'`);
  }

  self.postMessage({
    type: 'unloaded',
    modelId
  });
}

/**
 * Handle 'shutdown' message.
 */
function handleShutdown() {
  console.log('[MLWorker] Shutting down');
  sessions.clear();
  loading.clear();
  self.postMessage({ type: 'shutdown' });
  self.close();
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Message Handler
// ─────────────────────────────────────────────────────────────────────────────

self.onmessage = async (event) => {
  const { type } = event.data;

  try {
    switch (type) {
      case 'init':
        handleInit(event.data);
        break;

      case 'process':
        await handleProcess(event.data);
        break;

      case 'unload':
        handleUnload(event.data);
        break;

      case 'shutdown':
        handleShutdown();
        break;

      default:
        throw new Error(`Unknown message type: '${type}'`);
    }
  } catch (error) {
    console.error(`[MLWorker] Error handling '${type}' message:`, error);
    self.postMessage({
      type: 'error',
      error: error.message,
      details: error.stack,
      messageType: type
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Worker Ready
// ─────────────────────────────────────────────────────────────────────────────

console.log('[MLWorker] Worker ready');

// Made with Bob
