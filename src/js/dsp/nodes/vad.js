/**
 * VoiceIsolate Pro v9.0 - Voice Activity Detection Node
 * Energy-based + zero-crossing rate VAD.
 * Outputs per-frame probability [0,1].
 */

export default class VADNode {
  /**
   * @param {number} sampleRate - Audio sample rate in Hz
   * @param {number} blockSize - Processing block size in samples
   */
  constructor(sampleRate, blockSize) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.bypass = false;

    this._params = {
      energyThreshold: 0.001,       // Minimum energy for speech (linear)
      smoothingFactor: 0.85,         // Temporal smoothing for VAD probability
      minSpeechDuration: 0.08,       // Minimum speech segment duration (seconds)
      minSilenceDuration: 0.15,      // Minimum silence segment duration (seconds)
      zcrWeight: 0.3,                // Weight for zero-crossing rate feature
      energyWeight: 0.7,             // Weight for energy feature
    };

    // State
    this._smoothedProbability = 0;
    this._currentState = false; // true = speech, false = silence
    this._stateDurationSamples = 0;
    this._frameIndex = 0;

    // Adaptive thresholds
    this._noiseEnergy = 0;
    this._speechEnergy = 0;
    this._noiseZCR = 0;
    this._speechZCR = 0;
    this._calibrationFrames = 0;
    this._isCalibrated = false;
    this._calibrationPeriod = Math.ceil(sampleRate * 0.3 / blockSize); // ~300ms

    // Hangover mechanism to prevent choppy detection
    this._hangoverFrames = 0;
    this._maxHangover = Math.ceil(sampleRate * 0.1 / blockSize); // ~100ms

    // Per-frame results storage
    this._lastProbability = 0;
    this._lastDecision = false;
  }

  /**
   * Compute short-term energy of a frame.
   * @param {Float32Array} frame - Audio frame
   * @returns {number} Frame energy
   */
  _computeEnergy(frame) {
    let energy = 0;
    for (let i = 0; i < frame.length; i++) {
      energy += frame[i] * frame[i];
    }
    return energy / frame.length;
  }

  /**
   * Compute zero-crossing rate of a frame.
   * @param {Float32Array} frame - Audio frame
   * @returns {number} Zero-crossing rate (0-1)
   */
  _computeZCR(frame) {
    if (frame.length < 2) return 0;

    let crossings = 0;
    for (let i = 1; i < frame.length; i++) {
      if ((frame[i] >= 0 && frame[i - 1] < 0) || (frame[i] < 0 && frame[i - 1] >= 0)) {
        crossings++;
      }
    }

    return crossings / (frame.length - 1);
  }

  /**
   * Compute spectral centroid (center of mass of the spectrum).
   * Higher centroid often indicates speech/fricatives vs low-frequency noise.
   * @param {Float32Array} frame - Audio frame
   * @returns {number} Normalized spectral centroid (0-1)
   */
  _computeSpectralCentroid(frame) {
    // Simple approximation using autocorrelation-based frequency estimation
    let weightedSum = 0;
    let magnitudeSum = 0;

    // Use a simple DFT for a few frequency bins (efficient for VAD)
    const numBins = 32;
    const nyquist = this.sampleRate / 2;

    for (let k = 0; k < numBins; k++) {
      const freq = (k / numBins) * nyquist;
      let real = 0;
      let imag = 0;
      const omega = (2 * Math.PI * k) / (numBins * 2);

      for (let n = 0; n < frame.length; n++) {
        real += frame[n] * Math.cos(omega * n);
        imag += frame[n] * Math.sin(omega * n);
      }

      const magnitude = Math.sqrt(real * real + imag * imag);
      weightedSum += freq * magnitude;
      magnitudeSum += magnitude;
    }

    if (magnitudeSum < 1e-10) return 0;
    return (weightedSum / magnitudeSum) / nyquist;
  }

  /**
   * Update adaptive noise/speech thresholds during calibration.
   * @param {number} energy - Frame energy
   * @param {number} zcr - Zero-crossing rate
   */
  _updateCalibration(energy, zcr) {
    if (!this._isCalibrated) {
      // During calibration, assume initial frames are noise
      const alpha = 0.9;
      this._noiseEnergy = this._noiseEnergy * alpha + energy * (1 - alpha);
      this._noiseZCR = this._noiseZCR * alpha + zcr * (1 - alpha);
      this._calibrationFrames++;

      if (this._calibrationFrames >= this._calibrationPeriod) {
        this._isCalibrated = true;
        // Set speech thresholds relative to noise
        this._speechEnergy = this._noiseEnergy * 10;
        this._speechZCR = this._noiseZCR;
      }
    }
  }

  /**
   * Determine if a frame contains voice activity.
   * @param {Float32Array} frame - Audio frame
   * @returns {boolean} True if voice detected
   */
  isVoice(frame) {
    const prob = this._computeProbability(frame);
    return prob > 0.5;
  }

  /**
   * Compute voice activity probability for a frame.
   * @param {Float32Array} frame - Audio frame
   * @returns {number} Probability [0, 1]
   */
  _computeProbability(frame) {
    const energy = this._computeEnergy(frame);
    const zcr = this._computeZCR(frame);

    this._updateCalibration(energy, zcr);

    // Energy-based probability
    let energyProb = 0;
    if (this._isCalibrated) {
      const energyRatio = energy / Math.max(this._noiseEnergy, 1e-10);
      energyProb = 1 - 1 / (1 + Math.exp(2 * (energyRatio - 5))); // Sigmoid
    } else {
      // Before calibration, use absolute threshold
      energyProb = energy > this._params.energyThreshold ? 1.0 : 0.0;
    }

    // ZCR-based probability
    // Voice typically has moderate ZCR (0.01-0.3 at typical block sizes)
    // Very high ZCR often indicates unvoiced sounds or noise
    let zcrProb = 0;
    if (zcr > 0.01 && zcr < 0.5) {
      zcrProb = 1.0;
    } else if (zcr >= 0.5) {
      // Gradually decrease probability for very high ZCR
      zcrProb = Math.max(0, 1 - (zcr - 0.5) * 4);
    }

    // Combined probability
    const rawProb =
      this._params.energyWeight * energyProb +
      this._params.zcrWeight * zcrProb;

    return Math.max(0, Math.min(1, rawProb));
  }

  /**
   * Apply temporal smoothing and minimum duration constraints.
   * @param {number} rawProbability - Raw frame probability
   * @returns {number} Smoothed probability
   */
  _applySmoothing(rawProbability) {
    const alpha = this._params.smoothingFactor;
    this._smoothedProbability =
      alpha * this._smoothedProbability + (1 - alpha) * rawProbability;

    // Apply minimum duration constraints
    const newState = this._smoothedProbability > 0.5;
    const minSpeechSamples = Math.floor(
      this._params.minSpeechDuration * this.sampleRate
    );
    const minSilenceSamples = Math.floor(
      this._params.minSilenceDuration * this.sampleRate
    );

    if (newState !== this._currentState) {
      this._stateDurationSamples += this.blockSize;

      // Check minimum duration before state change
      if (newState && this._stateDurationSamples < minSpeechSamples) {
        // Not enough samples to confirm speech onset
        return this._currentState ? this._smoothedProbability : this._smoothedProbability * 0.5;
      }
      if (!newState && this._stateDurationSamples < minSilenceSamples) {
        // Not enough samples to confirm silence
        // Apply hangover
        this._hangoverFrames = this._maxHangover;
        return this._smoothedProbability + 0.3; // Bias toward speech
      }

      this._currentState = newState;
      this._stateDurationSamples = 0;
    } else {
      this._stateDurationSamples += this.blockSize;
    }

    // Hangover: keep probability elevated briefly after speech
    if (this._hangoverFrames > 0) {
      this._hangoverFrames--;
      return Math.max(this._smoothedProbability, 0.6);
    }

    return this._smoothedProbability;
  }

  /**
   * Process an audio block: compute VAD probability and apply as gain mask.
   * Audio is passed through with gain based on VAD probability.
   * @param {Float32Array} input - Input audio block
   * @returns {Float32Array} Audio with VAD-based gating applied
   */
  process(input) {
    if (this.bypass) {
      return new Float32Array(input);
    }

    const rawProb = this._computeProbability(input);
    const smoothedProb = this._applySmoothing(rawProb);

    this._lastProbability = Math.max(0, Math.min(1, smoothedProb));
    this._lastDecision = this._lastProbability > 0.5;
    this._frameIndex++;

    // Apply soft gating based on VAD probability
    // Don't fully mute - use a minimum gain to avoid artifacts
    const minGain = 0.01;
    const gain = minGain + (1 - minGain) * this._lastProbability;

    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      output[i] = input[i] * gain;
    }

    return output;
  }

  /**
   * Get the last computed VAD probability.
   * @returns {number} Probability [0, 1]
   */
  getProbability() {
    return this._lastProbability;
  }

  /**
   * Get the last VAD decision.
   * @returns {boolean} True if speech detected
   */
  getDecision() {
    return this._lastDecision;
  }

  /**
   * Set a named parameter.
   * @param {string} name - Parameter name
   * @param {*} value - Parameter value
   */
  setParam(name, value) {
    if (name in this._params) {
      this._params[name] = value;
    }
  }

  /**
   * Reset internal state.
   */
  reset() {
    this._smoothedProbability = 0;
    this._currentState = false;
    this._stateDurationSamples = 0;
    this._frameIndex = 0;
    this._noiseEnergy = 0;
    this._speechEnergy = 0;
    this._noiseZCR = 0;
    this._speechZCR = 0;
    this._calibrationFrames = 0;
    this._isCalibrated = false;
    this._hangoverFrames = 0;
    this._lastProbability = 0;
    this._lastDecision = false;
  }
}
