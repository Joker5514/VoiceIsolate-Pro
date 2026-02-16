/**
 * VoiceIsolate Pro v9.0 - Normalize Node
 * Measures peak amplitude and applies gain to reach target headroom.
 * Stores original gain for potential restoration.
 */

export default class NormalizeNode {
  /**
   * @param {number} sampleRate - Audio sample rate in Hz
   * @param {number} blockSize - Processing block size in samples
   */
  constructor(sampleRate, blockSize) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.bypass = false;

    this._params = {
      targetHeadroom: -3, // dBFS
    };

    // State
    this._originalGain = 1.0;
    this._appliedGain = 1.0;
    this._peakAmplitude = 0;
    this._isCalibrated = false;

    // Running peak tracker for streaming
    this._runningPeak = 0;
    this._samplesProcessed = 0;
    this._calibrationSamples = 0;
    this._calibrationThreshold = 0; // Will be set from sampleRate
  }

  /**
   * Measure the peak absolute amplitude in a buffer.
   * @param {Float32Array} input - Audio samples
   * @returns {number} Peak absolute amplitude
   */
  _measurePeak(input) {
    let peak = 0;
    for (let i = 0; i < input.length; i++) {
      const abs = Math.abs(input[i]);
      if (abs > peak) {
        peak = abs;
      }
    }
    return peak;
  }

  /**
   * Measure RMS amplitude.
   * @param {Float32Array} input - Audio samples
   * @returns {number} RMS amplitude
   */
  _measureRMS(input) {
    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      sum += input[i] * input[i];
    }
    return Math.sqrt(sum / input.length);
  }

  /**
   * Convert linear amplitude to dBFS.
   * @param {number} amplitude - Linear amplitude (0-1)
   * @returns {number} dBFS value
   */
  _toDBFS(amplitude) {
    if (amplitude <= 0) return -Infinity;
    return 20 * Math.log10(amplitude);
  }

  /**
   * Convert dBFS to linear amplitude.
   * @param {number} dbfs - dBFS value
   * @returns {number} Linear amplitude
   */
  _fromDBFS(dbfs) {
    return Math.pow(10, dbfs / 20);
  }

  /**
   * Calculate the gain needed to reach target headroom.
   * @param {number} peakAmplitude - Current peak amplitude
   * @returns {number} Gain factor to apply
   */
  _calculateGain(peakAmplitude) {
    if (peakAmplitude <= 1e-10) {
      return 1.0; // Signal is essentially silence
    }

    const targetLinear = this._fromDBFS(this._params.targetHeadroom);
    return targetLinear / peakAmplitude;
  }

  /**
   * Calibrate normalization based on full buffer analysis.
   * Call this with the entire audio file for best results.
   * @param {Float32Array} input - Full audio buffer
   */
  calibrate(input) {
    this._peakAmplitude = this._measurePeak(input);
    this._appliedGain = this._calculateGain(this._peakAmplitude);
    this._originalGain = 1.0 / this._appliedGain;
    this._isCalibrated = true;
  }

  /**
   * Process audio block: apply normalization gain.
   * If not calibrated, performs running peak measurement for the first
   * ~100ms then applies gain.
   * @param {Float32Array} input - Input audio block
   * @returns {Float32Array} Normalized audio block
   */
  process(input) {
    if (this.bypass) {
      return new Float32Array(input);
    }

    // Running peak measurement for real-time use (if not pre-calibrated)
    if (!this._isCalibrated) {
      const blockPeak = this._measurePeak(input);
      if (blockPeak > this._runningPeak) {
        this._runningPeak = blockPeak;
      }
      this._samplesProcessed += input.length;

      // After ~100ms of audio, set the gain
      const calibrationWindow = Math.floor(this.sampleRate * 0.1);
      if (this._samplesProcessed >= calibrationWindow && this._runningPeak > 1e-10) {
        this._peakAmplitude = this._runningPeak;
        this._appliedGain = this._calculateGain(this._peakAmplitude);
        this._originalGain = 1.0 / this._appliedGain;
        this._isCalibrated = true;
      }
    }

    // Apply gain with soft clipping protection
    const output = new Float32Array(input.length);
    const gain = this._isCalibrated ? this._appliedGain : 1.0;

    for (let i = 0; i < input.length; i++) {
      let sample = input[i] * gain;

      // Soft clip at +0.5dB above target to prevent hard clipping
      const ceiling = this._fromDBFS(this._params.targetHeadroom + 0.5);
      if (sample > ceiling) {
        sample = ceiling + (1 - ceiling) * Math.tanh((sample - ceiling) / (1 - ceiling));
      } else if (sample < -ceiling) {
        sample = -(ceiling + (1 - ceiling) * Math.tanh((-sample - ceiling) / (1 - ceiling)));
      }

      output[i] = sample;
    }

    return output;
  }

  /**
   * Get the original gain that was measured before normalization.
   * Useful for restoring original levels later.
   * @returns {number} Original gain factor
   */
  getOriginalGain() {
    return this._originalGain;
  }

  /**
   * Get the applied normalization gain.
   * @returns {number} Applied gain factor
   */
  getAppliedGain() {
    return this._appliedGain;
  }

  /**
   * Get the measured peak amplitude.
   * @returns {number} Peak amplitude (0-1)
   */
  getPeakAmplitude() {
    return this._peakAmplitude;
  }

  /**
   * Set a named parameter.
   * @param {string} name - Parameter name
   * @param {*} value - Parameter value
   */
  setParam(name, value) {
    if (name in this._params) {
      this._params[name] = value;

      // Recalculate gain if headroom target changes and we have a measurement
      if (name === 'targetHeadroom' && this._isCalibrated) {
        this._appliedGain = this._calculateGain(this._peakAmplitude);
        this._originalGain = 1.0 / this._appliedGain;
      }
    }
  }

  /**
   * Reset internal state.
   */
  reset() {
    this._originalGain = 1.0;
    this._appliedGain = 1.0;
    this._peakAmplitude = 0;
    this._isCalibrated = false;
    this._runningPeak = 0;
    this._samplesProcessed = 0;
  }
}
