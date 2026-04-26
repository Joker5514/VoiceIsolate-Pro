/* ============================================
   VoiceIsolate Pro — AudioWorkletProcessor
   Threads from Space v8 · Real-Time Live Mode
   Single-Pass STFT via SharedArrayBuffer bridge

   PATCH v2 (2026-04-12):
   - Bug 1: Fixed process() loop condition — replaced broken
             outputHead/outputTail expression with dedicated
             `inputProcessed` pointer.
   - Bug 2: Added scratch-buffer order comment lock to prevent
             future refactors from breaking fwdPhase/fallbackMag.
   - Bug 3: Replaced broken drain read index with dedicated
             `drainHead` pointer advanced 128 samples per render.
   - Bug 5: hopsSinceInit guard now advances drainHead during
             the muted latency window so the ring never stalls.
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
  // Periodic Hann (divisor N, not N-1) — required for COLA at 75% overlap
  for (let i = 0; i < N; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N));
  _hannCache.set(N, w);
  return w;
}

// ---------------------------------------------------------------------------
// Harmonic enhancer (post-gate, pre-mix)
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
//     ├─ When (inputHead - inputProcessed) >= HOP_SIZE:
//     │    • Copies newest FFT_SIZE samples into a windowed frame
//     │    • Runs single Forward FFT  → writes mag+phase to inputSAB
//     │    • [ORDER LOCK] fallbackMag computed from fftReal/fftImag
//     │      BEFORE _inverseSTFTFrame() overwrites those buffers.
//     │    • Atomics.notify wakes ML Worker
//     │    • Reads processed spectral frame (mag only) from outputSAB
//     │    • Runs single Inverse FFT (iFFT) → overlap-adds to outputAccum
//     │    • inputProcessed += HOP_SIZE
//     └─ Drains 128 samples from outputAccum[drainHead..] into output
//        drainHead advanced by 128 every render quantum.
//
// SharedArrayBuffer layout (both inputSAB and outputSAB):
//   [0]  Int32 writeIdx
//   [1]  Int32 readIdx
//   [2]  Int32 frameReady (0|1 flag, Atomics.notify target)
//   [3]  Int32 overruns
//   [16..16+HALF_N*4*2]  Float32Array payload (mag+phase for input,
//                                               mag only for output)
// ---------------------------------------------------------------------------
class VoiceIsolateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // DSP constants
    this.FFT_SIZE = 4096;
    this.HOP_SIZE = 1024;
    this.HALF_N   = this.FFT_SIZE / 2 + 1;

    // Overlap-add accumulation buffers (4× FFT_SIZE headroom for safe ring arithmetic)
    this.inputAccum  = new Float32Array(this.FFT_SIZE * 4);
    this.inputHead   = 0;   // write pointer — incremented every sample

    // [BUG 1 FIX] dedicated processed-input pointer replaces the broken
    // (outputHead === 0 ? 0 : outputTail) expression.
    this.inputProcessed = 0;

    this.outputAccum     = new Float32Array(this.FFT_SIZE * 4);
    this.outputWindowSum = new Float32Array(this.FFT_SIZE * 4);
    this.outputHead      = 0;  // write pointer (advanced by HOP_SIZE per STFT frame)

    // [BUG 3 FIX] dedicated drain pointer advanced 128 samples per render.
    // Replaces the broken (outputTail - RENDER + i) expression.
    this.drainHead = 0;

    this.hopsSinceInit = 0; // latency guard: mute output until first full FFT window

    // Reusable FFT scratch buffers — allocated once, reused every frame.
    // ORDER LOCK: _forwardSTFTFrame() populates fftReal/fftImag via forward FFT.
    //             fallbackMag MUST be computed from these arrays BEFORE
    //             _inverseSTFTFrame() is called, because iFFT overwrites them.
    this.fftReal = new Float32Array(this.FFT_SIZE);
    this.fftImag = new Float32Array(this.FFT_SIZE);

    // Hot-path scratch buffers — reused every hop to avoid ~600KB/s GC churn
    // at 48kHz/1024-hop. Resized together with fftReal/fftImag when FFT_SIZE
    // is renegotiated via 'initRingBuffers'.
    this._frameScratch    = new Float32Array(this.FFT_SIZE);
    this._phaseScratch    = new Float32Array(this.HALF_N);
    this._fallbackMagScratch = new Float32Array(this.HALF_N);

    // Hann window (precomputed)
    this.window = hannWindow(this.FFT_SIZE);

    // SharedArrayBuffer ring views (populated via 'initRingBuffers' message)
    this.inputSAB  = null;  // Float32Array[HALF_N*2]: [mag | phase], written by worklet
    this.outputSAB = null;  // Float32Array[HALF_N]:   [mag],          written by ML Worker
    this.ctrlIn    = null;  // Int32Array[4] control for inputSAB
    this.ctrlOut   = null;  // Int32Array[4] control for outputSAB

    // Gate / dynamics state
    this.gateEnv     = 0;
    this.holdCounter = 0;

    // User-adjustable params
    this.params = {
      gateThresh:      -42,
      gateRange:       -40,
      gateAttack:        2,
      gateRelease:      80,
      gateHold:         20,
      outGain:           0,
      dryWet:          100,
      spectralFloor: 0.005,
      harmonicEnhance:   0,
      bypass:        false,
    };

    this.harmonicEnhancer = new HarmonicEnhancer(0);

    // Cached gate coefficients — recomputed only when relevant params change.
    this._attackCoeff = 0;
    this._relCoeff    = 0;
    this._holdSamps   = 0;
    this._threshLin   = 0;
    this._rangeLin    = 0;
    this._outGainLin  = 1;
    this._recomputeGateCoeffs();

    this.port.onmessage = ({ data }) => this._onMessage(data);
  }

  _recomputeGateCoeffs() {
    const p = this.params;
    this._attackCoeff = Math.exp(-1 / (p.gateAttack  * 0.001 * sampleRate));
    this._relCoeff    = Math.exp(-1 / (p.gateRelease * 0.001 * sampleRate));
    this._holdSamps   = Math.floor(p.gateHold * 0.001 * sampleRate);
    this._outGainLin  = Math.pow(10, p.outGain / 20);
  }

  // ─── Message Handler ───────────────────────────────────────────────────
  _onMessage(msg) {
    switch (msg.type) {

      case 'initRingBuffers': {
        this.FFT_SIZE = msg.fftSize  || this.FFT_SIZE;
        this.HOP_SIZE = msg.hopSize  || this.HOP_SIZE;
        this.HALF_N   = Math.floor(this.FFT_SIZE / 2) + 1;
        this.window   = hannWindow(this.FFT_SIZE);
        this.fftReal  = new Float32Array(this.FFT_SIZE);
        this.fftImag  = new Float32Array(this.FFT_SIZE);
        this._frameScratch       = new Float32Array(this.FFT_SIZE);
        this._phaseScratch       = new Float32Array(this.HALF_N);
        this._fallbackMagScratch = new Float32Array(this.HALF_N);
        // Re-size accumulation buffers if FFT_SIZE changed
        this.inputAccum      = new Float32Array(this.FFT_SIZE * 4);
        this.outputAccum     = new Float32Array(this.FFT_SIZE * 4);
        this.outputWindowSum = new Float32Array(this.FFT_SIZE * 4);
        // Reset all pointers on reinit
        this.inputHead = 0;
        this.inputProcessed = 0;
        this.outputHead = 0;
        this.drainHead = 0;
        this.hopsSinceInit = 0;

        if (msg.inputSAB) {
          const inputBytes = Int32Array.BYTES_PER_ELEMENT * 4
            + Float32Array.BYTES_PER_ELEMENT * this.HALF_N * 2;
          if (msg.inputSAB.byteLength < inputBytes) {
            this.port.postMessage({ type: 'error', msg: `inputSAB size mismatch: expected >= ${inputBytes}, got ${msg.inputSAB.byteLength}` });
            break;
          }
          this.ctrlIn   = new Int32Array(msg.inputSAB, 0, 4);
          this.inputSAB = new Float32Array(msg.inputSAB, 16, this.HALF_N * 2);
        }
        if (msg.outputSAB) {
          const outputBytes = Int32Array.BYTES_PER_ELEMENT * 4
            + Float32Array.BYTES_PER_ELEMENT * this.HALF_N;
          if (msg.outputSAB.byteLength < outputBytes) {
            this.port.postMessage({ type: 'error', msg: `outputSAB size mismatch: expected >= ${outputBytes}, got ${msg.outputSAB.byteLength}` });
            break;
          }
          this.ctrlOut   = new Int32Array(msg.outputSAB, 0, 4);
          this.outputSAB = new Float32Array(msg.outputSAB, 16, this.HALF_N);
        }
        this.port.postMessage({
          type: 'ready',
          fftSize: this.FFT_SIZE,
          hopSize: this.HOP_SIZE,
          halfN: this.HALF_N
        });
        break;
      }

      case 'param':
        if (msg.key in this.params) {
          this.params[msg.key] = msg.value;
          if (msg.key === 'harmonicEnhance') this.harmonicEnhancer.setAmount(msg.value);
          if (msg.key === 'gateAttack' || msg.key === 'gateRelease' ||
              msg.key === 'gateHold'   || msg.key === 'outGain') {
            this._recomputeGateCoeffs();
          }
        }
        break;

      case 'paramBulk':
        for (const [k, v] of Object.entries(msg.params)) {
          if (k in this.params) {
            this.params[k] = v;
            if (k === 'harmonicEnhance') this.harmonicEnhancer.setAmount(v);
          }
        }
        this._recomputeGateCoeffs();
        break;

      case 'bypass':
        this.params.bypass = !!msg.value;
        break;
    }
  }

  // ─── Single Forward STFT Frame ─────────────────────────────────────────
  // Populates fftReal[] and fftImag[] via in-place FFT.
  // Writes HALF_N magnitudes then HALF_N phases into inputSAB.
  // Returns the cached phase scratch buffer so the caller can reconstruct
  // the spectrum after iFFT clobbers fftReal/fftImag. The buffer is owned
  // by the processor and must be consumed before the next STFT frame.
  _forwardSTFTFrame(audioData) {
    const N = this.FFT_SIZE;
    const halfN = this.HALF_N;
    const real = this.fftReal;
    const imag = this.fftImag;
    const w    = this.window;

    const audioLen = audioData.length;
    const copyLen  = audioLen < N ? audioLen : N;
    for (let i = 0; i < copyLen; i++) {
      real[i] = audioData[i] * w[i];
      imag[i] = 0;
    }
    for (let i = copyLen; i < N; i++) {
      real[i] = 0;
      imag[i] = 0;
    }

    // ── SINGLE FORWARD FFT ──
    fft(real, imag, false);

    const phase = this._phaseScratch;
    if (this.inputSAB) {
      for (let k = 0; k < halfN; k++) {
        const re = real[k];
        const im = imag[k];
        const mag = Math.sqrt(re * re + im * im);
        const ph  = Math.atan2(im, re);
        this.inputSAB[k]         = mag;
        this.inputSAB[halfN + k] = ph;
        phase[k]                 = ph;
      }
      Atomics.store(this.ctrlIn, 2, 1);
      Atomics.notify(this.ctrlIn, 2, 1);
    } else {
      for (let k = 0; k < halfN; k++) {
        phase[k] = Math.atan2(imag[k], real[k]);
      }
    }

    return phase;
  }

  // ─── Single Inverse STFT Frame ─────────────────────────────────────────
  // NOTE: This method OVERWRITES fftReal[] and fftImag[] with iFFT output.
  //       Caller MUST have already computed fallbackMag from those arrays
  //       (which _forwardSTFTFrame populated) BEFORE calling this.
  //       See ORDER LOCK comment in constructor.
  _inverseSTFTFrame(phase, fallbackMag) {
    const N     = this.FFT_SIZE;
    const halfN = this.HALF_N;
    const real  = this.fftReal;
    const imag  = this.fftImag;
    const w     = this.window;

    let magArr = fallbackMag;
    if (this.outputSAB && Atomics.load(this.ctrlOut, 2) === 1) {
      magArr = this.outputSAB.subarray(0, halfN);
      Atomics.store(this.ctrlOut, 2, 0);
    }

    for (let k = 0; k < halfN; k++) {
      const m = magArr ? magArr[k] : 0;
      real[k] = m * Math.cos(phase[k]);
      imag[k] = m * Math.sin(phase[k]);
    }
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
      this.outputAccum[idx]     += real[i] * w[i];
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

    const RENDER = 128;

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

    // ── 2. Run STFT frames whenever a full hop of NEW input is available ──
    // [BUG 1 FIX] Use inputProcessed (not outputHead/outputTail) to track
    // how many samples have been fed through the STFT pipeline.
    while (this.inputHead - this.inputProcessed >= this.HOP_SIZE) {
      // Gather newest FFT_SIZE samples (the analysis frame) into a reusable
      // scratch buffer. Splitting into three regions removes a per-sample
      // branch on (base + i >= 0).
      const frame = this._frameScratch;
      const N     = this.FFT_SIZE;
      const base  = this.inputProcessed + this.HOP_SIZE - N;
      const zeroPrefix = base < 0 ? -base : 0;
      for (let i = 0; i < zeroPrefix; i++) frame[i] = 0;
      for (let i = zeroPrefix; i < N; i++) {
        frame[i] = this.inputAccum[(base + i) % accumLen];
      }

      // [ORDER LOCK — Bug 2]: _forwardSTFTFrame populates fftReal/fftImag.
      // fallbackMag MUST be extracted from those arrays NOW, before
      // _inverseSTFTFrame clobbers them with iFFT output.
      const fwdPhase = this._forwardSTFTFrame(frame);

      const halfN = this.HALF_N;
      const fallbackMag = this._fallbackMagScratch;
      for (let k = 0; k < halfN; k++) {
        const re = this.fftReal[k];
        const im = this.fftImag[k];
        fallbackMag[k] = Math.sqrt(re * re + im * im);
      }
      // fftReal/fftImag may now be safely overwritten by iFFT below.

      this._inverseSTFTFrame(fwdPhase, fallbackMag);

      // [BUG 1 FIX] Advance the input-processed pointer, not outputTail.
      this.inputProcessed += this.HOP_SIZE;
    }

    // ── 3. Gate + dynamics params ─────────────────────────────────────────
    const p = this.params;
    const threshLin   = Math.pow(10, p.gateThresh / 20);
    const rangeLin    = Math.pow(10, p.gateRange  / 20);
    const attackCoeff = this._attackCoeff;
    const relCoeff    = this._relCoeff;
    const holdSamps   = this._holdSamps;
    const outGainLin  = this._outGainLin;
    const wet = p.dryWet / 100;
    const dry = 1 - wet;

    // ── 4. Drain outputAccum → output buffer ─────────────────────────────
    // [BUG 3 FIX] Use drainHead as the ring read pointer, advanced by
    // RENDER each quantum. Previous code used (outputTail - RENDER + i)
    // which was off by (HOP_SIZE - RENDER) = 896 samples.
    const oLen = this.outputAccum.length;
    // Minimum latency: mute until we have collected at least one full FFT_SIZE
    // worth of STFT frames. hopsSinceInit increments each iFFT call.
    const latencyHops = Math.ceil(this.FFT_SIZE / this.HOP_SIZE); // = 4

    for (let i = 0; i < RENDER; i++) {
      // [BUG 5 FIX] Advance drainHead even during mute window so the ring
      // doesn't stall. Output zero but still consume the slot.
      const idx = this.drainHead % oLen;

      if (this.hopsSinceInit < latencyHops) {
        // Still in latency window — output silence, clear slot, advance
        this.outputAccum[idx]     = 0;
        this.outputWindowSum[idx] = 0;
        this.drainHead++;
        outBuf[i] = 0;
        continue;
      }

      // Stricter underflow guard: Hann window edges can legitimately produce
      // wsum values well below 1e-8 without being degenerate, so the old
      // threshold silenced valid edge samples and caused intermittent clicks
      // at frame boundaries. 1e-12 acts as a near-zero guard, rejecting
      // only numerically tiny overlap sums that are unsafe to normalize.
      const wsum   = this.outputWindowSum[idx];
      let   sample = wsum > 1e-12 ? this.outputAccum[idx] / wsum : 0;

      // Clear consumed slot
      this.outputAccum[idx]     = 0;
      this.outputWindowSum[idx] = 0;
      this.drainHead++;

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
