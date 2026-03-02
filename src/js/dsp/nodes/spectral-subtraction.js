/**
 * VoiceIsolate Pro v9.0 - Spectral Subtraction Node
 * Multi-band Wiener filter operating in the frequency domain on STFT magnitudes.
 * gain[k] = max(floor, 1 - alpha * noise[k] / signal[k])
 */

import FFTNode from './fft.js';

export default class SpectralSubtractionNode {
  /**
   * @param {number} sampleRate - Audio sample rate in Hz
   * @param {number} blockSize - Processing block size in samples
   */
  constructor(sampleRate, blockSize) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.bypass = false;

    this._params = {
      oversubtraction: 4.0,   // Alpha: oversubtraction factor (2-6 typical)
      spectralFloor: -80,     // Minimum gain in dB (prevents musical noise)
      noiseProfile: null,     // External noise profile (Float32Array)
      beta: 0.002,            // Spectral floor linear
    };

    // FFT for STFT
    this._fftSize = 4096;
    this._hopSize = this._fftSize / 4;
    this._fft = new FFTNode(sampleRate, blockSize);
    this._fft.setParam('fftSize', this._fftSize);
    this._fft.setParam('hopSize', this._hopSize);

    // Convert spectral floor from dB to linear
    this._floorLinear = Math.pow(10, this._params.spectralFloor / 20);

    // Internal noise estimate (updated if no external profile)
    this._internalNoise = null;

    // Overlap-add buffers (pre-allocated with amortized growth)
    this._inputCapacity = this._fftSize * 4;
    this._inputBuffer = new Float32Array(this._inputCapacity);
    this._inputLength = 0;
    this._outputBuffer = new Float32Array(0);
    this._outputReadPos = 0;
    this._outputWritePos = 0;

    // Smoothing for gain to reduce musical noise
    this._prevGain = null;
    this._gainSmoothing = 0.5; // Temporal gain smoothing factor

    // Window
    this._window = new Float32Array(this._fftSize);
    for (let i = 0; i < this._fftSize; i++) {
      this._window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / this._fftSize));
    }
  }

  /**
   * Get the effective noise profile (external or internal).
   * @returns {Float32Array|null} Noise magnitude spectrum
   */
  _getNoiseProfile() {
    if (this._params.noiseProfile) {
      return this._params.noiseProfile;
    }
    return this._internalNoise;
  }

  /**
   * Compute Wiener filter gain for each frequency bin.
   * @param {Float32Array} signalMag - Signal magnitude spectrum
   * @param {Float32Array} noiseMag - Noise magnitude spectrum
   * @returns {Float32Array} Per-bin gain values [floor, 1]
   */
  _computeGain(signalMag, noiseMag) {
    const halfN = signalMag.length;
    const gain = new Float32Array(halfN);
    const alpha = this._params.oversubtraction;
    const floor = this._floorLinear;

    for (let k = 0; k < halfN; k++) {
      const noise = noiseMag[k] || 0;
      const signal = signalMag[k] || 1e-10;

      // Wiener-style spectral subtraction
      // gain = max(floor, 1 - alpha * (noise / signal))
      let g = 1.0 - alpha * (noise / signal);

      // Power subtraction variant for better quality
      // Also consider: gain = max(floor, (signal^2 - alpha * noise^2) / signal^2)
      const signalPow = signal * signal;
      const noisePow = noise * noise;
      const powerGain = Math.sqrt(Math.max(0, signalPow - alpha * noisePow) / Math.max(signalPow, 1e-20));

      // Blend amplitude and power subtraction
      g = 0.5 * g + 0.5 * powerGain;

      // Apply floor
      gain[k] = Math.max(floor, Math.min(1.0, g));
    }

    // Temporal smoothing with previous frame gain
    if (this._prevGain) {
      const smooth = this._gainSmoothing;
      for (let k = 0; k < halfN; k++) {
        gain[k] = smooth * this._prevGain[k] + (1 - smooth) * gain[k];
      }
    }

    // Spectral smoothing (3-bin moving average to reduce musical noise)
    const smoothed = new Float32Array(halfN);
    for (let k = 0; k < halfN; k++) {
      let sum = gain[k];
      let count = 1;
      if (k > 0) {
        sum += gain[k - 1];
        count++;
      }
      if (k < halfN - 1) {
        sum += gain[k + 1];
        count++;
      }
      smoothed[k] = sum / count;
    }

    this._prevGain = new Float32Array(smoothed);
    return smoothed;
  }

  /**
   * Process a single STFT frame.
   * @param {Float32Array} frame - Time-domain frame (fftSize samples)
   * @returns {Float32Array} Processed time-domain frame
   */
  _processFrame(frame) {
    const noiseProfile = this._getNoiseProfile();

    // Forward FFT
    const spectrum = this._fft.forward(frame);

    if (!noiseProfile) {
      // No noise profile available, estimate from this frame
      // (very rough - better to use NoiseProfileNode)
      if (!this._internalNoise) {
        this._internalNoise = new Float32Array(spectrum.magnitude);
      }
      // Return unmodified
      const { real, imag } = this._fft.fromMagnitudePhase(
        spectrum.magnitude,
        spectrum.phase
      );
      return this._fft.inverse(real, imag);
    }

    // Compute gain mask
    const gain = this._computeGain(spectrum.magnitude, noiseProfile);

    // Apply gain to magnitude, preserve phase
    const newMagnitude = new Float32Array(spectrum.magnitude.length);
    for (let k = 0; k < spectrum.magnitude.length; k++) {
      newMagnitude[k] = spectrum.magnitude[k] * gain[k];
    }

    // Reconstruct complex spectrum
    const { real, imag } = this._fft.fromMagnitudePhase(newMagnitude, spectrum.phase);

    // Inverse FFT
    return this._fft.inverse(real, imag);
  }

  /**
   * Process an audio block through spectral subtraction.
   * @param {Float32Array} input - Input audio block
   * @returns {Float32Array} Noise-reduced audio
   */
  process(input) {
    if (this.bypass) {
      return new Float32Array(input);
    }

    const N = this._fftSize;
    const hop = this._hopSize;

    // Append input to buffer using amortized growth
    const required = this._inputLength + input.length;
    if (this._inputCapacity < required) {
      const newCap = Math.max(required, this._inputCapacity * 2, N * 4);
      const newBuffer = new Float32Array(newCap);
      newBuffer.set(this._inputBuffer.subarray(0, this._inputLength));
      this._inputBuffer = newBuffer;
      this._inputCapacity = newCap;
    }
    this._inputBuffer.set(input, this._inputLength);
    this._inputLength += input.length;

    // Ensure output buffer is large enough
    const requiredOut = this._outputWritePos + input.length + N * 2;
    if (this._outputBuffer.length < requiredOut) {
      const newOut = new Float32Array(requiredOut);
      newOut.set(this._outputBuffer);
      this._outputBuffer = newOut;
    }

    // Process complete frames
    let inputOffset = 0;
    while (this._inputLength - inputOffset >= N) {
      const frame = new Float32Array(N);
      frame.set(this._inputBuffer.subarray(inputOffset, inputOffset + N));

      const processed = this._processFrame(frame);

      // Overlap-add
      for (let j = 0; j < N; j++) {
        this._outputBuffer[this._outputWritePos + j] += processed[j];
      }

      this._outputWritePos += hop;
      inputOffset += hop;
    }

    // Compact remaining samples to the front of the buffer
    if (inputOffset > 0) {
      const remaining = this._inputLength - inputOffset;
      if (remaining > 0) {
        this._inputBuffer.copyWithin(0, inputOffset, this._inputLength);
      }
      this._inputLength = remaining;
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

    // Compact buffers periodically
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
   * Process an entire audio buffer offline (non-streaming).
   * @param {Float32Array} input - Full audio buffer
   * @param {Float32Array} [noiseProfile] - Optional noise profile
   * @returns {Float32Array} Processed audio
   */
  processOffline(input, noiseProfile) {
    if (noiseProfile) {
      this._params.noiseProfile = noiseProfile;
    }

    const frames = this._fft.stft(input);
    const noise = this._getNoiseProfile();

    if (!noise) {
      return new Float32Array(input);
    }

    const processedFrames = frames.map((frame) => {
      const gain = this._computeGain(frame.magnitude, noise);
      const newMag = new Float32Array(frame.magnitude.length);
      for (let k = 0; k < frame.magnitude.length; k++) {
        newMag[k] = frame.magnitude[k] * gain[k];
      }
      const { real, imag } = this._fft.fromMagnitudePhase(newMag, frame.phase);
      return { real, imag };
    });

    return this._fft.istft(processedFrames, input.length);
  }

  /**
   * Set a named parameter.
   * @param {string} name - Parameter name
   * @param {*} value - Parameter value
   */
  setParam(name, value) {
    if (name in this._params) {
      this._params[name] = value;

      if (name === 'spectralFloor') {
        this._floorLinear = Math.pow(10, value / 20);
      }
    }
  }

  /**
   * Reset internal state.
   */
  reset() {
    this._inputLength = 0;
    this._outputBuffer = new Float32Array(0);
    this._outputReadPos = 0;
    this._outputWritePos = 0;
    this._prevGain = null;
    this._internalNoise = null;
  }
}
