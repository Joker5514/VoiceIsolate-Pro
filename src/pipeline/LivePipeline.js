/**
 * VoiceIsolate Pro — Live-Mode Pipeline (Layer 3: Pipeline)
 *
 * Integrates QuantumHopBridge with optional SharedRingBuffer transport for
 * hop-aligned FFT analysis in live mode (Blueprint v2.1 §III).
 *
 * Flow:
 *   AudioWorklet quantum (128 samples) ─► QuantumHopBridge.pushQuantum()
 *       ─► on hop boundary: analysis window ready for STFT / RNNoise path
 *       ─► optional OverlapAddReconstructor for synthesis grains
 *
 * Does NOT open a microphone or register a worklet — callers supply quanta.
 */
'use strict';

import {
  QUANTUM,
  HOP_SIZE,
  FFT_SIZE_LIVE,
} from '../core/ring-buffer-constants.js';
import {
  QuantumHopBridge,
  OverlapAddReconstructor,
} from '../core/OverlapAddAccumulator.js';

/**
 * @typedef {(window: Float32Array, frameIndex: number) => void} HopCallback
 */

export class LivePipeline {
  /**
   * @param {object} [opts]
   * @param {number} [opts.quantum]
   * @param {number} [opts.hopSize]
   * @param {number} [opts.fftSize]
   * @param {boolean} [opts.enableSynthesis] allocate OverlapAddReconstructor
   * @param {number} [opts.outputLength] synthesis buffer length
   */
  constructor(opts = {}) {
    this.quantum = opts.quantum ?? QUANTUM;
    this.hopSize = opts.hopSize ?? HOP_SIZE;
    this.fftSize = opts.fftSize ?? FFT_SIZE_LIVE;

    this._hopBridge = new QuantumHopBridge({
      quantum: this.quantum,
      hopSize: this.hopSize,
      fftSize: this.fftSize,
    });

    this._analysisScratch = new Float32Array(this.fftSize);
    this._hopCallbacks = [];
    this._reconstructor = opts.enableSynthesis
      ? new OverlapAddReconstructor({
        fftSize: this.fftSize,
        hopSize: this.hopSize,
        outputLength: opts.outputLength,
      })
      : null;
  }

  /** @returns {QuantumHopBridge} */
  get hopBridge() {
    return this._hopBridge;
  }

  /** @returns {OverlapAddReconstructor|null} */
  get reconstructor() {
    return this._reconstructor;
  }

  /** Reset hop accumulator and optional synthesis state. */
  reset() {
    this._hopBridge.reset();
    if (this._reconstructor) {
      this._reconstructor.reset();
    }
  }

  /**
   * Register a callback invoked on each hop boundary with the analysis window.
   * @param {HopCallback} fn
   * @returns {() => void} unsubscribe
   */
  onHop(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('[VIP][LivePipeline] onHop expects a function.');
    }
    this._hopCallbacks.push(fn);
    return () => {
      const idx = this._hopCallbacks.indexOf(fn);
      if (idx >= 0) this._hopCallbacks.splice(idx, 1);
    };
  }

  /**
   * Push one AudioWorklet quantum. Returns true when a hop boundary was crossed.
   * @param {Float32Array} quantumSamples
   * @returns {boolean}
   */
  pushQuantum(quantumSamples) {
    const hopReady = this._hopBridge.pushQuantum(quantumSamples);
    if (!hopReady) return false;

    const frameIndex = this._hopBridge.hopCount - 1;
    const window = this._hopBridge.getAnalysisWindow(this._analysisScratch);
    for (const cb of this._hopCallbacks) {
      cb(window, frameIndex);
    }
    return true;
  }

  /**
   * Drain available quanta from a ring buffer that exposes pull(quantum).
   * @param {{ pull: (n: number) => Float32Array|null }} ring
   * @returns {number} quanta processed
   */
  drainRingBuffer(ring) {
    if (!ring || typeof ring.pull !== 'function') {
      throw new TypeError('[VIP][LivePipeline] drainRingBuffer expects a ring with pull().');
    }
    let count = 0;
    for (;;) {
      const quantum = ring.pull(this.quantum);
      if (!quantum) break;
      this.pushQuantum(quantum);
      count += 1;
    }
    return count;
  }

  /**
   * Add a synthesis grain at the given frame index (requires enableSynthesis).
   * @param {Float32Array} grain
   * @param {number} frameIndex
   */
  addSynthesisGrain(grain, frameIndex) {
    if (!this._reconstructor) {
      throw new Error('[VIP][LivePipeline] Synthesis disabled — pass enableSynthesis: true.');
    }
    this._reconstructor.addGrain(grain, frameIndex);
  }

  /**
   * Finalize overlap-add synthesis output.
   * @returns {Float32Array|null}
   */
  finalizeSynthesis() {
    return this._reconstructor ? this._reconstructor.finalize() : null;
  }
}

export default LivePipeline;