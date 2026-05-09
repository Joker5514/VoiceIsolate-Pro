/**
 * VoiceIsolate Pro — dsp-processor.js
 * AudioWorkletProcessor: Threads from Space v8
 * ==========================================================
 * Architecture:
 *   1. Accumulate 128-sample quanta into a 4096-pt ring buffer
 *   2. When ring is full: apply Hann window + in-place FFT (single forward STFT)
 *   3. Post magnitude frame via SharedArrayBuffer to main thread
 *      (main thread routes it to ml-worker.js for ONNX inference)
 *   4. Read mask back from output SAB (written by ml-worker)
 *   5. Apply mask to magnitude in-place, reconstruct phase
 *   6. Single inverse FFT (iSTFT) → overlap-add to output ring
 *   7. Drain 128 samples per quantum to AudioWorklet output
 *
 * SharedArrayBuffer layout (Int32 header + Float32 payload):
 *   [0] writeIdx   — producer increments after each write
 *   [1] readIdx    — consumer increments after each read
 *   [2] capacity   — ring slots (set at init)
 *   [3] halfN      — FFT bins (FFT_SIZE/2+1)
 *   [SAB_HEADER_BYTES .. +halfN*2*4] — interleaved re/im per frame (input SAB)
 *   [SAB_HEADER_BYTES .. +halfN*4]   — mask magnitudes (output SAB)
 */

const FFT_SIZE   = 4096;
const HOP_SIZE   = 1024;
const HALF_BINS  = FFT_SIZE / 2 + 1;
const FLAG_SLOTS = 4;
const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS;

// ─── Tiny in-place Cooley-Tukey FFT (no import needed in worklet) ────────────
function fftInPlace(re, im, inverse = false) {
  const N = re.length;
  // bit-reversal
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // butterfly
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const ang  = (inverse ? 2 : -2) * Math.PI / len;
    const wRe  = Math.cos(ang);
    const wIm  = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i+k],          uIm = im[i+k];
        const vRe = re[i+k+half]*cRe - im[i+k+half]*cIm;
        const vIm = re[i+k+half]*cIm + im[i+k+half]*cRe;
        re[i+k]        = uRe + vRe;  im[i+k]        = uIm + vIm;
        re[i+k+half]   = uRe - vRe;  im[i+k+half]   = uIm - vIm;
        const nr = cRe*wRe - cIm*wIm;
        cIm      = cRe*wIm + cIm*wRe;
        cRe      = nr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }
}

function makeHannWindow(N) {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }
  return w;
}

class DSPProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this._re  = new Float32Array(FFT_SIZE);
    this._im  = new Float32Array(FFT_SIZE);
    this._win = makeHannWindow(FFT_SIZE);

    // Ring buffers (audio domain, not SAB)
    this._inRing  = new Float32Array(FFT_SIZE * 2);
    this._outRing = new Float32Array(FFT_SIZE * 4);
    this._inWr  = 0;
    this._outRd = 0;
    this._outWr = 0;
    this._filled = 0; // samples in input ring

    // SABs — set via port message
    this._inputSAB  = null;
    this._outputSAB = null;
    this._inputFlags  = null;
    this._outputFlags = null;
    this._inputView   = null; // Float32 re+im
    this._outputView  = null; // Float32 mask

    // DSP params (updated via port)
    this._params = {
      outGain:      1.0,
      dryWet:       1.0,
      nrAmount:     0.78,
      gateThresh:   -42,
      gateRange:    -60,
      hpFreq:       80,
      lpFreq:       18000,
      compThresh:   -24,
      compRatio:    4,
      compAttack:   10,
      compRelease:  150,
      compMakeup:   0,
      limThresh:    -1,
    };

    // Compressor state
    this._envDb = -96;
    this._gainDb = 0;

    this.port.onmessage = (ev) => this._onMessage(ev.data);
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
        // signal main thread that SABs are live
        this.port.postMessage({ type: 'sabReady', inputSAB: this._inputSAB, outputSAB: this._outputSAB });
        break;
      }
      case 'params': {
        if (msg.payload) {
          for (const [k, v] of Object.entries(msg.payload)) {
            if (k in this._params) this._params[k] = Number(v);
          }
        }
        break;
      }
    }
  }

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const inCh  = input[0];
    const outCh = output[0];
    const Q = inCh.length; // 128

    // Gate check — skip processing if below threshold
    let rms = 0;
    for (let i = 0; i < Q; i++) rms += inCh[i] * inCh[i];
    rms = Math.sqrt(rms / Q);
    const rmsDb = rms > 0 ? 20 * Math.log10(rms) : -160;
    const gated = rmsDb < this._params.gateThresh;

    // Accumulate into input ring
    for (let i = 0; i < Q; i++) {
      this._inRing[this._inWr] = gated ? 0 : inCh[i];
      this._inWr = (this._inWr + 1) % this._inRing.length;
    }
    this._filled += Q;

    // Process when we have a full FFT frame
    if (this._filled >= FFT_SIZE) {
      this._processFrame();
      this._filled -= HOP_SIZE;
    }

    // Drain output ring → output channel
    const avail = (this._outWr - this._outRd + this._outRing.length) % this._outRing.length;
    const outGain = Math.pow(10, (this._params.outGain || 0) / 20);
    if (avail >= Q) {
      for (let i = 0; i < Q; i++) {
        let s = this._outRing[this._outRd] * outGain;
        // Brickwall limiter
        const lim = Math.pow(10, (this._params.limThresh || -1) / 20);
        if (s >  lim) s =  lim;
        if (s < -lim) s = -lim;
        outCh[i]  = s;
        this._outRd = (this._outRd + 1) % this._outRing.length;
      }
    } else {
      // Not enough data yet — output silence
      for (let i = 0; i < Q; i++) outCh[i] = 0;
    }

    return true;
  }

  _processFrame() {
    // Copy FFT_SIZE samples from input ring into re/im
    const ringLen = this._inRing.length;
    const start   = (this._inWr - this._filled + ringLen) % ringLen;

    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (start + i) % ringLen;
      this._re[i] = this._inRing[idx] * this._win[i];
      this._im[i] = 0;
    }

    // ── SINGLE FORWARD STFT ─────────────────────────────────────────────
    fftInPlace(this._re, this._im, false);

    // Compute magnitude spectrum
    const mag = new Float32Array(HALF_BINS);
    const pha = new Float32Array(HALF_BINS);
    for (let k = 0; k < HALF_BINS; k++) {
      mag[k] = Math.sqrt(this._re[k] * this._re[k] + this._im[k] * this._im[k]);
      pha[k] = Math.atan2(this._im[k], this._re[k]);
    }

    // Try to read ML mask from output SAB (non-blocking)
    let mask = null;
    if (this._outputView) {
      const readGen  = Atomics.load(this._outputFlags, 1);
      const writeGen = Atomics.load(this._outputFlags, 0);
      if (writeGen > readGen) {
        mask = new Float32Array(HALF_BINS);
        mask.set(this._outputView.slice(0, HALF_BINS));
        Atomics.store(this._outputFlags, 1, writeGen);
      }
    }

    // Post magnitude to main thread via SAB for ML inference
    if (this._inputView && this._inputFlags) {
      for (let k = 0; k < HALF_BINS; k++) {
        this._inputView[k]            = mag[k]; // re (mag)
        this._inputView[k + HALF_BINS] = pha[k]; // im (phase)
      }
      Atomics.add(this._inputFlags, 0, 1); // bump write generation
      // Also post via port for initial frames before SAB is warm
      this.port.postMessage({ type: 'magnitude', mag: mag.buffer }, [mag.buffer]);
    }

    // Apply mask (fall back to soft NR if no ML mask yet)
    if (mask) {
      for (let k = 0; k < HALF_BINS; k++) {
        const m = Math.max(0, Math.min(1, mask[k]));
        this._re[k] *= m;
        this._im[k] *= m;
        // conjugate symmetry
        if (k > 0 && k < HALF_BINS - 1) {
          this._re[FFT_SIZE - k] *= m;
          this._im[FFT_SIZE - k] *= m;
        }
      }
    } else {
      // Classical NR fallback: spectral subtraction
      const alpha = (this._params.nrAmount || 0);
      for (let k = 0; k < HALF_BINS; k++) {
        const factor = Math.max(0, 1 - alpha * 0.5);
        this._re[k] *= factor;
        this._im[k] *= factor;
        if (k > 0 && k < HALF_BINS - 1) {
          this._re[FFT_SIZE - k] *= factor;
          this._im[FFT_SIZE - k] *= factor;
        }
      }
    }

    // ── SINGLE INVERSE STFT ─────────────────────────────────────────────
    fftInPlace(this._re, this._im, true);

    // Overlap-add into output ring with Hann window
    for (let i = 0; i < FFT_SIZE; i++) {
      const sample = this._re[i] * this._win[i];
      const idx = (this._outWr + i) % this._outRing.length;
      this._outRing[idx] += sample;
    }
    this._outWr = (this._outWr + FFT_SIZE) % this._outRing.length;
  }
}

registerProcessor('dsp-processor', DSPProcessor);
