/* ============================================
   VoiceIsolate Pro — AudioWorkletProcessor
   Threads from Space v8 · Real-Time Live Mode
   Single-Pass STFT via SharedArrayBuffer bridge
   STFT happens HERE (worklet side) for framing;
   spectral masking via ML output from main thread.

   PATCH LOG (April 13 2026 — Audit Fix PR):
   - Bug 1: inputProcessed pointer replaces broken outputHead/outputTail
             condition in the STFT while-loop
   - Bug 2: order-lock comment before _inverseSTFTFrame (scratch buffer safety)
   - Bug 3: drainHead pointer replaces (outputTail - RENDER + i) drain formula
   - Issue 5: latency guard now advances drainHead so ring never stalls
   - Issue 6: initRingBuffers fully resets ALL overlap-add ring state
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
// Harmonic enhancer (post-gate, pre-mix)
// Normalization: tanh(drive*x)/tanh(drive) preserves ±1 ceiling
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
//     ├─ When inputAccum has ≥ HOP_SIZE new unprocessed samples
//     │    (tracked by inputProcessed — Bug 1 fix):
//     │    • Copies newest FFT_SIZE samples into a windowed frame
//     │    • Runs single Forward FFT  → writes mag+phase to inputSAB
//     │    • Atomics.notify wakes ML Worker on main thread
//     │    • Reads processed spectral frame (mag only) from outputSAB
//     │    • Runs single Inverse FFT (iFFT) → overlap-adds to outputAccum
//     │    • NOTE (Bug 2): fallbackMag is copied BEFORE _inverseSTFTFrame
//     │      because iFFT clobbers fftReal/fftImag in-place. Do not reorder.
//     └─ Drains 128 samples from outputAccum using drainHead (Bug 3 fix)
//
// SharedArrayBuffer layout (both inputSAB and outputSAB):
//   [0]  Int32 writeIdx   (reserved)
//   [1]  Int32 readIdx    (reserved)
//   [2]  Int32 frameReady (0|1 flag, Atomics.notify target)
//   [3]  Int32 overruns   (reserved)
//   [16..16+capacity*4]  Float32Array payload
// ---------------------------------------------------------------------------
class VoiceIsolateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // DSP constants
    this.FFT_SIZE = 4096;
    this.HOP_SIZE = 1024;
    this.HALF_N   = this.FFT_SIZE / 2 + 1;

    // Overlap-add accumulation buffers (4× FFT_SIZE headroom)
    this.inputAccum  = new Float32Array(this.FFT_SIZE * 4);
    this.inputHead   = 0;  // write pointer into inputAccum (absolute sample count)

    // BUG 1 FIX: inputProcessed tracks how many input samples have been
    // consumed by completed STFT hops. The while-loop condition compares
    // inputHead - inputProcessed >= HOP_SIZE, which is the correct and
    // stable way to schedule hops without mixing in output pointers.
    this.inputProcessed = 0;

    this.outputAccum     = new Float32Array(this.FFT_SIZE * 4);
    this.outputWindowSum = new Float32Array(this.FFT_SIZE * 4);
    this.outputHead      = 0; // write pointer for overlap-add (not used in drain)

    // BUG 3 FIX: drainHead is the dedicated read pointer for the output drain
    // section. It advances by exactly RENDER (128) samples per process() call,
    // independent of hop scheduling. The old formula used
    // (outputTail - RENDER + i) which was tied to hop scheduling and read
    // from the wrong ring position (896 samples behind at HOP_SIZE=1024).
    this.drainHead = 0;

    this.hopsSinceInit = 0; // latency compensation: silence until first iFFT

    // Reusable FFT scratch buffers (avoid per-frame alloc in hot path)
    // ORDER LOCK (Bug 2): fallbackMag must be copied from these buffers
    // AFTER _forwardSTFTFrame() returns and BEFORE _inverseSTFTFrame() is
    // called, because iFFT runs in-place on fftReal/fftImag and will
    // overwrite any mag data still needed for fallback.
    this.fftReal = new Float32Array(this.FFT_SIZE);
    this.fftImag = new Float32Array(this.FFT_SIZE);

    // Hann window (precomputed)
    this.window = hannWindow(this.FFT_SIZE);

    // SharedArrayBuffer ring views (set via initRingBuffers message)
    this.inputSAB  = null;  // Float32Array[HALF_N*2] — mag+phase, written by worklet
    this.outputSAB = null;  // Float32Array[HALF_N]   — processed mag, written by worker
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

    this.port.onmessage = ({ data }) => this._onMessage(data);
  }

  // ─── Message Handler ───────────────────────────────────────────────────
  _onMessage(msg) {
    switch (msg.type) {

      case 'initRingBuffers': {
        // ISSUE 6 FIX: Fully reset ALL overlap-add and ring state when
        // fftSize/hopSize change, not just the FFT scratch buffers.
        // Previously, inputAccum, outputAccum, drainHead, inputProcessed,
        // and hopsSinceInit were left stale after a reinit, causing
        // overlap-add corruption on the new buffer dimensions.
        this.FFT_SIZE = msg.fftSize || this.FFT_SIZE;
        this.HOP_SIZE = msg.hopSize || this.HOP_SIZE;
        this.HALF_N   = this.FFT_SIZE / 2 + 1;
        this.window   = hannWindow(this.FFT_SIZE);
        this.fftReal  = new Float32Array(this.FFT_SIZE);
        this.fftImag  = new Float32Array(this.FFT_SIZE);

        // Full ring reset
        this.inputAccum      = new Float32Array(this.FFT_SIZE * 4);
        this.outputAccum     = new Float32Array(this.FFT_SIZE * 4);
        this.outputWindowSum = new Float32Array(this.FFT_SIZE * 4);
        this.inputHead       = 0;
        this.inputProcessed  = 0;
        this.outputHead      = 0;
        this.drainHead       = 0;
        this.hopsSinceInit   = 0;
        this.gateEnv         = 0;
        this.holdCounter     = 0;

        if (msg.inputSAB) {
          this.ctrlIn   = new Int32Array(msg.inputSAB, 0, 4);
          this.inputSAB = new Float32Array(msg.inputSAB, 16, this.HALF_N * 2);
        }
        if (msg.outputSAB) {
          this.ctrlOut   = new Int32Array(msg.outputSAB, 0, 4);
          this.outputSAB = new Float32Array(msg.outputSAB, 16, this.HALF_N);
        }
        this.port.postMessage({ type: 'ready' });
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
  // Writes HALF_N magnitudes then HALF_N phases into inputSAB.
  // Returns phase array (Float32Array view of HALF_N) for iFFT reconstruction.
  // IMPORTANT (Bug 2 order lock): caller must copy fallbackMag from
  // fftReal/fftImag immediately after this returns and BEFORE calling
  // _inverseSTFTFrame, because iFFT runs in-place on the same scratch arrays.
  _forwardSTFTFrame(audioData) {
    const N = this.FFT_SIZE;
    const halfN = this.HALF_N;
    const real = this.fftReal;
    const imag = this.fftImag;
    const w    = this.window;

    for (let i = 0; i < N; i++) {
      real[i] = (i < audioData.length) ? audioData[i] * w[i] : 0;
      imag[i] = 0;
    }

    // ── SINGLE FORWARD FFT (one per hop — architectural constraint) ──
    fft(real, imag, false);

    const phase = new Float32Array(halfN);
    if (this.inputSAB) {
      for (let k = 0; k < halfN; k++) {
        const mag = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
        this.inputSAB[k]         = mag;
        this.inputSAB[halfN + k] = Math.atan2(imag[k], real[k]);
        phase[k] = this.inputSAB[halfN + k];
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
  // Reads processed magnitudes from outputSAB (or falls back to fallbackMag).
  // Reconstructs complex spectrum using the original forward phase.
  // Overlap-adds result into outputAccum.
  // NOTE (Bug 2): This clobbers fftReal/fftImag in-place via iFFT.
  // fallbackMag MUST be a separate Float32Array copy, not a view of fftReal/fftImag.
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

    // ── SINGLE INVERSE FFT (one per hop — architectural constraint) ──
    fft(real, imag, true);

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

    // ── 2. Run STFT frames whenever we have a full unprocessed hop ────────
    // BUG 1 FIX: inputProcessed is the number of input samples that have
    // already been used to start a hop. The condition
    //   inputHead - inputProcessed >= HOP_SIZE
    // is stable and correct. The old condition mixed outputHead and
    // outputTail pointers, which caused the loop to terminate immediately
    // after the first hop, producing silence or stutter.
    while (this.inputHead - this.inputProcessed >= this.HOP_SIZE) {
      const frame = new Float32Array(this.FFT_SIZE);
      const base  = this.inputProcessed + this.HOP_SIZE - this.FFT_SIZE;
      for (let i = 0; i < this.FFT_SIZE; i++) {
        const absIdx = base + i;
        frame[i] = absIdx >= 0
          ? this.inputAccum[(absIdx) % accumLen]
          : 0;
      }

      // Forward FFT — populates fftReal/fftImag and inputSAB
      const fwdPhase = this._forwardSTFTFrame(frame);

      // BUG 2 ORDER LOCK: copy fallbackMag HERE, after forward FFT and
      // before iFFT, because _inverseSTFTFrame clobbers fftReal/fftImag.
      const halfN = this.HALF_N;
      const fallbackMag = new Float32Array(halfN);
      for (let k = 0; k < halfN; k++) {
        fallbackMag[k] = Math.sqrt(
          this.fftReal[k] * this.fftReal[k] +
          this.fftImag[k] * this.fftImag[k]
        );
      }

      // Inverse FFT — overlap-adds to outputAccum
      this._inverseSTFTFrame(fwdPhase, fallbackMag);

      // Advance inputProcessed by exactly one hop
      this.inputProcessed += this.HOP_SIZE;
    }

    // ── 3. Gate + dynamics coefficients (precomputed once per render) ─────
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
    // BUG 3 FIX: drainHead advances by RENDER (128) each process() call,
    // independent of hop scheduling. The old formula
    //   (outputTail - RENDER + i + oLen) % oLen
    // used outputTail (a hop-scheduling pointer) as the drain base, which
    // read from 896 samples behind the correct position at HOP_SIZE=1024.
    const oLen = this.outputAccum.length;
    for (let i = 0; i < RENDER; i++) {
      // ISSUE 5 FIX: During the startup latency window (first FFT_SIZE input
      const idx = (this.drainHead + i) % oLen;
      if (this.hopsSinceInit * this.HOP_SIZE < this.FFT_SIZE) {
        outBuf[i] = 0;
        this.outputAccum[idx] = 0;
        this.outputWindowSum[idx] = 0;
        continue;
      }
      const wsum = this.outputWindowSum[idx];
      let sample = wsum > 1e-8 ? this.outputAccum[idx] / wsum : 0;

      // Clear consumed slot
      this.outputAccum[idx]     = 0;
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

      // Harmonic enhancement (drive-normalized tanh)
      sample = this.harmonicEnhancer.processSample(sample);

      // Dry/wet blend + output gain
      outBuf[i] = (dry * inBuf[i] + wet * sample) * outGainLin;
    }

    // Advance drainHead by one full render quantum
    this.drainHead = (this.drainHead + RENDER) % oLen;

    return true;
  }

  static get parameterDescriptors() { return []; }
}

registerProcessor('voice-isolate-processor', VoiceIsolateProcessor);
