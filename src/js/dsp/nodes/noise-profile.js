/**
 * VoiceIsolate Pro v9.0 - Noise Profile Node
 * Computes average spectral magnitude as noise floor estimate during
 * the first 500ms or detected silence. Uses 32 Bark-scale bands.
 * Updates via Exponential Moving Average (EMA).
 */

import FFTNode from './fft.js';

export default class NoiseProfileNode {
  /**
   * @param {number} sampleRate - Audio sample rate in Hz
   * @param {number} blockSize - Processing block size in samples
   */
  constructor(sampleRate, blockSize) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.bypass = false;

    this._params = {
      adaptationRate: 0.98,    // EMA alpha (higher = slower adaptation)
      profileDuration: 0.5,    // Seconds of audio to use for initial profiling
    };

    // FFT for spectral analysis
    this._fftSize = 4096;
    this._fft = new FFTNode(sampleRate, blockSize);
    this._fft.setParam('fftSize', this._fftSize);

    // Bark-scale band definitions (32 bands)
    this._numBands = 32;
    this._bandEdges = this._computeBarkBands();
    this._bandMap = this._buildBandMap();

    // Noise profile (32 bands)
    this._noiseProfile = new Float32Array(this._numBands);
    this._noiseProfileLinear = new Float32Array(this._fftSize / 2 + 1);
    this._profileFrameCount = 0;
    this._isProfileReady = false;

    // Accumulation buffers for initial profiling
    this._accumulator = new Float32Array(this._numBands);

    // Silence detection
    this._silenceThreshold = 0.005; // RMS threshold for silence detection
    this._samplesProcessed = 0;
    this._profileSamples = Math.floor(sampleRate * this._params.profileDuration);

    // Internal buffer for frame accumulation
    this._inputBuffer = new Float32Array(0);
  }

  /**
   * Compute 32 Bark-scale band edge frequencies.
   * Bark scale: z = 13 * arctan(0.00076f) + 3.5 * arctan((f/7500)^2)
   * @returns {Array<{low: number, high: number, center: number}>}
   */
  _computeBarkBands() {
    const nyquist = this.sampleRate / 2;
    const bands = [];

    // Standard Bark band edges (approximation using critical bands)
    const barkEdges = [
      20, 100, 200, 300, 400, 510, 630, 770, 920, 1080,
      1270, 1480, 1720, 2000, 2320, 2700, 3150, 3700, 4400,
      5300, 6400, 7700, 9500, 12000, 15500, 20500
    ];

    // Create 32 bands, distributing across the available Bark edges
    const totalBands = this._numBands;
    const maxFreq = Math.min(nyquist, 20000);

    for (let i = 0; i < totalBands; i++) {
      const lowBark = (i / totalBands) * 24.0; // 24 Bark total
      const highBark = ((i + 1) / totalBands) * 24.0;

      const lowFreq = this._barkToHz(lowBark);
      const highFreq = Math.min(this._barkToHz(highBark), maxFreq);
      const centerFreq = (lowFreq + highFreq) / 2;

      bands.push({
        low: lowFreq,
        high: highFreq,
        center: centerFreq,
      });
    }

    return bands;
  }

  /**
   * Convert Bark scale to Hz.
   * @param {number} bark - Bark value
   * @returns {number} Frequency in Hz
   */
  _barkToHz(bark) {
    return 1960 * (bark + 0.53) / (26.28 - bark);
  }

  /**
   * Convert Hz to Bark scale.
   * @param {number} hz - Frequency in Hz
   * @returns {number} Bark value
   */
  _hzToBark(hz) {
    return (26.81 * hz) / (1960 + hz) - 0.53;
  }

  /**
   * Build mapping from FFT bins to Bark bands.
   * @returns {Uint8Array} Band index for each FFT bin
   */
  _buildBandMap() {
    const halfN = this._fftSize / 2 + 1;
    const bandMap = new Uint8Array(halfN);
    const binWidth = this.sampleRate / this._fftSize;

    for (let bin = 0; bin < halfN; bin++) {
      const freq = bin * binWidth;
      let bestBand = 0;

      for (let b = 0; b < this._numBands; b++) {
        if (freq >= this._bandEdges[b].low && freq < this._bandEdges[b].high) {
          bestBand = b;
          break;
        }
        if (freq >= this._bandEdges[b].high) {
          bestBand = b;
        }
      }

      bandMap[bin] = bestBand;
    }

    return bandMap;
  }

  /**
   * Compute per-band average magnitude from an FFT magnitude spectrum.
   * @param {Float32Array} magnitude - FFT magnitude spectrum (N/2+1)
   * @returns {Float32Array} Band magnitudes (32 bands)
   */
  _computeBandMagnitudes(magnitude) {
    const bandMag = new Float32Array(this._numBands);
    const bandCount = new Uint32Array(this._numBands);

    for (let bin = 0; bin < magnitude.length; bin++) {
      const band = this._bandMap[bin];
      bandMag[band] += magnitude[bin];
      bandCount[band]++;
    }

    for (let b = 0; b < this._numBands; b++) {
      if (bandCount[b] > 0) {
        bandMag[b] /= bandCount[b];
      }
    }

    return bandMag;
  }

  /**
   * Detect if a frame is silence based on RMS energy.
   * @param {Float32Array} frame - Audio frame
   * @returns {boolean} True if frame is silence
   */
  _isSilence(frame) {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
      sum += frame[i] * frame[i];
    }
    const rms = Math.sqrt(sum / frame.length);
    return rms < this._silenceThreshold;
  }

  /**
   * Update noise profile with a new spectral frame using EMA.
   * @param {Float32Array} bandMagnitudes - Current frame band magnitudes
   */
  _updateProfile(bandMagnitudes) {
    const alpha = this._params.adaptationRate;

    if (this._profileFrameCount === 0) {
      // First frame: initialize directly
      this._noiseProfile.set(bandMagnitudes);
    } else {
      // EMA update
      for (let b = 0; b < this._numBands; b++) {
        this._noiseProfile[b] = alpha * this._noiseProfile[b] + (1 - alpha) * bandMagnitudes[b];
      }
    }

    this._profileFrameCount++;

    // Also update per-bin linear noise profile for spectral subtraction use
    this._updateLinearProfile();
  }

  /**
   * Interpolate band-level noise profile to per-bin linear profile.
   */
  _updateLinearProfile() {
    const halfN = this._fftSize / 2 + 1;

    for (let bin = 0; bin < halfN; bin++) {
      const band = this._bandMap[bin];
      this._noiseProfileLinear[bin] = this._noiseProfile[band];
    }
  }

  /**
   * Process an audio block: analyze for noise profile during initial period
   * or during silence. Passes audio through unmodified.
   * @param {Float32Array} input - Input audio block
   * @returns {Float32Array} Unmodified audio (noise profiling is side-effect)
   */
  process(input) {
    if (this.bypass) {
      return new Float32Array(input);
    }

    // Accumulate input
    const newBuffer = new Float32Array(this._inputBuffer.length + input.length);
    newBuffer.set(this._inputBuffer);
    newBuffer.set(input, this._inputBuffer.length);
    this._inputBuffer = newBuffer;

    // Process complete FFT frames
    let inputOffset = 0;
    while (this._inputBuffer.length - inputOffset >= this._fftSize) {
      const frame = this._inputBuffer.subarray(inputOffset, inputOffset + this._fftSize);
      const isInProfileWindow = this._samplesProcessed < this._profileSamples;
      const isSilent = this._isSilence(frame);

      if (isInProfileWindow || (isSilent && this._isProfileReady)) {
        // Compute spectrum
        const spectrum = this._fft.forward(frame);
        const bandMag = this._computeBandMagnitudes(spectrum.magnitude);
        this._updateProfile(bandMag);

        if (isInProfileWindow && this._samplesProcessed + this._fftSize >= this._profileSamples) {
          this._isProfileReady = true;
        }
      }

      this._samplesProcessed += this._fftSize;
      inputOffset += this._fftSize;
    }

    // Keep remaining samples for the next block
    if (inputOffset > 0) {
      this._inputBuffer = this._inputBuffer.slice(inputOffset);
    }

    // Pass audio through unmodified
    return new Float32Array(input);
  }

  /**
   * Get the current noise profile (32 Bark bands).
   * @returns {{ bands: Float32Array, linear: Float32Array, isReady: boolean, frameCount: number }}
   */
  getNoiseProfile() {
    return {
      bands: new Float32Array(this._noiseProfile),
      linear: new Float32Array(this._noiseProfileLinear),
      isReady: this._isProfileReady,
      frameCount: this._profileFrameCount,
    };
  }

  /**
   * Manually set a noise profile (e.g., from a saved configuration).
   * @param {Float32Array} profile - 32-band noise profile
   */
  setNoiseProfile(profile) {
    if (profile.length === this._numBands) {
      this._noiseProfile.set(profile);
      this._isProfileReady = true;
      this._updateLinearProfile();
    }
  }

  /**
   * Force profile analysis on a specific audio segment (e.g., noise-only segment).
   * @param {Float32Array} noiseSegment - Audio segment containing only noise
   */
  analyzeSegment(noiseSegment) {
    const hop = this._fftSize / 4;
    let offset = 0;

    // Reset profile
    this._noiseProfile.fill(0);
    this._profileFrameCount = 0;

    while (offset + this._fftSize <= noiseSegment.length) {
      const frame = noiseSegment.subarray(offset, offset + this._fftSize);
      const spectrum = this._fft.forward(frame);
      const bandMag = this._computeBandMagnitudes(spectrum.magnitude);
      this._updateProfile(bandMag);
      offset += hop;
    }

    this._isProfileReady = true;
  }

  /**
   * Set a named parameter.
   * @param {string} name - Parameter name
   * @param {*} value - Parameter value
   */
  setParam(name, value) {
    if (name in this._params) {
      this._params[name] = value;

      if (name === 'profileDuration') {
        this._profileSamples = Math.floor(this.sampleRate * value);
      }
    }
  }

  /**
   * Reset internal state.
   */
  reset() {
    this._noiseProfile.fill(0);
    this._noiseProfileLinear.fill(0);
    this._profileFrameCount = 0;
    this._isProfileReady = false;
    this._accumulator.fill(0);
    this._samplesProcessed = 0;
    this._inputBuffer = new Float32Array(0);
  }
}
