/**
 * VoiceIsolate Pro — Overlap-Add Accumulator (Layer 1: Core)
 *
 * Bridges AudioWorklet 128-sample quanta to hop-aligned FFT windows and
 * performs symmetric Hann overlap-add reconstruction. Implements the exact
 * math specified in Master Blueprint v2.1 §III.
 *
 * Pure module: no DOM, no Web Audio, no I/O.
 */
'use strict';

import {
  QUANTUM,
  HOP_SIZE,
  FFT_SIZE_LIVE,
  validateRingBufferConstants,
} from './ring-buffer-constants.js';

const _hannCache = Object.create(null);

/**
 * Periodic Hann window (COLA-compatible at 75% overlap when hop = N/4).
 * @param {number} n
 * @returns {Float32Array}
 */
export function hannWindow(n) {
  if (_hannCache[n]) return _hannCache[n];
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  }
  _hannCache[n] = w;
  return w;
}

/**
 * Accumulates AudioWorklet quanta until exactly QUANTA_PER_HOP quanta have
 * been received, then exposes a contiguous hop-sized advance for FFT analysis.
 */
export class QuantumHopBridge {
  /**
   * @param {object} [opts]
   * @param {number} [opts.quantum=QUANTUM]
   * @param {number} [opts.hopSize=HOP_SIZE]
   * @param {number} [opts.fftSize=FFT_SIZE_LIVE]
   */
  constructor(opts = {}) {
    const validated = validateRingBufferConstants({
      quantum: opts.quantum ?? QUANTUM,
      hopSize: opts.hopSize ?? HOP_SIZE,
      fftSize: opts.fftSize ?? FFT_SIZE_LIVE,
    });

    this.quantum = validated.quantum;
    this.hopSize = validated.hopSize;
    this.fftSize = validated.fftSize;
    this.quantaPerHop = validated.quantaPerHop;

    this._ring = new Float32Array(this.fftSize);
    this._writePos = 0;
    this._quantaSinceHop = 0;
    this._hopIndex = 0;
    this._totalQuanta = 0;
  }

  /** Reset internal state without reallocating buffers. */
  reset() {
    this._ring.fill(0);
    this._writePos = 0;
    this._quantaSinceHop = 0;
    this._hopIndex = 0;
    this._totalQuanta = 0;
  }

  /**
   * Push one AudioWorklet quantum (length must equal `this.quantum`).
   * @param {Float32Array} quantumSamples
   * @returns {boolean} true when a new hop boundary was crossed
   */
  pushQuantum(quantumSamples) {
    if (quantumSamples.length !== this.quantum) {
      throw new RangeError(
        `[VIP][OverlapAdd] expected quantum length ${this.quantum}, got ${quantumSamples.length}.`
      );
    }

    for (let i = 0; i < this.quantum; i++) {
      this._ring[this._writePos] = quantumSamples[i];
      this._writePos = (this._writePos + 1) % this.fftSize;
    }

    this._quantaSinceHop += 1;
    this._totalQuanta += 1;

    if (this._quantaSinceHop < this.quantaPerHop) {
      return false;
    }

    this._quantaSinceHop = 0;
    this._hopIndex += 1;
    return true;
  }

  /**
   * Copy the current fftSize analysis window in chronological order.
   * @param {Float32Array} [dest]
   * @returns {Float32Array}
   */
  getAnalysisWindow(dest) {
    const out = dest && dest.length === this.fftSize
      ? dest
      : new Float32Array(this.fftSize);
    const start = this._writePos;
    const tail = this.fftSize - start;
    out.set(this._ring.subarray(start), 0);
    if (start > 0) out.set(this._ring.subarray(0, start), tail);
    return out;
  }

  /** Zero-copy view of the ring in chronological order (new allocation). */
  analysisWindow() {
    return this.getAnalysisWindow();
  }

  /** Number of hop boundaries crossed since construction / reset. */
  get hopCount() {
    return this._hopIndex;
  }

  /** Total quanta received since construction / reset. */
  get totalQuanta() {
    return this._totalQuanta;
  }
}

/**
 * Symmetric overlap-add reconstructor. Applies Hann windowing on synthesis
 * and divides by the summed window² envelope (COLA restoration).
 */
export class OverlapAddReconstructor {
  /**
   * @param {object} [opts]
   * @param {number} [opts.fftSize=FFT_SIZE_LIVE]
   * @param {number} [opts.hopSize=HOP_SIZE]
   * @param {number} [opts.outputLength]
   */
  constructor(opts = {}) {
    const validated = validateRingBufferConstants({
      fftSize: opts.fftSize ?? FFT_SIZE_LIVE,
      hopSize: opts.hopSize ?? HOP_SIZE,
    });

    this.fftSize = validated.fftSize;
    this.hopSize = validated.hopSize;
    this.window = hannWindow(this.fftSize);

    const defaultLen = this.hopSize * 8 + this.fftSize;
    this._outputLength = opts.outputLength ?? defaultLen;
    this._output = new Float32Array(this._outputLength);
    this._norm = new Float32Array(this._outputLength);
    this._framesAdded = 0;
  }

  reset(outputLength) {
    if (outputLength !== undefined) {
      this._outputLength = outputLength;
      this._output = new Float32Array(outputLength);
      this._norm = new Float32Array(outputLength);
    } else {
      this._output.fill(0);
      this._norm.fill(0);
    }
    this._framesAdded = 0;
  }

  /**
   * Add one windowed time-domain grain at `frameIndex * hopSize`.
   * @param {Float32Array} grain — length fftSize (typically iFFT output × Hann)
   * @param {number} frameIndex
   */
  addGrain(grain, frameIndex) {
    if (grain.length !== this.fftSize) {
      throw new RangeError(
        `[VIP][OverlapAdd] grain length ${grain.length} !== fftSize ${this.fftSize}.`
      );
    }

    const start = frameIndex * this.hopSize;
    const win = this.window;

    for (let i = 0; i < this.fftSize; i++) {
      const pos = start + i;
      if (pos >= this._outputLength) break;
      const w = win[i];
      const sample = grain[i] * w;
      this._output[pos] += sample;
      this._norm[pos] += w * w;
    }
    this._framesAdded += 1;
  }

  /**
   * Finalize reconstruction by dividing accumulated output by the window² sum.
   * Floors the divisor at half peak norm so partial-overlap edges do not
   * amplify into clicks (matches SpectralCleanup / MLWorker OLA).
   * @returns {Float32Array}
   */
  finalize() {
    const out = new Float32Array(this._outputLength);
    let maxNorm = 0;
    for (let i = 0; i < this._outputLength; i++) {
      if (this._norm[i] > maxNorm) maxNorm = this._norm[i];
    }
    const floor = Math.max(1e-12, 0.5 * maxNorm);
    for (let i = 0; i < this._outputLength; i++) {
      out[i] = this._output[i] / Math.max(this._norm[i], floor);
    }
    return out;
  }

  get framesAdded() {
    return this._framesAdded;
  }
}

/**
 * Apply Hann analysis window to a time-domain frame (for synthesis testing).
 * @param {Float32Array} frame
 * @param {number} fftSize
 * @returns {Float32Array}
 */
export function applyAnalysisWindow(frame, fftSize) {
  const win = hannWindow(fftSize);
  const out = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) out[i] = frame[i] * win[i];
  return out;
}

/**
 * End-to-end pass-through reconstruction: window grains → OLA → normalized output.
 * Used by unit tests to verify symmetric Hann COLA at blueprint constants.
 *
 * @param {Float32Array} samples — input signal
 * @param {object} [opts]
 * @param {number} [opts.fftSize]
 * @param {number} [opts.hopSize]
 * @returns {Float32Array}
 */
export function reconstructPassThrough(samples, opts = {}) {
  const fftSize = opts.fftSize ?? FFT_SIZE_LIVE;
  const hopSize = opts.hopSize ?? HOP_SIZE;
  validateRingBufferConstants({ fftSize, hopSize });

  const recon = new OverlapAddReconstructor({
    fftSize,
    hopSize,
    outputLength: samples.length,
  });

  const win = hannWindow(fftSize);
  const frameCount = Math.max(1, Math.ceil(Math.max(0, samples.length - fftSize) / hopSize) + 1);
  const frame = new Float32Array(fftSize);

  for (let f = 0; f < frameCount; f++) {
    const start = f * hopSize;
    frame.fill(0);
    const avail = Math.max(0, Math.min(fftSize, samples.length - start));
    for (let i = 0; i < avail; i++) frame[i] = samples[start + i] * win[i];
    recon.addGrain(frame, f);
  }

  return recon.finalize();
}