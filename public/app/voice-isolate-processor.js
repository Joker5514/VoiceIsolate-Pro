/* ============================================
   VoiceIsolate Pro — AudioWorkletProcessor
   Threads from Space v8 · Real-Time Live Mode
   Single-Pass STFT via SharedArrayBuffer bridge
   STFT happens HERE (worklet side) for framing;
   spectral masking via ML output from main thread.
   ============================================ */
'use strict';

// ---------------------------------------------------------------------------
// Inline radix-2 Cooley-Tukey FFT (no imports allowed inside AudioWorklet)
// ---------------------------------------------------------------------------
function fft(real, imag, inverse) {
  const N = real.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = real[i]; real[i] = real[j]; real[j] = t;
      t = imag[i]; imag[i] = imag[j]; imag[j] = t;
    }
  }
  // Butterfly stages
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wR = Math.cos(ang), wI = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cR = 1, cI = 0;
      for (let j = 0; j < half; j++) {
        const tR = cR * real[i+j+half] - cI * imag[i+j+half];
        const tI = cR * imag[i+j+half] + cI * real[i+j+half];
        real[i+j+half] = real[i+j] - tR;
        imag[i+j+half] = imag[i+j] - tI;
        real[i+j] += tR;
        imag[i+j] += tI;
        const nR = cR * wR - cI * wI;
        cI = cR * wI + cI * wR;
        cR = nR;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < N; i++) { real[i] /= N; imag[i] /= N; }
  }
}

// ---------------------------------------------------------------------------
// Hann window cache
// ---------------------------------------------------------------------------
const _hannCache = new Map();
function hannWindow(N) {
  if (_hannCache.has(N)) return _hannCache.get(N);
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
  _hannCache.set(N, w);
  return w;
}

// ---------------------------------------------------------------------------
// Harmonic enhancer (post-gate, pre-mix — identical to v20 root version)
// ---------------------------------------------------------------------------
class HarmonicEnhancer {
  constructor(amount = 0) { this.setAmount(amount); }
  setAmount(amt) {
    this.amount = Math.max(0, Math.min(100, amt));
    this.enabled = this.amount > 0;
    this.drive = 1 + this.amount / 100 * 4;
    this.tanhDrive = Math.tanh(this.drive);
    this.wetGain = this.amount / 100;
    this.dryGain = 1 - this.wetGain;
  }
  processSample(s) {
    if (!this.enabled) return s;
    return this.dryGain * s + this.wetGain * (Math.tanh(this.drive * s) / this.tanhDrive);
  }
}

// ---------------------------------------------------------------------------
// VoiceIsolateProcessor
//
// Architecture:
//   AudioWorklet (this file)
//     ├─ Accumulates 128-sample render quanta into inputAccum[]
//     ├─ When inputAccum has ≥ HOP_SIZE samples:
//     │    • Copies newest FFT_SIZE samples into a windowed frame
//     │    • Runs single Forward FFT  → writes mag+phase to inputSAB
//     │    • Atomics.notify wakes ML Worker on main thread
//     │    • Reads processed spectral frame (mag only) from outputSAB
//     │    • Runs single Inverse FFT (iFFT) → overlap-adds to outputAccum
//     └─ Drains 128 samples from outputAccum into output buffer
//
// SharedArrayBuffer layout (both inputSAB and outputSAB):
//   [0]  Int32 writeIdx   (sample position, wraps at capacity)
//   [1]  Int32 readIdx
//   [2]  Int32 frameReady (0|1 flag, Atomics.notify target)
//   [3]  Int32 overruns
//   [16..16+capacity*4]  Float32Array payload
// ---------------------------------------------------------------------------
class VoiceIsolateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // DSP constants
    this.FFT_SIZE = 4096;
    this.HOP_SIZE = 1024;
    this.HALF_N   = this.FFT_SIZE / 2 + 1;

    // Overlap-add accumulation buffers (2× FFT_SIZE headroom)
    this.inputAccum  = new Float32Array(this.FFT_SIZE * 4);
    this.inputHead   = 0;  // write pointer into inputAccum
    this.outputAccum = new Float32Array(this.FFT_SIZE * 4);
    this.outputTail  = 0;  // read pointer from outputAccum
    this.outputHead  = 0;  // write pointer into outputAccum
    this.outputWindowSum = new Float32Array(this.FFT_SIZE * 4);
    this.hopsSinceInit = 0; // latency compensation: don't drain until first iFFT done

    // Reusable FFT scratch buffers (avoid per-frame alloc)
    this.fftReal = new Float32Array(this.FFT_SIZE);
    this.fftImag = new Float32Array(this.FFT_SIZE);

    // Hann window (precomputed)
    this.window = hannWindow(this.FFT_SIZE);

    // SharedArrayBuffer ring views (set via initRingBuffers message)
    this.inputSAB  = null;  // Float32Array[HALF_N] written by worklet, read by ML worker
    this.outputSAB = null;  // Float32Array[HALF_N] written by ML worker, read by worklet
    this.ctrlIn    = null;  // Int32Array[4] control for inputSAB
    this.ctrlOut   = null;  // Int32Array[4] control for outputSAB

    // Gate / dynamics state
    this.gateEnv     = 0;
    this.holdCounter = 0;

    // User-adjustable params (updated via port.postMessage)
    this.params = {
      gateThresh:      -42,
      gateRange:       -40,
      gateAttack:        2,
      gateRelease:      80,
      gateHold:         20,
      outGain:           0,
      dryWet:          100,
      harmonicEnhance:   0,
      bypass:        false,
    };

    this.harmonicEnhancer = new HarmonicEnhancer(0);

    // Message handler — runs on audio thread message queue
    this.port.onmessage = ({ data }) => this._onMessage(data);
  }

  // ─── Message Handler ───────────────────────────────────────────────────
  _onMessage(msg) {
    switch (msg.type) {

      case 'initRingBuffers': {
        // inputSAB: worklet writes spectral frames → ML Worker reads
        // outputSAB: ML Worker writes processed mags → worklet reads
        this.FFT_SIZE = msg.fftSize  || this.FFT_SIZE;
        this.HOP_SIZE = msg.hopSize  || this.HOP_SIZE;
        this.HALF_N   = this.FFT_SIZE / 2 + 1;
        this.window   = hannWindow(this.FFT_SIZE);
        this.fftReal  = new Float32Array(this.FFT_SIZE);
        this.fftImag  = new Float32Array(this.FFT_SIZE);

        if (msg.inputSAB) {
          this.ctrlIn   = new Int32Array(msg.inputSAB, 0, 4);
          this.inputSAB = new Float32Array(msg.inputSAB, 16, this.HALF_N * 2); // mag+phase
        }
        if (msg.outputSAB) {
          this.ctrlOut   = new Int32Array(msg.outputSAB, 0, 4);
          this.outputSAB = new Float32Array(msg.outputSAB, 16, this.HALF_N);   // mag only
        }
        break;
      }

      case 'param':
        if (msg.key in this.params) {
          this.params[msg.key] = msg.value;
          if (msg.key === 'harmonicEnhance') this.harmonicEnhancer.setAmount(msg.value);
        }
        break;

      case 'paramBulk':
        for (const [k, v] of Object.entries(msg.params)) {
          if (k in this.params) {
            this.params[k] = v;
            if (k === 'harmonicEnhance') this.harmonicEnhancer.setAmount(v);
          }
        }
        break;

      case 'bypass':
        this.params.bypass = !!msg.value;
        break;
    }
  }

  // ─── Single Forward STFT Frame ─────────────────────────────────────────
  // Writes HALF_N magnitudes then HALF_N phases into inputSAB starting at offset 0.
  // Returns phase array (Float32Array) for later iFFT reconstruction.
  _forwardSTFTFrame(audioData) {
    const N = this.FFT_SIZE;
    const halfN = this.HALF_N;
    const real = this.fftReal;
    const imag = this.fftImag;
    const w    = this.window;

    // Window and copy into real[], zero imag[]
    for (let i = 0; i < N; i++) {
      real[i] = (i < audioData.length) ? audioData[i] * w[i] : 0;
      imag[i] = 0;
    }

    // ── SINGLE FORWARD FFT ──
    fft(real, imag, false);

    // Extract mag + phase for positive frequencies
    const phase = new Float32Array(halfN);
    if (this.inputSAB) {
      for (let k = 0; k < halfN; k++) {
        const mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
        this.inputSAB[k]        = mag;                         // [0..halfN-1] = mag
        this.inputSAB[halfN + k] = Math.atan2(imag[k], real[k]); // [halfN..] = phase
        phase[k] = this.inputSAB[halfN + k];
      }
      // Signal ML Worker: new spectral frame ready
      Atomics.store(this.ctrlIn, 2, 1);
      Atomics.notify(this.ctrlIn, 2, 1);
    } else {
      // No SAB yet — extract phase locally for passthrough
      for (let k = 0; k < halfN; k++) {
        phase[k] = Math.atan2(imag[k], real[k]);
      }
    }

    return phase;
  }

  // ─── Single Inverse STFT Frame ─────────────────────────────────────────
  // Reads processed magnitudes from outputSAB (or falls back to forward mag).
  // Reconstructs complex spectrum using the original phase (phase vocoder passthrough).
  // Overlap-adds result into outputAccum.
  _inverseSTFTFrame(phase, fallbackMag) {
    const N     = this.FFT_SIZE;
    const halfN = this.HALF_N;
    const real  = this.fftReal;
    const imag  = this.fftImag;
    const w     = this.window;

    // Determine which magnitude array to use
    let magArr = fallbackMag;
    if (this.outputSAB && Atomics.load(this.ctrlOut, 2) === 1) {
      // ML Worker has a processed frame ready — use it
      magArr = this.outputSAB.subarray(0, halfN);
      Atomics.store(this.ctrlOut, 2, 0); // consume
    }

    // Reconstruct complex spectrum
    for (let k = 0; k < halfN; k++) {
      const m = magArr ? magArr[k] : 0;
      real[k] = m * Math.cos(phase[k]);
      imag[k] = m * Math.sin(phase[k]);
    }
    // Mirror negative frequencies
    for (let k = halfN; k < N; k++) {
      real[k] =  real[N - k];
      imag[k] = -imag[N - k];
    }

    // ── SINGLE INVERSE FFT ──
    fft(real, imag, true);

    // Overlap-add into outputAccum with synthesis Hann window
    const offset = this.outputHead;
    const len    = this.outputAccum.length;
    for (let i = 0; i < N; i++) {
      const idx = (offset + i) % len;
      this.outputAccum[idx]    += real[i] * w[i];
      this.outputWindowSum[idx] += w[i] * w[i];
    }
    this.outputHead = (offset + this.HOP_SIZE) % len;
    this.hopsSinceInit++;
  }

  // ─── process() — called every 128 samples ──────────────────────────────
  process(inputs, outputs) {
    const inBuf  = inputs[0]?.[0];
    const outBuf = outputs[0]?.[0];
    if (!inBuf || !outBuf) return true;

    const RENDER = 128; // Web Audio render quantum size

    // Bypass: passthrough only
    if (this.params.bypass) {
      outBuf.set(inBuf);
      return true;
    }

    // ── 1. Accumulate input samples ──────────────────────────────────────
    const accumLen = this.inputAccum.length;
    for (let i = 0; i < RENDER; i++) {
      this.inputAccum[this.inputHead % accumLen] = inBuf[i];
      this.inputHead++;
    }

    // ── 2. Run STFT frames whenever we have a full hop ────────────────────
    while (this.inputHead - (this.outputHead === 0 ? 0 : this.outputTail) >= this.HOP_SIZE) {
      // Gather newest FFT_SIZE samples from ring buffer
      const frame = new Float32Array(this.FFT_SIZE);
      const base  = this.inputHead - this.FFT_SIZE;
      for (let i = 0; i < this.FFT_SIZE; i++) {
        const idx = (base + i + accumLen) % accumLen;
        frame[i] = base + i >= 0 ? this.inputAccum[(base + i) % accumLen] : 0;
      }

      // Build fallback magnitude from forward FFT (in case ML Worker has no frame yet)
      const halfN    = this.HALF_N;
      const fwdPhase = this._forwardSTFTFrame(frame);

      // Compute fallback mag from fftReal/fftImag (already populated by _forwardSTFTFrame)
      const fallbackMag = new Float32Array(halfN);
      for (let k = 0; k < halfN; k++) {
        fallbackMag[k] = Math.sqrt(
          this.fftReal[k] * this.fftReal[k] +
          this.fftImag[k] * this.fftImag[k]
        );
      }

      this._inverseSTFTFrame(fwdPhase, fallbackMag);

      // Advance output tail by one hop
      this.outputTail += this.HOP_SIZE;
    }

    // ── 3. Gate + dynamics params (precomputed once per render quantum) ───
    const p = this.params;
    const threshLin   = Math.pow(10, p.gateThresh  / 20);
    const rangeLin    = Math.pow(10, p.gateRange   / 20);
    const attackCoeff = Math.exp(-1 / (p.gateAttack  * 0.001 * sampleRate));
    const relCoeff    = Math.exp(-1 / (p.gateRelease * 0.001 * sampleRate));
    const holdSamps   = Math.floor(p.gateHold * 0.001 * sampleRate);
    const outGainLin  = Math.pow(10, p.outGain / 20);
    const wet = p.dryWet / 100;
    const dry = 1 - wet;

    // ── 4. Drain outputAccum → output buffer ─────────────────────────────
    const oLen = this.outputAccum.length;
    for (let i = 0; i < RENDER; i++) {
      // Don't read until we have latency of at least 1 FFT frame
      if (this.hopsSinceInit < Math.ceil(this.FFT_SIZE / this.HOP_SIZE)) {
        outBuf[i] = 0;
        continue;
      }

      const idx    = (this.outputTail - RENDER + i + oLen) % oLen;
      const wsum   = this.outputWindowSum[idx];
      let   sample = wsum > 1e-8 ? this.outputAccum[idx] / wsum : 0;

      // Clear consumed slot
      this.outputAccum[idx]    = 0;
      this.outputWindowSum[idx] = 0;

      // Noise gate
      const absVal = Math.abs(inBuf[i]);
      let target;
      if (absVal > threshLin) {
        target = 1;
        this.holdCounter = holdSamps;
      } else if (this.holdCounter > 0) {
        target = 1;
        this.holdCounter--;
      } else {
        target = rangeLin;
      }
      const coeff = target > this.gateEnv ? attackCoeff : relCoeff;
      this.gateEnv = coeff * this.gateEnv + (1 - coeff) * target;
      sample *= this.gateEnv;

      // Harmonic enhancement
      sample = this.harmonicEnhancer.processSample(sample);

      // Dry/wet + output gain
      outBuf[i] = (dry * inBuf[i] + wet * sample) * outGainLin;
    }

    return true;
  }

  static get parameterDescriptors() { return []; }
}

registerProcessor('voice-isolate-processor', VoiceIsolateProcessor);
