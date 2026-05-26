/**
 * VoiceIsolate Pro — voice-isolate-processor.js
 * Live AudioWorkletProcessor — primary real-time engine (v26)
 * ==========================================================
 *
 * Pipeline:
 *   process() (every 128 samples):
 *     1. Push input samples into inputAccum ring → inputHead advances by RENDER
 *     2. While (inputHead - inputProcessed) >= HOP_SIZE:
 *          a. Analysis-window an FFT_SIZE slice starting at inputProcessed
 *          b. SINGLE forward FFT
 *          c. Apply mask from ML output SAB (or classical fallback)
 *          d. SINGLE inverse FFT (in-place)
 *          e. Synthesis-window + overlap-add into outputAccum
 *             AND accumulate w*w into outputWindowSum (PATCH 2)
 *             advance outputHead by HOP_SIZE
 *          f. inputProcessed += HOP_SIZE
 *          g. hopsSinceInit += 1
 *     3. If startup hasn't accumulated FFT_SIZE samples of analysis, output silence
 *     4. Drain RENDER samples from outputAccum starting at drainHead,
 *        normalise per-sample by outputWindowSum (correct OLA denominator)
 *        then drainHead += RENDER
 *
 * Single-pass invariant: exactly one forward FFT and one inverse FFT per frame.
 *
 * Ring-buffer pointer separation (PR #428 lock):
 *   - inputProcessed (hop accountant) is decoupled from outputHead/outputTail
 *     → fixes a hang that mixed those counters in the while-loop condition.
 *   - drainHead is its own pointer
 *     → fixes a 896-sample misalignment from `outputTail - RENDER` indexing.
 *   - hopsSinceInit gates drain during the muted warmup window.
 *
 * SAB protocol — FLAG_SLOTS=5 matches dsp-processor.js and ml-worker.js exactly:
 *   inputSAB:
 *     [0..19]  Int32 flags (5 slots × 4 bytes): [writeGen, readGen, capacity, halfN, reserved]
 *     [20..]   Float32 mag (HALF_BINS) then pha (HALF_BINS)
 *   outputSAB:
 *     [0..19]  Int32 flags (5 slots × 4 bytes): [writeGen, readGen, capacity, halfN, reserved]
 *     [20..]   Float32 mask (HALF_BINS, 0..1)
 *
 * PATCHES applied (2026-05-26):
 *   [P1] FLAG_SLOTS: 4 → 5 (SAB_HEADER_BYTES: 16 → 20)
 *        Without this, _inputView/outputView were offset 4 bytes into the
 *        payload, silently reading junk mag/mask data on every frame.
 *   [P2] outputWindowSum now accumulated in _processFrame (w*w per sample).
 *        Previously _processFrame wrote outputAccum but never wrote
 *        outputWindowSum, so the drain loop always fell back to the fixed
 *        OLA_NORM scalar. Now it uses the per-sample window-sum denominator
 *        for correct energy-preserving OLA at 75% overlap.
 */

const FFT_SIZE  = 4096;
const HOP_SIZE  = 1024;
const RENDER    = 128;
const HALF_BINS = FFT_SIZE / 2 + 1;

const RING_LEN = FFT_SIZE * 4;

// PATCH 1: FLAG_SLOTS 4 → 5 to match dsp-processor.js + ml-worker.js
const FLAG_SLOTS = 5;                                                  // was 4 (16 bytes) — now 5 (20 bytes)
const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS;    // 20

const OLA_NORM = 1.0 / (FFT_SIZE / (2.0 * HOP_SIZE));  // fallback scalar only

function fftInPlace(re, im, inverse) {
  const N = re.length;
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const ang  = (inverse ? 2 : -2) * Math.PI / len;
    const wRe  = Math.cos(ang);
    const wIm  = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + half] * cRe - im[i + k + half] * cIm;
        const vIm = re[i + k + half] * cIm + im[i + k + half] * cRe;
        re[i + k]        = uRe + vRe;
        im[i + k]        = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nr = cRe * wRe - cIm * wIm;
        cIm      = cRe * wIm + cIm * wRe;
        cRe      = nr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }
}

function makePeriodicHann(N) {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / N));
  }
  return w;
}

class VoiceIsolateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this.FFT_SIZE = FFT_SIZE;
    this.HOP_SIZE = HOP_SIZE;
    this.RENDER   = RENDER;

    this._win = makePeriodicHann(FFT_SIZE);
    this._re  = new Float32Array(FFT_SIZE);
    this._im  = new Float32Array(FFT_SIZE);

    this.initRingBuffers();

    this._inputSAB    = null;
    this._outputSAB   = null;
    this._inputFlags  = null;
    this._outputFlags = null;
    this._inputView   = null;
    this._outputView  = null;

    this._params = {
      outGain:    0.0,
      dryWet:     1.0,
      nrAmount:   0.78,
      gateThresh: -42,
      gateRange:  -60,
      limThresh:  -1.0,
    };

    this.gateEnv     = 0;
    this.holdCounter = 0;

    this.port.onmessage = (ev) => this._onMessage(ev.data);
  }

  initRingBuffers() {
    this.inputAccum      = new Float32Array(RING_LEN);
    this.outputAccum     = new Float32Array(RING_LEN);
    this.outputWindowSum = new Float32Array(RING_LEN);  // PATCH 2: populated in _processFrame
    this.inputHead       = 0;
    this.inputProcessed  = 0;
    this.outputHead      = 0;
    this.drainHead       = 0;
    this.hopsSinceInit   = 0;
    this.gateEnv         = 0;
    this.holdCounter     = 0;
  }

  _onMessage(msg) {
    if (!msg) return;
    switch (msg.type) {
      case 'initSAB': {
        this._inputSAB    = msg.inputSAB;
        this._outputSAB   = msg.outputSAB;
        this._inputFlags  = new Int32Array(this._inputSAB,  0, FLAG_SLOTS);
        this._outputFlags = new Int32Array(this._outputSAB, 0, FLAG_SLOTS);
        this._inputView   = new Float32Array(this._inputSAB,  SAB_HEADER_BYTES, HALF_BINS * 2);
        this._outputView  = new Float32Array(this._outputSAB, SAB_HEADER_BYTES, HALF_BINS);
        this.port.postMessage({ type: 'sabReady', inputSAB: this._inputSAB, outputSAB: this._outputSAB });
        break;
      }
      case 'setParams':
      case 'params': {
        // Accept both 'params' and 'setParams' to match dsp-processor.js protocol
        const payload = msg.payload || msg.params;
        if (payload) {
          for (const [k, v] of Object.entries(payload)) {
            if (k in this._params) {
              const val = Number(v);
              if (Number.isFinite(val)) this._params[k] = val;
            }
          }
        }
        break;
      }
      case 'reset': {
        this.initRingBuffers();
        break;
      }
    }
  }

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const outBuf = output[0];
    const Q      = outBuf.length;

    if (input && input[0]) {
      const numCh = input.length;
      for (let i = 0; i < Q; i++) {
        let s = 0;
        for (let c = 0; c < numCh; c++) s += input[c][i];
        if (numCh > 1) s /= numCh;
        this.inputAccum[(this.inputHead + i) % RING_LEN] = s;
      }
    } else {
      for (let i = 0; i < Q; i++) {
        this.inputAccum[(this.inputHead + i) % RING_LEN] = 0;
      }
    }
    this.inputHead = (this.inputHead + Q) % RING_LEN;

    // Hop accounting — uses inputProcessed (NOT outputHead/outputTail) so the
    // ring keeps moving even when output drain stalls.
    const inputAbs = this._absInputHead();
    while (inputAbs - this.inputProcessed >= HOP_SIZE) {
      this._processFrame(this.inputProcessed % RING_LEN);
      this.inputProcessed += HOP_SIZE;
      this.hopsSinceInit  += 1;
    }

    // Warmup guard — during the first FFT_SIZE samples we have no valid output
    // yet. Advance drainHead anyway so the ring doesn't stall when audio resumes.
    if (this.hopsSinceInit * HOP_SIZE < FFT_SIZE) {
      outBuf.fill(0);
      for (let c = 1; c < output.length; c++) output[c].fill(0);
      this.drainHead = (this.drainHead + RENDER) % RING_LEN;
      return true;
    }

    const outGain = Math.pow(10, (this._params.outGain || 0) / 20);
    const lim     = Math.pow(10, (this._params.limThresh || -1) / 20);

    for (let i = 0; i < Q; i++) {
      const idx  = (this.drainHead + i) % RING_LEN;
      const wSum = this.outputWindowSum[idx];
      // PATCH 2: use accumulated window-sum denominator; fall back to scalar only
      // if outputWindowSum is empty (should not happen after warmup).
      const norm = wSum > 1e-8 ? (1.0 / wSum) : OLA_NORM;
      let s = this.outputAccum[idx] * norm * outGain;
      this.outputAccum[idx]     = 0;
      this.outputWindowSum[idx] = 0;
      if (s >  lim) s =  lim;
      if (s < -lim) s = -lim;
      outBuf[i] = s;
    }
    this.drainHead = (this.drainHead + RENDER) % RING_LEN;

    for (let c = 1; c < output.length; c++) output[c].set(outBuf);

    return true;
  }

  _absInputHead() {
    // Wrap-safe absolute index of the input write head. `inputProcessed` is a
    // monotonic counter; `inputHead` is a ring index. We compute the absolute
    // position of inputHead relative to inputProcessed by walking modulo.
    const base = this.inputProcessed - (this.inputProcessed % RING_LEN);
    let abs = base + this.inputHead;
    if (abs < this.inputProcessed) abs += RING_LEN;
    return abs;
  }

  _processFrame(frameStart) {
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (frameStart + i) % RING_LEN;
      this._re[i] = this.inputAccum[idx] * this._win[i];
      this._im[i] = 0;
    }

    // ── SINGLE FORWARD STFT ─────────────────────────────────────────────────
    fftInPlace(this._re, this._im, false);

    const mag = new Float32Array(HALF_BINS);
    const pha = new Float32Array(HALF_BINS);
    for (let k = 0; k < HALF_BINS; k++) {
      mag[k] = Math.sqrt(this._re[k] * this._re[k] + this._im[k] * this._im[k]);
      pha[k] = Math.atan2(this._im[k], this._re[k]);
    }

    let mask = null;
    if (this._outputView && this._outputFlags) {
      const writeGen = Atomics.load(this._outputFlags, 0);
      const readGen  = Atomics.load(this._outputFlags, 1);
      if (writeGen !== readGen) {
        mask = new Float32Array(HALF_BINS);
        mask.set(this._outputView.subarray(0, HALF_BINS));
        Atomics.store(this._outputFlags, 1, writeGen);
      }
    }

    if (this._inputView && this._inputFlags) {
      this._inputView.set(mag, 0);
      this._inputView.set(pha, HALF_BINS);
      Atomics.add(this._inputFlags, 0, 1);
    }

    const maskedMag = new Float32Array(HALF_BINS);
    if (mask) {
      for (let k = 0; k < HALF_BINS; k++) {
        maskedMag[k] = mag[k] * Math.max(0, Math.min(1, mask[k]));
      }
    } else {
      const alpha = this._params.nrAmount || 0;
      const factor = Math.max(0, 1 - alpha * 0.5);
      for (let k = 0; k < HALF_BINS; k++) maskedMag[k] = mag[k] * factor;
    }

    this._re[0] = maskedMag[0] * Math.cos(pha[0]);
    this._im[0] = 0;
    for (let k = 1; k < HALF_BINS - 1; k++) {
      const r = maskedMag[k];
      const p = pha[k];
      const re =  r * Math.cos(p);
      const im =  r * Math.sin(p);
      this._re[k]            =  re;
      this._im[k]            =  im;
      this._re[FFT_SIZE - k] =  re;
      this._im[FFT_SIZE - k] = -im;
    }
    const nyq = HALF_BINS - 1;
    this._re[nyq] = maskedMag[nyq] * Math.cos(pha[nyq]);
    this._im[nyq] = 0;

    // ── SINGLE INVERSE STFT ─────────────────────────────────────────────────
    fftInPlace(this._re, this._im, true);

    // PATCH 2: accumulate both the time-domain sample AND the squared window
    // value into outputWindowSum so the drain loop can apply the per-sample
    // WOLA denominator instead of the fixed scalar.
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (this.outputHead + i) % RING_LEN;
      const w   = this._win[i];
      this.outputAccum[idx]     += this._re[i] * w;
      this.outputWindowSum[idx] += w * w;           // ← was missing before PATCH 2
    }
    this.outputHead = (this.outputHead + HOP_SIZE) % RING_LEN;
  }
}

registerProcessor('voice-isolate-processor', VoiceIsolateProcessor);
