/**
 * VoiceIsolate Pro v14.0 - FFT Engine
 * Cooley-Tukey radix-2 DIT FFT, 2048-point, Hann windowing, 75% overlap-add.
 */

import type { AudioConfig, SpectralFrame } from './types.js';

// ---------------------------------------------------------------------------
// Window functions
// ---------------------------------------------------------------------------

/** Pre-compute a Hann window of length N */
export function buildHannWindow(N: number): Float32Array {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  return w;
}

/** Pre-compute a Hamming window of length N */
export function buildHammingWindow(N: number): Float32Array {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (N - 1));
  }
  return w;
}

/** Pre-compute a Blackman window of length N */
export function buildBlackmanWindow(N: number): Float32Array {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] =
      0.42 -
      0.5 * Math.cos((2 * Math.PI * i) / (N - 1)) +
      0.08 * Math.cos((4 * Math.PI * i) / (N - 1));
  }
  return w;
}

// ---------------------------------------------------------------------------
// Bit-reversal permutation
// ---------------------------------------------------------------------------

function bitReverse(n: number, bits: number): number {
  let result = 0;
  for (let i = 0; i < bits; i++) {
    result = (result << 1) | (n & 1);
    n >>= 1;
  }
  return result;
}

function buildBitReverseTable(N: number): Uint16Array {
  const bits = Math.log2(N);
  const table = new Uint16Array(N);
  for (let i = 0; i < N; i++) table[i] = bitReverse(i, bits);
  return table;
}

// ---------------------------------------------------------------------------
// Twiddle factor cache
// ---------------------------------------------------------------------------

function buildTwiddleFactors(N: number): { cos: Float32Array; sin: Float32Array } {
  const cos = new Float32Array(N / 2);
  const sin = new Float32Array(N / 2);
  for (let k = 0; k < N / 2; k++) {
    const angle = (-2 * Math.PI * k) / N;
    cos[k] = Math.cos(angle);
    sin[k] = Math.sin(angle);
  }
  return { cos, sin };
}

// ---------------------------------------------------------------------------
// Core in-place radix-2 DIT FFT
// ---------------------------------------------------------------------------

/**
 * In-place Cooley-Tukey FFT.
 * @param re  Real part array (length must be power of 2)
 * @param im  Imaginary part array (same length as re)
 * @param inverse  If true, compute inverse FFT (unnormalized)
 */
export function fftInPlace(
  re: Float32Array,
  im: Float32Array,
  inverse = false
): void {
  const N = re.length;
  if (N === 0 || (N & (N - 1)) !== 0) {
    throw new Error(`FFT size must be a power of 2, got ${N}`);
  }

  const bits = Math.log2(N) | 0;
  // Bit-reversal permutation
  for (let i = 0; i < N; i++) {
    const j = bitReverse(i, bits);
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  const sign = inverse ? 1 : -1;
  for (let step = 1; step < N; step <<= 1) {
    const jump = step << 1;
    const theta = (sign * Math.PI) / step;
    const sinHalf = Math.sin(0.5 * theta);
    const wpr = -2 * sinHalf * sinHalf;
    const wpi = Math.sin(theta);
    let wr = 1.0, wi = 0.0;
    for (let m = 0; m < step; m++) {
      for (let k = m; k < N; k += jump) {
        const l = k + step;
        const tr = wr * re[l] - wi * im[l];
        const ti = wr * im[l] + wi * re[l];
        re[l] = re[k] - tr;
        im[l] = im[k] - ti;
        re[k] += tr;
        im[k] += ti;
      }
      const tmp = wr;
      wr = tmp * wpr - wi * wpi + tmp;
      wi = wi * wpr + tmp * wpi + wi;
    }
  }

  if (inverse) {
    const scale = 1 / N;
    for (let i = 0; i < N; i++) {
      re[i] *= scale;
      im[i] *= scale;
    }
  }
}

// ---------------------------------------------------------------------------
// FFTEngine class – manages windowing, overlap-add state
// ---------------------------------------------------------------------------

export class FFTEngine {
  readonly fftSize: number;
  readonly hopSize: number;
  readonly sampleRate: number;
  private window: Float32Array;
  private overlapBuffer: Float32Array;
  private bitReverseTable: Uint16Array;
  private twiddleCos: Float32Array;
  private twiddleSin: Float32Array;
  /** Normalisation scalar for overlap-add reconstruction */
  private olaScale: number;

  constructor(config: AudioConfig) {
    const { fftSize, hopSize, windowFunction, sampleRate } = config;
    if (fftSize !== 2048) console.warn(`FFTEngine: fftSize=${fftSize}, optimised for 2048`);

    this.fftSize = fftSize;
    this.hopSize = hopSize;
    this.sampleRate = sampleRate;
    this.overlapBuffer = new Float32Array(fftSize);
    this.bitReverseTable = buildBitReverseTable(fftSize);

    switch (windowFunction) {
      case 'hamming':  this.window = buildHammingWindow(fftSize);  break;
      case 'blackman': this.window = buildBlackmanWindow(fftSize); break;
      default:         this.window = buildHannWindow(fftSize);
    }

    const { cos, sin } = buildTwiddleFactors(fftSize);
    this.twiddleCos = cos;
    this.twiddleSin = sin;

    // OLA normalisation: sum of squared window values over hop
    let wsum = 0;
    for (let i = 0; i < fftSize; i++) wsum += this.window[i] * this.window[i];
    this.olaScale = hopSize / wsum;
  }

  // -------------------------------------------------------------------------
  // Analysis: time-domain frame → SpectralFrame
  // -------------------------------------------------------------------------

  /**
   * Forward FFT on a single windowed frame.
   * Returns one-sided spectrum (bins 0 … fftSize/2).
   */
  analyze(samples: Float32Array, frameIndex: number, timestamp: number): SpectralFrame {
    const N = this.fftSize;
    const half = N / 2 + 1;
    const re = new Float32Array(N);
    const im = new Float32Array(N);

    // Apply window
    for (let i = 0; i < N; i++) {
      re[i] = samples[i] * this.window[i];
    }

    fftInPlace(re, im);

    // Extract one-sided magnitude & phase
    const magnitude = new Float32Array(half);
    const phase = new Float32Array(half);
    for (let k = 0; k < half; k++) {
      magnitude[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }

    return { real: re, imag: im, magnitude, phase, frameIndex, timestamp };
  }

  // -------------------------------------------------------------------------
  // Synthesis: SpectralFrame (modified magnitude) → PCM via overlap-add
  // -------------------------------------------------------------------------

  /**
   * Inverse FFT + OLA accumulation.
   * @param frame  Spectral frame (phase preserved, magnitude may be modified)
   * @param out    Output buffer to accumulate into (length ≥ fftSize)
   */
  synthesize(frame: SpectralFrame, out: Float32Array): void {
    const N = this.fftSize;
    const half = N / 2 + 1;
    const re = new Float32Array(N);
    const im = new Float32Array(N);

    // Reconstruct full spectrum from magnitude + phase (one-sided → two-sided)
    for (let k = 0; k < half; k++) {
      re[k] = frame.magnitude[k] * Math.cos(frame.phase[k]);
      im[k] = frame.magnitude[k] * Math.sin(frame.phase[k]);
    }
    for (let k = half; k < N; k++) {
      const mirror = N - k;
      re[k] = re[mirror];
      im[k] = -im[mirror];
    }

    fftInPlace(re, im, true /* inverse */);

    // Windowed overlap-add
    for (let i = 0; i < N; i++) {
      out[i] += re[i] * this.window[i] * this.olaScale;
    }
  }

  /**
   * Shift overlap buffer left by hopSize after each hop is consumed.
   */
  shiftOverlapBuffer(hop: number = this.hopSize): void {
    this.overlapBuffer.copyWithin(0, hop);
    this.overlapBuffer.fill(0, this.fftSize - hop);
  }

  get overlap(): Float32Array {
    return this.overlapBuffer;
  }

  /** Compute power spectrum (squared magnitudes) from a SpectralFrame */
  static powerSpectrum(frame: SpectralFrame): Float32Array {
    const power = new Float32Array(frame.magnitude.length);
    for (let k = 0; k < power.length; k++) {
      power[k] = frame.magnitude[k] * frame.magnitude[k];
    }
    return power;
  }

  /** Convert bin index to frequency in Hz using the engine's own sample rate */
  binToHz(bin: number): number {
    return (bin * this.sampleRate) / this.fftSize;
  }

  binToFreq(bin: number, sampleRate: number): number {
    return (bin * sampleRate) / this.fftSize;
  }

  freqToBin(hz: number, sampleRate: number): number {
    return Math.round((hz * this.fftSize) / sampleRate);
  }
}
