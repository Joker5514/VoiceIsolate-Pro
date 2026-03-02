/**
 * VoiceIsolate Pro v9.0 - Hum Removal Node
 * Cascaded IIR notch filters at mains frequency harmonics (50Hz or 60Hz).
 * Auto-detects mains frequency via spectral peak analysis.
 */

import FFTNode from './fft.js';

export default class HumRemovalNode {
  /**
   * @param {number} sampleRate - Audio sample rate in Hz
   * @param {number} blockSize - Processing block size in samples
   */
  constructor(sampleRate, blockSize) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.bypass = false;

    this._params = {
      mainsFrequency: 'auto', // 'auto', 50, or 60
      harmonics: 4,           // Number of harmonics to remove
      qFactor: 30,            // Q factor of notch filters
    };

    // Detection state
    this._detectedFrequency = null;
    this._detectionSamples = Math.floor(sampleRate * 0.5); // 500ms for detection
    this._detectionCapacity = this._detectionSamples;
    this._detectionBuffer = new Float32Array(this._detectionCapacity);
    this._detectionLength = 0;
    this._detectionComplete = false;

    // FFT for frequency detection
    this._fft = new FFTNode(sampleRate, blockSize);
    this._fft.setParam('fftSize', 8192); // High resolution for 50/60Hz detection

    // Notch filter state arrays (per-harmonic biquad states)
    this._filters = [];
    this._filtersBuilt = false;
  }

  /**
   * Design a second-order IIR notch filter (biquad).
   * Transfer function: H(z) = (1 - 2cos(w0)z^-1 + z^-2) / (1 - 2r*cos(w0)z^-1 + r^2*z^-2)
   * @param {number} frequency - Center frequency in Hz
   * @param {number} Q - Quality factor
   * @returns {Object} Filter coefficients {b0, b1, b2, a1, a2}
   */
  _designNotch(frequency, Q) {
    const w0 = (2 * Math.PI * frequency) / this.sampleRate;
    const bandwidth = w0 / Q;
    const r = 1 - bandwidth / 2; // Pole radius

    // Numerator (zeros on unit circle at w0)
    const b0 = 1;
    const b1 = -2 * Math.cos(w0);
    const b2 = 1;

    // Denominator (poles inside unit circle at w0)
    const a0 = 1;
    const a1 = -2 * r * Math.cos(w0);
    const a2 = r * r;

    // Normalize so gain at DC = 1
    const dcGain = (b0 + b1 + b2) / (a0 + a1 + a2);
    const norm = 1 / dcGain;

    return {
      b0: b0 * norm,
      b1: b1 * norm,
      b2: b2 * norm,
      a1: a1,
      a2: a2,
      // Filter state
      x1: 0, x2: 0,
      y1: 0, y2: 0,
    };
  }

  /**
   * Build cascade of notch filters for all harmonics.
   * @param {number} fundamentalFreq - Mains fundamental frequency (50 or 60)
   */
  _buildFilterCascade(fundamentalFreq) {
    this._filters = [];

    for (let h = 1; h <= this._params.harmonics; h++) {
      const freq = fundamentalFreq * h;

      // Skip harmonics above Nyquist
      if (freq >= this.sampleRate / 2) break;

      // Use slightly higher Q for higher harmonics (narrower notch)
      const Q = this._params.qFactor * (1 + (h - 1) * 0.1);
      this._filters.push(this._designNotch(freq, Q));
    }

    this._filtersBuilt = true;
  }

  /**
   * Apply a single biquad filter to a sample (Direct Form I).
   * @param {Object} filter - Filter coefficients and state
   * @param {number} sample - Input sample
   * @returns {number} Filtered sample
   */
  _processBiquad(filter, sample) {
    const output =
      filter.b0 * sample +
      filter.b1 * filter.x1 +
      filter.b2 * filter.x2 -
      filter.a1 * filter.y1 -
      filter.a2 * filter.y2;

    // Update state
    filter.x2 = filter.x1;
    filter.x1 = sample;
    filter.y2 = filter.y1;
    filter.y1 = output;

    return output;
  }

  /**
   * Detect mains frequency (50Hz or 60Hz) from spectral analysis.
   * @param {Float32Array} signal - Audio signal for analysis
   * @returns {number} Detected frequency (50 or 60)
   */
  _detectMainsFrequency(signal) {
    // Use large FFT for frequency resolution
    const fftSize = 8192;
    const binWidth = this.sampleRate / fftSize;

    // Compute spectrum
    const frame = new Float32Array(fftSize);
    const copyLen = Math.min(signal.length, fftSize);
    frame.set(signal.subarray(0, copyLen));

    const spectrum = this._fft.forward(frame);

    // Check energy around 50Hz and 60Hz (and their harmonics)
    const check50 = this._measureHarmonicEnergy(spectrum.magnitude, 50, binWidth);
    const check60 = this._measureHarmonicEnergy(spectrum.magnitude, 60, binWidth);

    // Choose the frequency with more harmonic energy
    return check50 > check60 ? 50 : 60;
  }

  /**
   * Measure combined harmonic energy at a fundamental and its harmonics.
   * @param {Float32Array} magnitude - FFT magnitude spectrum
   * @param {number} fundamental - Fundamental frequency
   * @param {number} binWidth - FFT bin width in Hz
   * @returns {number} Combined harmonic energy
   */
  _measureHarmonicEnergy(magnitude, fundamental, binWidth) {
    let totalEnergy = 0;
    const searchRadius = 2; // Bins to search around expected peak

    for (let h = 1; h <= this._params.harmonics; h++) {
      const expectedBin = Math.round((fundamental * h) / binWidth);
      let maxMag = 0;

      for (
        let b = Math.max(0, expectedBin - searchRadius);
        b <= Math.min(magnitude.length - 1, expectedBin + searchRadius);
        b++
      ) {
        if (magnitude[b] > maxMag) {
          maxMag = magnitude[b];
        }
      }

      totalEnergy += maxMag * maxMag;
    }

    return totalEnergy;
  }

  /**
   * Process an audio block through the notch filter cascade.
   * @param {Float32Array} input - Input audio block
   * @returns {Float32Array} Audio with hum removed
   */
  process(input) {
    if (this.bypass) {
      return new Float32Array(input);
    }

    // Auto-detection phase
    if (this._params.mainsFrequency === 'auto' && !this._detectionComplete) {
      // Accumulate audio for detection using amortized growth
      const required = this._detectionLength + input.length;
      if (this._detectionCapacity < required) {
        const newCap = Math.max(required, this._detectionCapacity * 2);
        const newBuf = new Float32Array(newCap);
        newBuf.set(this._detectionBuffer.subarray(0, this._detectionLength));
        this._detectionBuffer = newBuf;
        this._detectionCapacity = newCap;
      }
      this._detectionBuffer.set(input, this._detectionLength);
      this._detectionLength += input.length;

      if (this._detectionLength >= this._detectionSamples) {
        this._detectedFrequency = this._detectMainsFrequency(
          this._detectionBuffer.subarray(0, this._detectionLength)
        );
        this._buildFilterCascade(this._detectedFrequency);
        this._detectionComplete = true;
        this._detectionBuffer = null; // Free memory
        this._detectionLength = 0;
        this._detectionCapacity = 0;
      }
    } else if (!this._filtersBuilt) {
      // Fixed frequency mode
      const freq =
        typeof this._params.mainsFrequency === 'number'
          ? this._params.mainsFrequency
          : 50;
      this._buildFilterCascade(freq);
    }

    // If filters aren't ready yet, pass through
    if (!this._filtersBuilt) {
      return new Float32Array(input);
    }

    // Apply cascaded notch filters
    const output = new Float32Array(input.length);

    for (let i = 0; i < input.length; i++) {
      let sample = input[i];

      // Process through each notch filter in cascade
      for (let f = 0; f < this._filters.length; f++) {
        sample = this._processBiquad(this._filters[f], sample);
      }

      // Denormal protection
      if (Math.abs(sample) < 1e-15) sample = 0;

      output[i] = sample;
    }

    return output;
  }

  /**
   * Get the detected or configured mains frequency.
   * @returns {number|null} Mains frequency (50 or 60) or null if not yet detected
   */
  getDetectedFrequency() {
    if (typeof this._params.mainsFrequency === 'number') {
      return this._params.mainsFrequency;
    }
    return this._detectedFrequency;
  }

  /**
   * Set a named parameter.
   * @param {string} name - Parameter name
   * @param {*} value - Parameter value
   */
  setParam(name, value) {
    if (name in this._params) {
      this._params[name] = value;

      if (name === 'mainsFrequency' && typeof value === 'number') {
        this._buildFilterCascade(value);
        this._detectionComplete = true;
      } else if (name === 'mainsFrequency' && value === 'auto') {
        // Reset detection
        this._detectionComplete = false;
        this._filtersBuilt = false;
        this._detectionCapacity = this._detectionSamples;
        this._detectionBuffer = new Float32Array(this._detectionCapacity);
        this._detectionLength = 0;
      } else if (name === 'harmonics' || name === 'qFactor') {
        // Rebuild filters with new params
        const freq = this._detectedFrequency ||
          (typeof this._params.mainsFrequency === 'number'
            ? this._params.mainsFrequency
            : null);
        if (freq) {
          this._buildFilterCascade(freq);
        }
      }
    }
  }

  /**
   * Reset internal state.
   */
  reset() {
    // Reset filter states
    for (const filter of this._filters) {
      filter.x1 = 0;
      filter.x2 = 0;
      filter.y1 = 0;
      filter.y2 = 0;
    }

    this._detectionCapacity = this._detectionSamples;
    this._detectionBuffer = new Float32Array(this._detectionCapacity);
    this._detectionLength = 0;

    if (this._params.mainsFrequency === 'auto') {
      this._detectionComplete = false;
      this._filtersBuilt = false;
      this._detectedFrequency = null;
      this._filters = [];
    }
  }
}
