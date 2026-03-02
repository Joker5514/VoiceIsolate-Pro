/**
 * VoiceIsolate Pro v9.0 - FFT Node
 * Forward/Inverse STFT with Cooley-Tukey radix-2 FFT implementation.
 * Supports configurable FFT size, window type, and overlap.
 */

export default class FFTNode {
  /**
   * @param {number} sampleRate - Audio sample rate in Hz
   * @param {number} blockSize - Processing block size in samples
   */
  constructor(sampleRate, blockSize) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    this.bypass = false;

    // Default params
    this._params = {
      fftSize: 4096,
      hopSize: 1024,       // 75% overlap by default (fftSize / 4)
      windowType: 'hann',
    };

    this._buildLookupTables();
    this._buildWindow();

    // Overlap-add buffers (pre-allocated with amortized growth)
    this._inputCapacity = this._params.fftSize * 4;
    this._inputBuffer = new Float32Array(this._inputCapacity);
    this._inputLength = 0;
    this._outputBuffer = new Float32Array(0);
    this._outputPosition = 0;

    // Pre-allocated work arrays
    this._realWork = new Float32Array(this._params.fftSize);
    this._imagWork = new Float32Array(this._params.fftSize);
  }

  /**
   * Build bit-reversal and twiddle factor lookup tables for current FFT size.
   */
  _buildLookupTables() {
    const N = this._params.fftSize;
    const logN = Math.log2(N);

    if (logN !== Math.floor(logN)) {
      throw new Error(`FFT size must be a power of 2, got ${N}`);
    }

    // Bit-reversal permutation table
    this._bitRev = new Uint32Array(N);
    for (let i = 0; i < N; i++) {
      let reversed = 0;
      let val = i;
      for (let j = 0; j < logN; j++) {
        reversed = (reversed << 1) | (val & 1);
        val >>= 1;
      }
      this._bitRev[i] = reversed;
    }

    // Pre-compute twiddle factors for all stages
    // For each stage s (halfSize = 1,2,4,...,N/2), store cos and sin tables
    this._twiddleReal = [];
    this._twiddleImag = [];

    for (let halfSize = 1; halfSize < N; halfSize *= 2) {
      const tableSize = halfSize;
      const realTable = new Float32Array(tableSize);
      const imagTable = new Float32Array(tableSize);
      const angleStep = -Math.PI / halfSize;

      for (let k = 0; k < tableSize; k++) {
        const angle = angleStep * k;
        realTable[k] = Math.cos(angle);
        imagTable[k] = Math.sin(angle);
      }

      this._twiddleReal.push(realTable);
      this._twiddleImag.push(imagTable);
    }
  }

  /**
   * Build the analysis/synthesis window function.
   */
  _buildWindow() {
    const N = this._params.fftSize;
    this._window = new Float32Array(N);
    this._synthesisWindow = new Float32Array(N);

    switch (this._params.windowType) {
      case 'hann':
        for (let i = 0; i < N; i++) {
          this._window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
        }
        break;
      case 'hamming':
        for (let i = 0; i < N; i++) {
          this._window[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / N);
        }
        break;
      case 'blackman':
        for (let i = 0; i < N; i++) {
          this._window[i] =
            0.42 -
            0.5 * Math.cos((2 * Math.PI * i) / N) +
            0.08 * Math.cos((4 * Math.PI * i) / N);
        }
        break;
      case 'rectangular':
        this._window.fill(1);
        break;
      default:
        // Default to Hann
        for (let i = 0; i < N; i++) {
          this._window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
        }
    }

    // Compute synthesis window for overlap-add reconstruction
    // Using the COLA (Constant Overlap-Add) normalization
    const hopSize = this._params.hopSize;
    const numOverlaps = Math.ceil(N / hopSize);
    const windowSum = new Float32Array(N);

    for (let offset = 0; offset < numOverlaps; offset++) {
      for (let i = 0; i < N; i++) {
        const pos = (i + offset * hopSize) % N;
        windowSum[i] += this._window[pos] * this._window[pos];
      }
    }

    for (let i = 0; i < N; i++) {
      this._synthesisWindow[i] =
        windowSum[i] > 1e-8 ? this._window[i] / windowSum[i] : this._window[i];
    }
  }

  /**
   * In-place Cooley-Tukey radix-2 decimation-in-time FFT.
   * @param {Float32Array} real - Real part (modified in place)
   * @param {Float32Array} imag - Imaginary part (modified in place)
   * @param {boolean} inverse - If true, compute inverse FFT
   */
  _fftInPlace(real, imag, inverse = false) {
    const N = real.length;

    // Bit-reversal permutation
    for (let i = 0; i < N; i++) {
      const j = this._bitRev[i];
      if (j > i) {
        // Swap real
        let tmp = real[i];
        real[i] = real[j];
        real[j] = tmp;
        // Swap imag
        tmp = imag[i];
        imag[i] = imag[j];
        imag[j] = tmp;
      }
    }

    // Butterfly computation
    let tableIdx = 0;
    for (let halfSize = 1; halfSize < N; halfSize *= 2) {
      const step = halfSize * 2;
      const twiddleR = this._twiddleReal[tableIdx];
      const twiddleI = this._twiddleImag[tableIdx];
      const sign = inverse ? -1 : 1;

      for (let i = 0; i < N; i += step) {
        for (let k = 0; k < halfSize; k++) {
          const evenIdx = i + k;
          const oddIdx = i + k + halfSize;

          const tr = twiddleR[k];
          const ti = sign * twiddleI[k];

          // Complex multiplication: twiddle * odd
          const tRe = tr * real[oddIdx] - ti * imag[oddIdx];
          const tIm = tr * imag[oddIdx] + ti * real[oddIdx];

          // Butterfly
          real[oddIdx] = real[evenIdx] - tRe;
          imag[oddIdx] = imag[evenIdx] - tIm;
          real[evenIdx] = real[evenIdx] + tRe;
          imag[evenIdx] = imag[evenIdx] + tIm;
        }
      }
      tableIdx++;
    }

    // Scale for inverse FFT
    if (inverse) {
      const invN = 1.0 / N;
      for (let i = 0; i < N; i++) {
        real[i] *= invN;
        imag[i] *= invN;
      }
    }
  }

  /**
   * Compute forward FFT of a real-valued signal frame.
   * @param {Float32Array} frame - Input time-domain frame (length = fftSize)
   * @returns {{ real: Float32Array, imag: Float32Array, magnitude: Float32Array, phase: Float32Array }}
   */
  forward(frame) {
    const N = this._params.fftSize;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);

    // Apply analysis window
    const len = Math.min(frame.length, N);
    for (let i = 0; i < len; i++) {
      real[i] = frame[i] * this._window[i];
    }
    // Zero-pad if frame is shorter than fftSize
    for (let i = len; i < N; i++) {
      real[i] = 0;
    }
    imag.fill(0);

    this._fftInPlace(real, imag, false);

    // Compute magnitude and phase for the positive frequencies
    const halfN = N / 2 + 1;
    const magnitude = new Float32Array(halfN);
    const phase = new Float32Array(halfN);

    for (let i = 0; i < halfN; i++) {
      magnitude[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
      phase[i] = Math.atan2(imag[i], real[i]);
    }

    return { real, imag, magnitude, phase };
  }

  /**
   * Compute inverse FFT to reconstruct time-domain signal.
   * @param {Float32Array} real - Full complex spectrum real part
   * @param {Float32Array} imag - Full complex spectrum imaginary part
   * @returns {Float32Array} Time-domain signal (length = fftSize)
   */
  inverse(real, imag) {
    const N = this._params.fftSize;
    const rCopy = new Float32Array(real);
    const iCopy = new Float32Array(imag);

    this._fftInPlace(rCopy, iCopy, true);

    // Apply synthesis window
    const output = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      output[i] = rCopy[i] * this._synthesisWindow[i];
    }

    return output;
  }

  /**
   * Reconstruct complex spectrum from magnitude and phase (positive freqs only).
   * @param {Float32Array} magnitude - Magnitude spectrum (N/2+1)
   * @param {Float32Array} phase - Phase spectrum (N/2+1)
   * @returns {{ real: Float32Array, imag: Float32Array }}
   */
  fromMagnitudePhase(magnitude, phase) {
    const N = this._params.fftSize;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    const halfN = N / 2 + 1;

    // Positive frequencies
    for (let i = 0; i < halfN; i++) {
      real[i] = magnitude[i] * Math.cos(phase[i]);
      imag[i] = magnitude[i] * Math.sin(phase[i]);
    }

    // Mirror for negative frequencies (conjugate symmetry for real signals)
    for (let i = 1; i < N / 2; i++) {
      real[N - i] = real[i];
      imag[N - i] = -imag[i];
    }

    return { real, imag };
  }

  /**
   * Perform full STFT analysis on a signal buffer.
   * @param {Float32Array} signal - Input time-domain signal
   * @returns {Array<{ real: Float32Array, imag: Float32Array, magnitude: Float32Array, phase: Float32Array }>}
   */
  stft(signal) {
    const N = this._params.fftSize;
    const hop = this._params.hopSize;
    const frames = [];
    const numFrames = Math.floor((signal.length - N) / hop) + 1;

    for (let i = 0; i < numFrames; i++) {
      const offset = i * hop;
      const frame = signal.subarray(offset, offset + N);
      frames.push(this.forward(frame));
    }

    return frames;
  }

  /**
   * Perform inverse STFT (overlap-add reconstruction).
   * @param {Array<{ real: Float32Array, imag: Float32Array }>} frames - STFT frames
   * @param {number} [outputLength] - Desired output length
   * @returns {Float32Array} Reconstructed time-domain signal
   */
  istft(frames, outputLength) {
    const N = this._params.fftSize;
    const hop = this._params.hopSize;
    const totalLength = outputLength || (frames.length - 1) * hop + N;
    const output = new Float32Array(totalLength);

    for (let i = 0; i < frames.length; i++) {
      const offset = i * hop;
      const frame = this.inverse(frames[i].real, frames[i].imag);

      for (let j = 0; j < N && offset + j < totalLength; j++) {
        output[offset + j] += frame[j];
      }
    }

    return output;
  }

  /**
   * Process a block of audio through STFT -> (passthrough) -> ISTFT.
   * In the pipeline, other nodes operate on the spectral data between forward/inverse.
   * @param {Float32Array} input - Input audio block
   * @returns {Float32Array} Processed audio block
   */
  process(input) {
    if (this.bypass) {
      return new Float32Array(input);
    }

    const N = this._params.fftSize;
    const hop = this._params.hopSize;

    // Append input to internal buffer using amortized growth
    const required = this._inputBuffer.length + input.length;
    if (this._inputCapacity < required) {
      const newCap = Math.max(required, this._inputCapacity * 2, N * 4);
      const newBuffer = new Float32Array(newCap);
      newBuffer.set(this._inputBuffer);
      this._inputBuffer = newBuffer;
      this._inputCapacity = newCap;
    }
    this._inputBuffer.set(input, this._inputLength);
    this._inputLength += input.length;

    // Expand output buffer if needed
    const requiredOut = this._outputPosition + input.length + N;
    if (this._outputBuffer.length < requiredOut) {
      const newOut = new Float32Array(requiredOut);
      newOut.set(this._outputBuffer);
      this._outputBuffer = newOut;
    }

    // Process complete frames
    let inputOffset = 0;
    while (this._inputLength - inputOffset >= N) {
      const frame = this._inputBuffer.subarray(inputOffset, inputOffset + N);
      const spectrum = this.forward(frame);
      const { real, imag } = this.fromMagnitudePhase(spectrum.magnitude, spectrum.phase);
      const reconstructed = this.inverse(real, imag);

      // Overlap-add
      for (let j = 0; j < N; j++) {
        if (this._outputPosition + j < this._outputBuffer.length) {
          this._outputBuffer[this._outputPosition + j] += reconstructed[j];
        }
      }
      this._outputPosition += hop;

      // Advance input buffer by hop size
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

    // Extract output samples corresponding to the input length
    const output = new Float32Array(input.length);
    const availableStart = this._outputPosition - input.length;
    if (availableStart >= 0) {
      for (let i = 0; i < input.length; i++) {
        output[i] = this._outputBuffer[availableStart + i] || 0;
      }
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

      if (name === 'fftSize') {
        this._buildLookupTables();
        this._buildWindow();
        this._realWork = new Float32Array(value);
        this._imagWork = new Float32Array(value);
      } else if (name === 'windowType') {
        this._buildWindow();
      } else if (name === 'hopSize') {
        this._buildWindow(); // Rebuild synthesis window for new hop
      }
    }
  }

  /**
   * Reset internal state.
   */
  reset() {
    this._inputLength = 0;
    this._outputBuffer = new Float32Array(0);
    this._outputPosition = 0;
  }
}
