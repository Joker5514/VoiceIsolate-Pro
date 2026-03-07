/**
 * VoiceIsolate Pro v9.0 - Decode Node
 * Accepts raw audio data, resamples if needed, normalizes channel count.
 * First stage in the DSP pipeline.
 */

export default class DecodeNode {
  /**
   * @param {number} sampleRate - Target audio sample rate in Hz
   * @param {number} blockSize - Processing block size in samples
   */
  constructor(sampleRate, blockSize) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.bypass = false;

    this._params = {
      targetSampleRate: sampleRate,
      targetChannels: 1, // Mono for voice isolation
    };

    // Resampling state for polyphase filtering
    this._resampleBuffer = new Float32Array(0);
    this._sourceSampleRate = null;
  }

  /**
   * Resample audio using linear interpolation (fast) or windowed-sinc (quality).
   * @param {Float32Array} input - Source samples
   * @param {number} srcRate - Source sample rate
   * @param {number} dstRate - Destination sample rate
   * @returns {Float32Array} Resampled audio
   */
  _resample(input, srcRate, dstRate) {
    if (srcRate === dstRate) {
      return new Float32Array(input);
    }

    const ratio = srcRate / dstRate;
    const outputLength = Math.ceil(input.length / ratio);
    const output = new Float32Array(outputLength);

    // Windowed sinc interpolation with Kaiser window (quality resampling)
    const filterHalfLen = 16; // Taps on each side
    const beta = 6.0; // Kaiser window parameter

    for (let i = 0; i < outputLength; i++) {
      const srcPos = i * ratio;
      const srcIndex = Math.floor(srcPos);
      const frac = srcPos - srcIndex;

      let sample = 0;
      let weightSum = 0;

      const start = Math.max(0, srcIndex - filterHalfLen + 1);
      const end = Math.min(input.length - 1, srcIndex + filterHalfLen);

      for (let j = start; j <= end; j++) {
        const x = j - srcPos;
        // Sinc function
        const sinc = x === 0 ? 1.0 : Math.sin(Math.PI * x) / (Math.PI * x);
        // Kaiser window
        const t = x / filterHalfLen;
        const kaiser = Math.abs(t) <= 1.0 ? this._kaiserWindow(t, beta) : 0;
        const weight = sinc * kaiser;

        sample += input[j] * weight;
        weightSum += weight;
      }

      output[i] = weightSum > 0 ? sample / weightSum : 0;
    }

    return output;
  }

  /**
   * Kaiser window function (zero-order modified Bessel approximation).
   * @param {number} t - Normalized position [-1, 1]
   * @param {number} beta - Shape parameter
   * @returns {number} Window value
   */
  _kaiserWindow(t, beta) {
    const x = beta * Math.sqrt(1 - t * t);
    return this._bessel0(x) / this._bessel0(beta);
  }

  /**
   * Zero-order modified Bessel function of the first kind (I0).
   * @param {number} x - Input value
   * @returns {number} I0(x)
   */
  _bessel0(x) {
    let sum = 1.0;
    let term = 1.0;
    const xHalf = x / 2;

    for (let k = 1; k <= 25; k++) {
      term *= (xHalf / k) * (xHalf / k);
      sum += term;
      if (term < sum * 1e-15) break;
    }

    return sum;
  }

  /**
   * Mix multi-channel audio down to target channel count.
   * @param {Float32Array} input - Interleaved multi-channel audio
   * @param {number} srcChannels - Number of source channels
   * @param {number} dstChannels - Number of destination channels
   * @returns {Float32Array} Channel-mixed audio
   */
  _mixChannels(input, srcChannels, dstChannels) {
    if (srcChannels === dstChannels) {
      return new Float32Array(input);
    }

    const numFrames = Math.floor(input.length / srcChannels);
    const output = new Float32Array(numFrames * dstChannels);

    if (dstChannels === 1) {
      // Mix down to mono
      for (let i = 0; i < numFrames; i++) {
        let sum = 0;
        for (let ch = 0; ch < srcChannels; ch++) {
          sum += input[i * srcChannels + ch];
        }
        output[i] = sum / srcChannels;
      }
    } else if (dstChannels === 2 && srcChannels === 1) {
      // Mono to stereo
      for (let i = 0; i < numFrames; i++) {
        output[i * 2] = input[i];
        output[i * 2 + 1] = input[i];
      }
    } else if (dstChannels === 2 && srcChannels > 2) {
      // Multi-channel to stereo (simple downmix)
      for (let i = 0; i < numFrames; i++) {
        let left = 0;
        let right = 0;
        for (let ch = 0; ch < srcChannels; ch++) {
          const sample = input[i * srcChannels + ch];
          // Distribute odd channels left, even channels right, center to both
          if (ch === 0) {
            left += sample;
          } else if (ch === 1) {
            right += sample;
          } else if (ch === 2) {
            // Center channel
            left += sample * 0.707;
            right += sample * 0.707;
          } else {
            // Surround channels distributed evenly
            left += sample * 0.5;
            right += sample * 0.5;
          }
        }
        output[i * 2] = left;
        output[i * 2 + 1] = right;
      }
    } else {
      // Generic downmix: average all channels into each output channel
      for (let i = 0; i < numFrames; i++) {
        let sum = 0;
        for (let ch = 0; ch < srcChannels; ch++) {
          sum += input[i * srcChannels + ch];
        }
        const avg = sum / srcChannels;
        for (let ch = 0; ch < dstChannels; ch++) {
          output[i * dstChannels + ch] = avg;
        }
      }
    }

    return output;
  }

  /**
   * Process audio data: resample and channel-mix as needed.
   * Expects mono Float32Array for simple pipeline usage.
   * @param {Float32Array} input - Input audio samples
   * @returns {Float32Array} Decoded/resampled mono audio
   */
  process(input) {
    if (this.bypass) {
      return new Float32Array(input);
    }

    let output = new Float32Array(input);

    // Resample if source rate differs from target
    if (
      this._sourceSampleRate !== null &&
      this._sourceSampleRate !== this._params.targetSampleRate
    ) {
      output = this._resample(output, this._sourceSampleRate, this._params.targetSampleRate);
    }

    return output;
  }

  /**
   * Decode raw multi-channel audio with known parameters.
   * @param {Float32Array} input - Interleaved audio data
   * @param {number} sourceSampleRate - Source sample rate
   * @param {number} sourceChannels - Source channel count
   * @returns {Float32Array} Decoded mono audio at target sample rate
   */
  decode(input, sourceSampleRate, sourceChannels) {
    this._sourceSampleRate = sourceSampleRate;

    // Step 1: Channel mixing
    let output = this._mixChannels(input, sourceChannels, this._params.targetChannels);

    // Step 2: Resampling
    if (sourceSampleRate !== this._params.targetSampleRate) {
      output = this._resample(output, sourceSampleRate, this._params.targetSampleRate);
    }

    // Step 3: Clip protection
    for (let i = 0; i < output.length; i++) {
      if (output[i] > 1.0) output[i] = 1.0;
      else if (output[i] < -1.0) output[i] = -1.0;
      // Handle NaN / Infinity
      else if (!isFinite(output[i])) output[i] = 0;
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
    }
    if (name === 'sourceSampleRate') {
      this._sourceSampleRate = value;
    }
  }

  /**
   * Reset internal state.
   */
  reset() {
    this._resampleBuffer = new Float32Array(0);
    this._sourceSampleRate = null;
  }
}
