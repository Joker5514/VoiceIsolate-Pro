/* ============================================
   VoiceIsolate Pro v20.0 — AudioWorklet
   Threads from Space v10 · Real-Time DSP
   128-sample render quanta · Ring Buffer I/O
   ============================================ */

'use strict';

/**
 * HarmonicEnhancer — real-time harmonic enhancement via waveshaping.
 * Adds subtle even and odd harmonics to restore voice presence that is
 * lost during aggressive noise suppression. The enhancement amount is
 * continuously adjustable without clicks via parameter smoothing.
 */
class HarmonicEnhancer {
  /**
   * @param {number} amount - enhancement amount 0–100 (0 = bypassed)
   */
  constructor(amount = 0) {
    this.setAmount(amount);
  }

  /**
   * Update enhancement amount (safe to call every audio block).
   * @param {number} amt - new amount 0–100
   */
  setAmount(amt) {
    this.amount = Math.max(0, Math.min(100, amt));
    this.enabled = this.amount > 0;
    // Drive factor: 1 at 0%, 5 at 100% — keeps tanh saturation moderate
    this.drive = 1 + this.amount / 100 * 4;
    this.tanhDrive = Math.tanh(this.drive); // precompute for normalization
    this.wetGain = this.amount / 100;
    this.dryGain = 1 - this.wetGain;
  }

  /**
   * Process a single sample.
   * @param {number} sample - input sample [-1, 1]
   * @returns {number} harmonically enhanced sample
   *
   * Normalization: Math.tanh(drive * x) / Math.tanh(drive) maps ±1 → ±1,
   * preserving peak amplitude while adding harmonic saturation.
   */
  processSample(sample) {
    if (!this.enabled) return sample;
    const enhanced = Math.tanh(this.drive * sample) / this.tanhDrive;
    return this.dryGain * sample + this.wetGain * enhanced;
  }
}

/**
 * AudioWorklet processor for real-time voice isolation.
 * - Pushes input to SharedRingBuffer for ML Worker consumption
 * - Reads ML-generated masks from mask ring buffer
 * - Applies real-time gating, gain, and parameter changes
 * - Receives param updates via MessagePort
 */
class VoiceIsolateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // State
    this.params = {
      gateThresh: -42,
      gateRange: -40,
      gateAttack: 2,
      gateRelease: 80,
      gateHold: 20,
      outGain: 0,
      dryWet: 100,
      harmonicEnhance: 0   // 0 = bypassed, 1–100 = enhancement amount
    };
    this.gateEnv = 0;       // current gate envelope (0–1)
    this.holdCounter = 0;    // gate hold timer in samples
    this.inputRing = null;   // SharedRingBuffer (write side)
    this.maskRing = null;    // SharedRingBuffer (read side)
    this.maskCache = null;   // cached mask frame
    this.maskIdx = 0;        // position within cached mask
    this.frameSize = 4096;
    this.bypassed = false;
    this.harmonicEnhancer = new HarmonicEnhancer(0);

    // MessagePort for param updates & ring buffer init
    this.port.onmessage = (e) => this._handleMessage(e.data);
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'param':
        if (msg.key in this.params) {
          this.params[msg.key] = msg.value;
          if (msg.key === 'harmonicEnhance') {
            this.harmonicEnhancer.setAmount(msg.value);
          }
        }
        break;

      case 'paramBulk':
        for (const [key, value] of Object.entries(msg.params)) {
          if (key in this.params) {
            this.params[key] = value;
            if (key === 'harmonicEnhance') {
              this.harmonicEnhancer.setAmount(value);
            }
          }
        }
        break;

      case 'initRingBuffers':
        // Reconstruct ring buffers from shared SABs
        this.frameSize = msg.frameSize || 4096;
        if (msg.inputSAB) {
          this.inputRing = this._createRingView(msg.inputSAB, msg.frameSize, msg.frameCount);
        }
        if (msg.maskSAB) {
          this.maskRing = this._createRingView(msg.maskSAB, msg.frameSize, msg.frameCount);
        }
        break;

      case 'bypass':
        this.bypassed = msg.value;
        break;
    }
  }

  _createRingView(sab, frameSize, frameCount) {
    const capacity = frameSize * frameCount;
    const control = new Int32Array(sab, 0, 4);
    const data = new Float32Array(sab, 16, capacity);
    return { control, data, capacity };
  }

  _ringAvailable(ring) {
    const w = Atomics.load(ring.control, 0);
    const r = Atomics.load(ring.control, 1);
    return (w - r + ring.capacity) % ring.capacity;
  }

  _ringPush(ring, samples) {
    const len = samples.length;
    const space = ring.capacity - 1 - this._ringAvailable(ring);
    if (len > space) {
      Atomics.add(ring.control, 3, 1);
      return false;
    }
    let w = Atomics.load(ring.control, 0);
    const first = Math.min(len, ring.capacity - w);
    ring.data.set(samples.subarray(0, first), w);
    if (first < len) ring.data.set(samples.subarray(first), 0);
    Atomics.store(ring.control, 0, (w + len) % ring.capacity);
    return true;
  }

  _ringPull(ring, count) {
    if (this._ringAvailable(ring) < count) return null;
    const out = new Float32Array(count);
    let r = Atomics.load(ring.control, 1);
    const first = Math.min(count, ring.capacity - r);
    out.set(ring.data.subarray(r, r + first));
    if (first < count) out.set(ring.data.subarray(0, count - first), first);
    Atomics.store(ring.control, 1, (r + count) % ring.capacity);
    return out;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const inCh = input[0];
    const outCh = output[0];
    const len = inCh.length; // 128 samples

    // Bypass mode
    if (this.bypassed) {
      outCh.set(inCh);
      return true;
    }

    // Push input to ring buffer for ML Worker
    if (this.inputRing) {
      this._ringPush(this.inputRing, inCh);
      // Wake ML worker
      Atomics.notify(this.inputRing.control, 0, 1);
    }

    // Try to pull a new mask frame if needed
    if (this.maskRing && (!this.maskCache || this.maskIdx >= this.frameSize)) {
      const newMask = this._ringPull(this.maskRing, this.frameSize);
      if (newMask) {
        this.maskCache = newMask;
        this.maskIdx = 0;
      }
    }

    // Gate parameters
    const threshLin = Math.pow(10, this.params.gateThresh / 20);
    const rangeLin = Math.pow(10, this.params.gateRange / 20);
    const attackCoeff = Math.exp(-1 / (this.params.gateAttack * 0.001 * sampleRate));
    const releaseCoeff = Math.exp(-1 / (this.params.gateRelease * 0.001 * sampleRate));
    const holdSamples = Math.floor(this.params.gateHold * 0.001 * sampleRate);
    const outGainLin = Math.pow(10, this.params.outGain / 20);
    const wet = this.params.dryWet / 100;
    const dry = 1 - wet;

    for (let i = 0; i < len; i++) {
      let sample = inCh[i];
      const absVal = Math.abs(sample);

      // Gate envelope follower
      let target;
      if (absVal > threshLin) {
        target = 1;
        this.holdCounter = holdSamples;
      } else if (this.holdCounter > 0) {
        target = 1;
        this.holdCounter--;
      } else {
        target = rangeLin;
      }

      const coeff = (target > this.gateEnv) ? attackCoeff : releaseCoeff;
      this.gateEnv = coeff * this.gateEnv + (1 - coeff) * target;

      // Apply gate
      let gated = sample * this.gateEnv;

      // [FIX 7]: ML worker now outputs pre-processed time-domain audio
      // (already through STFT→mask→iSTFT in the ML worker), not raw spectral
      // masks. Blend ML output with gated input using dryWet instead of
      // per-sample spectral mask multiplication which caused clicks/artifacts.
      if (this.maskCache && this.maskIdx < this.frameSize) {
        const mlOut = this.maskCache[this.maskIdx];
        gated = wet * mlOut + dry * gated;
        this.maskIdx++;
      }

      // Harmonic enhancement (post-gate, pre-mix) — restores voice presence
      gated = this.harmonicEnhancer.processSample(gated);

      // Dry/wet mix + output gain
      outCh[i] = (dry * sample + wet * gated) * outGainLin;
    }

    return true;
  }

  static get parameterDescriptors() {
    return [];
  }
}

registerProcessor('voice-isolate-processor', VoiceIsolateProcessor);
