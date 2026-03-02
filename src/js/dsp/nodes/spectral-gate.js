/**
 * VoiceIsolate Pro v9.0 - Spectral Gate Node
 * Per-band noise gate with adaptive threshold from noise profile.
 * Attack: 1ms, Release: 50ms, Lookahead: 5ms.
 * Smooth gain transitions to avoid artifacts.
 */

import FFTNode from './fft.js';

export default class SpectralGateNode {
  /**
   * @param {number} sampleRate - Audio sample rate in Hz
   * @param {number} blockSize - Processing block size in samples
   */
  constructor(sampleRate, blockSize) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.bypass = false;

    this._params = {
      threshold: -40,       // Gate threshold in dB (relative to noise floor)
      attack: 0.001,        // Attack time in seconds (1ms)
      release: 0.050,       // Release time in seconds (50ms)
      lookahead: 0.005,     // Lookahead time in seconds (5ms)
      range: -80,           // Gate range in dB (how much attenuation when closed)
      noiseProfile: null,   // External noise profile (Float32Array)
    };

    // FFT
    this._fftSize = 4096;
    this._hopSize = this._fftSize / 4;
    this._fft = new FFTNode(sampleRate, blockSize);
    this._fft.setParam('fftSize', this._fftSize);
    this._fft.setParam('hopSize', this._hopSize);

    // Number of frequency bins
    this._halfN = this._fftSize / 2 + 1;

    // Per-band gate envelope followers
    this._gateGain = new Float32Array(this._halfN);
    this._gateGain.fill(1.0);

    // Smoothing coefficients (computed from attack/release times)
    this._attackCoeff = this._computeCoeff(this._params.attack);
    this._releaseCoeff = this._computeCoeff(this._params.release);

    // Lookahead buffer (circular buffer of STFT frames)
    this._lookaheadFrames = Math.ceil(
      (this._params.lookahead * sampleRate) / this._hopSize
    );
    this._frameQueue = [];

    // Overlap-add state
    this._inputBuffer = new Float32Array(0);
    this._outputBuffer = new Float32Array(0);
    this._outputReadPos = 0;
    this._outputWritePos = 0;

    // Range in linear
    this._rangeLinear = Math.pow(10, this._params.range / 20);
  }

  /**
   * Compute envelope follower coefficient from time constant.
   * @param {number} timeSeconds - Time constant in seconds
   * @returns {number} Smoothing coefficient
   */
  _computeCoeff(timeSeconds) {
    if (timeSeconds <= 0) return 0;
    // Each STFT hop is hopSize/sampleRate seconds
    const hopDuration = this._hopSize / this.sampleRate;
    return Math.exp(-hopDuration / timeSeconds);
  }

  /**
   * Compute adaptive per-bin threshold from noise profile.
   * @param {Float32Array} noiseProfile - Noise magnitude spectrum
   * @returns {Float32Array} Per-bin threshold magnitudes
   */
  _computeThresholds(noiseProfile) {
    const thresholds = new Float32Array(this._halfN);
    const thresholdLinear = Math.pow(10, this._params.threshold / 20);

    for (let k = 0; k < this._halfN; k++) {
      // Threshold is noise floor scaled by threshold parameter
      const noise = noiseProfile ? noiseProfile[k] || 0 : 0;
      thresholds[k] = noise * (1 + thresholdLinear);
    }

    return thresholds;
  }

  /**
   * Update gate gain envelope for each frequency bin.
   * @param {Float32Array} magnitude - Current frame magnitude
   * @param {Float32Array} thresholds - Per-bin gate thresholds
   */
  _updateGateEnvelope(magnitude, thresholds) {
    for (let k = 0; k < this._halfN; k++) {
      // Determine target gain (open or closed)
      let targetGain;
      if (magnitude[k] > thresholds[k]) {
        targetGain = 1.0; // Gate open
      } else {
        // Soft knee: gradual transition near threshold
        const ratio = magnitude[k] / Math.max(thresholds[k], 1e-10);
        if (ratio > 0.5) {
          // Knee region: smooth transition
          targetGain = (ratio - 0.5) * 2;
        } else {
          targetGain = this._rangeLinear; // Gate closed
        }
      }

      // Envelope following with attack/release
      if (targetGain > this._gateGain[k]) {
        // Opening (attack)
        this._gateGain[k] =
          this._attackCoeff * this._gateGain[k] +
          (1 - this._attackCoeff) * targetGain;
      } else {
        // Closing (release)
        this._gateGain[k] =
          this._releaseCoeff * this._gateGain[k] +
          (1 - this._releaseCoeff) * targetGain;
      }

      // Clamp
      this._gateGain[k] = Math.max(this._rangeLinear, Math.min(1.0, this._gateGain[k]));
    }
  }

  /**
   * Process a single STFT frame through the spectral gate.
   * @param {{ magnitude: Float32Array, phase: Float32Array }} frame - STFT frame
   * @returns {{ real: Float32Array, imag: Float32Array }} Gated complex spectrum
   */
  _processFrame(frame) {
    const noiseProfile = this._params.noiseProfile;
    const thresholds = this._computeThresholds(noiseProfile);

    // Update gate envelope
    this._updateGateEnvelope(frame.magnitude, thresholds);

    // Apply gate gain to magnitude
    const newMag = new Float32Array(frame.magnitude.length);
    for (let k = 0; k < frame.magnitude.length; k++) {
      newMag[k] = frame.magnitude[k] * this._gateGain[k];
    }

    // Reconstruct complex spectrum
    return this._fft.fromMagnitudePhase(newMag, frame.phase);
  }

  /**
   * Process an audio block through the spectral gate.
   * @param {Float32Array} input - Input audio block
   * @returns {Float32Array} Gated audio
   */
  process(input) {
    if (this.bypass) {
      return new Float32Array(input);
    }

    const N = this._fftSize;
    const hop = this._hopSize;

    // Append to input buffer
    const newInput = new Float32Array(this._inputBuffer.length + input.length);
    newInput.set(this._inputBuffer);
    newInput.set(input, this._inputBuffer.length);
    this._inputBuffer = newInput;

    // Ensure output buffer size
    const requiredOut = this._outputWritePos + input.length + N * 2;
    if (this._outputBuffer.length < requiredOut) {
      const newOut = new Float32Array(requiredOut);
      newOut.set(this._outputBuffer);
      this._outputBuffer = newOut;
    }

    // Process complete frames
    let inputOffset = 0;
    while (this._inputBuffer.length - inputOffset >= N) {
      const frame = this._inputBuffer.subarray(inputOffset, inputOffset + N);
      const spectrum = this._fft.forward(frame);

      // Lookahead: queue frames and process delayed
      this._frameQueue.push(spectrum);

      if (this._frameQueue.length > this._lookaheadFrames) {
        // Look ahead at current frame to prepare gate
        this._updateGateEnvelope(
          spectrum.magnitude,
          this._computeThresholds(this._params.noiseProfile)
        );

        // Process the delayed frame
        const delayedFrame = this._frameQueue.shift();
        const { real, imag } = this._processFrame(delayedFrame);
        const reconstructed = this._fft.inverse(real, imag);

        // Overlap-add
        for (let j = 0; j < N; j++) {
          this._outputBuffer[this._outputWritePos + j] += reconstructed[j];
        }
        this._outputWritePos += hop;
      }

      inputOffset += hop;
    }

    // Keep remaining samples for the next block
    if (inputOffset > 0) {
      this._inputBuffer = this._inputBuffer.slice(inputOffset);
    }

    // Extract output
    const output = new Float32Array(input.length);
    const available = this._outputWritePos - this._outputReadPos;

    if (available >= input.length) {
      for (let i = 0; i < input.length; i++) {
        output[i] = this._outputBuffer[this._outputReadPos + i];
      }
      this._outputReadPos += input.length;
    } else if (available > 0) {
      for (let i = 0; i < available; i++) {
        output[i] = this._outputBuffer[this._outputReadPos + i];
      }
      this._outputReadPos += available;
    }

    // Compact
    if (this._outputReadPos > N * 4) {
      const remaining = this._outputWritePos - this._outputReadPos;
      const newBuf = new Float32Array(remaining + N * 4);
      newBuf.set(this._outputBuffer.subarray(this._outputReadPos, this._outputWritePos));
      this._outputBuffer = newBuf;
      this._outputWritePos = remaining;
      this._outputReadPos = 0;
    }

    return output;
  }

  /**
   * Set a named parameter.
   * @param {string} name - Parameter name
   * @param {*} value - Parameter value
   */
  setParam(name, value) {
    if (name in this._params) {
      this._params[name] = value;

      if (name === 'attack') {
        this._attackCoeff = this._computeCoeff(value);
      } else if (name === 'release') {
        this._releaseCoeff = this._computeCoeff(value);
      } else if (name === 'lookahead') {
        this._lookaheadFrames = Math.ceil(
          (value * this.sampleRate) / this._hopSize
        );
      } else if (name === 'range') {
        this._rangeLinear = Math.pow(10, value / 20);
      }
    }
  }

  /**
   * Reset internal state.
   */
  reset() {
    this._gateGain.fill(1.0);
    this._frameQueue = [];
    this._inputBuffer = new Float32Array(0);
    this._outputBuffer = new Float32Array(0);
    this._outputReadPos = 0;
    this._outputWritePos = 0;
  }
}
