/**
 * VoiceIsolate Pro v9.0 - Voiceprint Node
 * Speaker embedding extraction (192-dim). Computes cosine similarity vs
 * enrolled voiceprint. Generates per-frame speaker confidence mask.
 * Falls back to MFCC-based fingerprint when ECAPA-TDNN model unavailable.
 */

import FFTNode from './fft.js';

export default class VoiceprintNode {
  /**
   * @param {number} sampleRate - Audio sample rate in Hz
   * @param {number} blockSize - Processing block size in samples
   */
  constructor(sampleRate, blockSize) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.bypass = false;

    this._params = {
      similarityThreshold: 0.7,
      windowSize: 1.5,           // Analysis window in seconds
      embeddingDim: 192,
      numMFCC: 20,               // Number of MFCC coefficients
      numMelBands: 40,           // Mel filterbank bands
    };

    // ONNX model session (null = fallback to MFCC)
    this._modelSession = null;

    // Enrolled voiceprint embedding
    this._enrolledEmbedding = null;

    // FFT for spectral analysis
    this._fftSize = 1024;
    this._fft = new FFTNode(sampleRate, blockSize);
    this._fft.setParam('fftSize', this._fftSize);

    // Mel filterbank
    this._melFilterbank = this._buildMelFilterbank();

    // DCT matrix for MFCC
    this._dctMatrix = this._buildDCTMatrix();

    // State
    this._lastConfidence = 0;
    this._windowSamples = Math.floor(sampleRate * this._params.windowSize);
    this._embeddingCapacity = this._windowSamples * 2;
    this._embeddingBuffer = new Float32Array(this._embeddingCapacity);
    this._embeddingLength = 0;
  }

  /**
   * Convert Hz to Mel scale.
   * @param {number} hz - Frequency in Hz
   * @returns {number} Mel value
   */
  _hzToMel(hz) {
    return 2595 * Math.log10(1 + hz / 700);
  }

  /**
   * Convert Mel scale to Hz.
   * @param {number} mel - Mel value
   * @returns {number} Frequency in Hz
   */
  _melToHz(mel) {
    return 700 * (Math.pow(10, mel / 2595) - 1);
  }

  /**
   * Build triangular Mel-scale filterbank.
   * @returns {Array<Float32Array>} Array of filter coefficient arrays
   */
  _buildMelFilterbank() {
    const numBands = this._params.numMelBands;
    const halfN = this._fftSize / 2 + 1;
    const nyquist = this.sampleRate / 2;
    const lowMel = this._hzToMel(80);
    const highMel = this._hzToMel(Math.min(nyquist, 8000));

    // Mel center frequencies
    const melPoints = new Float32Array(numBands + 2);
    for (let i = 0; i < numBands + 2; i++) {
      melPoints[i] = lowMel + (i * (highMel - lowMel)) / (numBands + 1);
    }

    // Convert to Hz and then to FFT bin indices
    const hzPoints = melPoints.map((m) => this._melToHz(m));
    const binPoints = hzPoints.map((f) =>
      Math.floor(((this._fftSize + 1) * f) / this.sampleRate)
    );

    // Build triangular filters
    const filterbank = [];
    for (let m = 0; m < numBands; m++) {
      const filter = new Float32Array(halfN);
      const start = binPoints[m];
      const center = binPoints[m + 1];
      const end = binPoints[m + 2];

      // Rising slope
      for (let k = start; k < center && k < halfN; k++) {
        if (center !== start) {
          filter[k] = (k - start) / (center - start);
        }
      }

      // Falling slope
      for (let k = center; k <= end && k < halfN; k++) {
        if (end !== center) {
          filter[k] = (end - k) / (end - center);
        }
      }

      filterbank.push(filter);
    }

    return filterbank;
  }

  /**
   * Build DCT-II matrix for MFCC computation.
   * @returns {Array<Float32Array>}
   */
  _buildDCTMatrix() {
    const numCoeffs = this._params.numMFCC;
    const numBands = this._params.numMelBands;
    const matrix = [];

    for (let i = 0; i < numCoeffs; i++) {
      const row = new Float32Array(numBands);
      for (let j = 0; j < numBands; j++) {
        row[j] = Math.cos((Math.PI * i * (2 * j + 1)) / (2 * numBands));
      }
      matrix.push(row);
    }

    return matrix;
  }

  /**
   * Compute MFCC features for a single frame.
   * @param {Float32Array} frame - Audio frame (fftSize samples)
   * @returns {Float32Array} MFCC coefficients
   */
  _computeMFCC(frame) {
    // FFT
    const spectrum = this._fft.forward(frame);

    // Power spectrum
    const halfN = this._fftSize / 2 + 1;
    const power = new Float32Array(halfN);
    for (let i = 0; i < halfN; i++) {
      power[i] = spectrum.magnitude[i] * spectrum.magnitude[i];
    }

    // Apply Mel filterbank
    const melEnergies = new Float32Array(this._params.numMelBands);
    for (let m = 0; m < this._params.numMelBands; m++) {
      let sum = 0;
      for (let k = 0; k < halfN; k++) {
        sum += power[k] * this._melFilterbank[m][k];
      }
      melEnergies[m] = Math.log(Math.max(sum, 1e-10));
    }

    // Apply DCT to get MFCCs
    const mfcc = new Float32Array(this._params.numMFCC);
    for (let i = 0; i < this._params.numMFCC; i++) {
      let sum = 0;
      for (let j = 0; j < this._params.numMelBands; j++) {
        sum += this._dctMatrix[i][j] * melEnergies[j];
      }
      mfcc[i] = sum;
    }

    return mfcc;
  }

  /**
   * Compute a 192-dim embedding from MFCC features (fallback method).
   * Uses statistics (mean, variance, delta, delta-delta) of MFCC over time.
   * @param {Float32Array} signal - Audio signal (windowSize samples)
   * @returns {Float32Array} 192-dimensional embedding
   */
  _computeEmbeddingFallback(signal) {
    const hopSize = this._fftSize / 2;
    const numFrames = Math.floor((signal.length - this._fftSize) / hopSize) + 1;
    const numMFCC = this._params.numMFCC;
    const dim = this._params.embeddingDim;

    if (numFrames < 3) {
      return new Float32Array(dim);
    }

    // Compute MFCCs for all frames
    const mfccs = [];
    for (let i = 0; i < numFrames; i++) {
      const offset = i * hopSize;
      const frame = signal.subarray(offset, offset + this._fftSize);
      mfccs.push(this._computeMFCC(frame));
    }

    // Compute deltas
    const deltas = [];
    for (let i = 0; i < numFrames; i++) {
      const delta = new Float32Array(numMFCC);
      const prev = i > 0 ? mfccs[i - 1] : mfccs[0];
      const next = i < numFrames - 1 ? mfccs[i + 1] : mfccs[numFrames - 1];
      for (let j = 0; j < numMFCC; j++) {
        delta[j] = (next[j] - prev[j]) / 2;
      }
      deltas.push(delta);
    }

    // Compute delta-deltas
    const deltaDeltas = [];
    for (let i = 0; i < numFrames; i++) {
      const dd = new Float32Array(numMFCC);
      const prev = i > 0 ? deltas[i - 1] : deltas[0];
      const next = i < numFrames - 1 ? deltas[i + 1] : deltas[numFrames - 1];
      for (let j = 0; j < numMFCC; j++) {
        dd[j] = (next[j] - prev[j]) / 2;
      }
      deltaDeltas.push(dd);
    }

    // Build embedding: [mean_mfcc, var_mfcc, mean_delta, var_delta, mean_dd, var_dd, ...]
    // 20 MFCCs * 6 stats = 120 features + extra stats to fill 192 dims
    const embedding = new Float32Array(dim);
    let idx = 0;

    // Mean MFCC (20)
    for (let j = 0; j < numMFCC && idx < dim; j++) {
      let sum = 0;
      for (let i = 0; i < numFrames; i++) sum += mfccs[i][j];
      embedding[idx++] = sum / numFrames;
    }

    // Variance MFCC (20)
    for (let j = 0; j < numMFCC && idx < dim; j++) {
      let mean = 0;
      for (let i = 0; i < numFrames; i++) mean += mfccs[i][j];
      mean /= numFrames;
      let variance = 0;
      for (let i = 0; i < numFrames; i++) {
        const diff = mfccs[i][j] - mean;
        variance += diff * diff;
      }
      embedding[idx++] = variance / numFrames;
    }

    // Mean delta (20)
    for (let j = 0; j < numMFCC && idx < dim; j++) {
      let sum = 0;
      for (let i = 0; i < numFrames; i++) sum += deltas[i][j];
      embedding[idx++] = sum / numFrames;
    }

    // Variance delta (20)
    for (let j = 0; j < numMFCC && idx < dim; j++) {
      let mean = 0;
      for (let i = 0; i < numFrames; i++) mean += deltas[i][j];
      mean /= numFrames;
      let variance = 0;
      for (let i = 0; i < numFrames; i++) {
        const diff = deltas[i][j] - mean;
        variance += diff * diff;
      }
      embedding[idx++] = variance / numFrames;
    }

    // Mean delta-delta (20)
    for (let j = 0; j < numMFCC && idx < dim; j++) {
      let sum = 0;
      for (let i = 0; i < numFrames; i++) sum += deltaDeltas[i][j];
      embedding[idx++] = sum / numFrames;
    }

    // Variance delta-delta (20)
    for (let j = 0; j < numMFCC && idx < dim; j++) {
      let mean = 0;
      for (let i = 0; i < numFrames; i++) mean += deltaDeltas[i][j];
      mean /= numFrames;
      let variance = 0;
      for (let i = 0; i < numFrames; i++) {
        const diff = deltaDeltas[i][j] - mean;
        variance += diff * diff;
      }
      embedding[idx++] = variance / numFrames;
    }

    // Skewness of MFCC (20)
    for (let j = 0; j < numMFCC && idx < dim; j++) {
      let mean = 0;
      for (let i = 0; i < numFrames; i++) mean += mfccs[i][j];
      mean /= numFrames;
      let m3 = 0;
      let m2 = 0;
      for (let i = 0; i < numFrames; i++) {
        const diff = mfccs[i][j] - mean;
        m2 += diff * diff;
        m3 += diff * diff * diff;
      }
      m2 /= numFrames;
      m3 /= numFrames;
      const std = Math.sqrt(m2);
      embedding[idx++] = std > 1e-10 ? m3 / (std * std * std) : 0;
    }

    // Kurtosis of MFCC (20)
    for (let j = 0; j < numMFCC && idx < dim; j++) {
      let mean = 0;
      for (let i = 0; i < numFrames; i++) mean += mfccs[i][j];
      mean /= numFrames;
      let m4 = 0;
      let m2 = 0;
      for (let i = 0; i < numFrames; i++) {
        const diff = mfccs[i][j] - mean;
        m2 += diff * diff;
        m4 += diff * diff * diff * diff;
      }
      m2 /= numFrames;
      m4 /= numFrames;
      embedding[idx++] = m2 > 1e-10 ? m4 / (m2 * m2) - 3 : 0;
    }

    // Min/Max of first 6 MFCCs (12)
    for (let j = 0; j < Math.min(6, numMFCC) && idx < dim; j++) {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < numFrames; i++) {
        if (mfccs[i][j] < min) min = mfccs[i][j];
        if (mfccs[i][j] > max) max = mfccs[i][j];
      }
      embedding[idx++] = min;
      if (idx < dim) embedding[idx++] = max;
    }

    // L2-normalize the embedding
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      norm += embedding[i] * embedding[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 1e-10) {
      for (let i = 0; i < dim; i++) {
        embedding[i] /= norm;
      }
    }

    return embedding;
  }

  /**
   * Compute cosine similarity between two embeddings.
   * @param {Float32Array} a - Embedding A
   * @param {Float32Array} b - Embedding B
   * @returns {number} Cosine similarity [-1, 1]
   */
  _cosineSimilarity(a, b) {
    if (a.length !== b.length) return 0;

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA < 1e-10 || normB < 1e-10) return 0;
    return dot / (normA * normB);
  }

  /**
   * Enroll a speaker voiceprint.
   * @param {Float32Array} embedding - 192-dim speaker embedding
   */
  enrollVoiceprint(embedding) {
    this._enrolledEmbedding = new Float32Array(embedding);
  }

  /**
   * Enroll from raw audio (computes embedding internally).
   * @param {Float32Array} audio - Audio segment of the target speaker
   */
  enrollFromAudio(audio) {
    const embedding = this._computeEmbeddingFallback(audio);
    this.enrollVoiceprint(embedding);
  }

  /**
   * Match a frame/segment against the enrolled speaker.
   * @param {Float32Array} frame - Audio frame or segment
   * @returns {number} Speaker similarity score [0, 1]
   */
  matchSpeaker(frame) {
    if (!this._enrolledEmbedding) return 1.0; // No enrollment = pass all

    // Need enough audio for meaningful comparison
    if (frame.length < this._fftSize * 3) return this._lastConfidence;

    const embedding = this._computeEmbeddingFallback(frame);
    const similarity = this._cosineSimilarity(embedding, this._enrolledEmbedding);

    // Map similarity to [0, 1] confidence
    // similarity > threshold => high confidence speaker match
    const threshold = this._params.similarityThreshold;
    const confidence = Math.max(0, Math.min(1, (similarity - threshold + 0.3) / 0.6));

    return confidence;
  }

  /**
   * Set ONNX inference session for ECAPA-TDNN model.
   * @param {Object} session - ONNX runtime inference session
   */
  setModel(session) {
    this._modelSession = session;
  }

  /**
   * Process audio block: apply speaker confidence mask.
   * @param {Float32Array} input - Input audio block
   * @returns {Float32Array} Audio weighted by speaker confidence
   */
  process(input) {
    if (this.bypass) {
      return new Float32Array(input);
    }

    // Accumulate audio for windowed analysis using amortized growth
    const required = this._embeddingLength + input.length;
    if (this._embeddingCapacity < required) {
      const newCap = Math.max(required, this._embeddingCapacity * 2);
      const newBuffer = new Float32Array(newCap);
      newBuffer.set(this._embeddingBuffer.subarray(0, this._embeddingLength));
      this._embeddingBuffer = newBuffer;
      this._embeddingCapacity = newCap;
    }
    this._embeddingBuffer.set(input, this._embeddingLength);
    this._embeddingLength += input.length;

    // When we have enough audio, compute speaker match
    if (this._embeddingLength >= this._windowSamples) {
      const segment = this._embeddingBuffer.subarray(
        this._embeddingLength - this._windowSamples, this._embeddingLength
      );
      this._lastConfidence = this.matchSpeaker(segment);

      // Trim buffer to keep only recent window
      if (this._embeddingLength > this._windowSamples * 2) {
        const keep = this._windowSamples;
        this._embeddingBuffer.copyWithin(0, this._embeddingLength - keep, this._embeddingLength);
        this._embeddingLength = keep;
      }
    }

    // Apply confidence as gain mask
    const output = new Float32Array(input.length);
    const gain = this._enrolledEmbedding ? this._lastConfidence : 1.0;

    for (let i = 0; i < input.length; i++) {
      output[i] = input[i] * gain;
    }

    return output;
  }

  /**
   * Get the current speaker confidence.
   * @returns {number} Confidence [0, 1]
   */
  getConfidence() {
    return this._lastConfidence;
  }

  /**
   * Get the currently enrolled embedding.
   * @returns {Float32Array|null} 192-dim embedding or null
   */
  getEnrolledEmbedding() {
    return this._enrolledEmbedding ? new Float32Array(this._enrolledEmbedding) : null;
  }

  /**
   * Set a named parameter.
   * @param {string} name - Parameter name
   * @param {*} value - Parameter value
   */
  setParam(name, value) {
    if (name in this._params) {
      this._params[name] = value;

      if (name === 'windowSize') {
        this._windowSamples = Math.floor(this.sampleRate * value);
      }
    }
  }

  /**
   * Reset internal state.
   */
  reset() {
    this._lastConfidence = 0;
    this._embeddingLength = 0;
    // Note: enrolled embedding is intentionally preserved across resets
  }
}
