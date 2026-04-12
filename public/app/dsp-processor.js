// ─────────────────────────────────────────────────────────────────────────────
//  dsp-processor.js  —  VoiceIsolate Pro · Threads from Space v8
//  AudioWorkletProcessor — runs in the isolated high-priority audio thread.
//
//  Architecture contract:
//   • Exactly ONE forward STFT at the start of the spectral phase
//   • All spectral operations are in-place on the complex spectrum
//   • Exactly ONE inverse STFT (iSTFT) reconstructing the time-domain signal
//   • ML inference is NOT run here — too heavy for the audio thread.
//     Magnitude spectrum slices are written to SharedArrayBuffer;
//     main-thread ml-worker.js reads/writes masks asynchronously.
//   • Classical DSP (gate, notch, spectral subtract, Wiener) runs inline here.
// ─────────────────────────────────────────────────────────────────────────────

const FFT_SIZE = 4096;   // STFT window (samples) — ~85ms @ 48 kHz
const HOP_SIZE = 1024;   // 75% overlap
const HALF     = FFT_SIZE >>> 1;
const NUM_BINS = HALF + 1;

// ── Cooley-Tukey in-place iterative FFT ─────────────────────────────────────
// Operates on Float32 re[] / im[] arrays of length N (must be power-of-2).
function fft(re, im, inverse = false) {
  const N = re.length;
  // Bit-reversal permutation
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
  // Butterfly passes
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= N; len <<= 1) {
    const ang  = sign * 2 * Math.PI / len;
    const wRe  = Math.cos(ang);
    const wIm  = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len >>> 1; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const tRe = curRe * re[i + k + len / 2] - curIm * im[i + k + len / 2];
        const tIm = curRe * im[i + k + len / 2] + curIm * re[i + k + len / 2];
        re[i + k]           =  uRe + tRe;
        im[i + k]           =  uIm + tIm;
        re[i + k + len / 2] =  uRe - tRe;
        im[i + k + len / 2] =  uIm - tIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }
}

// ── Pre-compute Hann window ──────────────────────────────────────────────────
const HANN = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
}

// ── IIR biquad notch filter helpers ─────────────────────────────────────────
function makeBiquad() {
  return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, z1: 0, z2: 0 };
}
function setBiquadNotch(bq, freq, q, sr) {
  const w0    = 2 * Math.PI * freq / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosW0 = Math.cos(w0);
  const a0    = 1 + alpha;
  bq.b0 =  1          / a0;
  bq.b1 = -2 * cosW0  / a0;
  bq.b2 =  1          / a0;
  bq.a1 = -2 * cosW0  / a0;
  bq.a2 = (1 - alpha) / a0;
}
function processBiquad(bq, x) {
  const y = bq.b0 * x + bq.z1;
  bq.z1   = bq.b1 * x - bq.a1 * y + bq.z2;
  bq.z2   = bq.b2 * x - bq.a2 * y;
  return y;
}

// ────────────────────────────────────────────────────────────────────────────
class DSPProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this._sampleRate = sampleRate; // AudioWorklet global

    // ── Working buffers ──────────────────────────────────────────────────────
    this._inBuf    = new Float32Array(FFT_SIZE);
    this._outBuf   = new Float32Array(FFT_SIZE);
    this._writePos = 0;
    this._reBuffer = new Float32Array(FFT_SIZE);
    this._imBuffer = new Float32Array(FFT_SIZE);
    this._prevMag  = new Float32Array(NUM_BINS);
    this._mlMask   = new Float32Array(NUM_BINS).fill(1);

    // ── SharedArrayBuffer rings ──────────────────────────────────────────────
    // Layout: [Float32 magnitudes × NUM_BINS][Float32 mask × NUM_BINS][Int32 flags × 4]
    //  inputSAB  flagsIn[0]  = frame counter (written here)
    //  outputSAB flagsOut[1] = mask ready    (written by ml-worker)
    if (options?.processorOptions?.inputSAB) {
      this._inputSAB   = options.processorOptions.inputSAB;
      this._outputSAB  = options.processorOptions.outputSAB;
      this._inputView  = new Float32Array(this._inputSAB);
      this._outputView = new Float32Array(this._outputSAB);
      this._flagsIn    = new Int32Array(this._inputSAB,  NUM_BINS * 4, 4);
      this._flagsOut   = new Int32Array(this._outputSAB, NUM_BINS * 4, 4);
      this._hasSAB = true;
    } else {
      this._hasSAB = false;
    }

    // ── Per-channel notch filters (60/120/180 Hz) ────────────────────────────
    this._notch60  = [makeBiquad(), makeBiquad()];
    this._notch120 = [makeBiquad(), makeBiquad()];
    this._notch180 = [makeBiquad(), makeBiquad()];
    this._rebuildNotchFilters(this._sampleRate);

    // ── DSP parameter state — updated via port.onmessage ────────────────────
    this._params = {
      gateThresh:      0.10,
      gateRange:       0.92,
      noiseReduce:     0.70,
      humReduce:       0.50,
      spectralFloor:   0.30,
      wienerAmount:    0.55,
      harmonicEnhance: 0.15,
      outGain:         1.00,
      dryWet:          1.00,
      bypass:          false,
    };

    this._frameCount = 0;

    // Receive slider updates from main thread
    this.port.onmessage = (ev) => {
      if (ev.data?.type === 'params') {
        Object.assign(this._params, ev.data.params);
        if (ev.data.params.sampleRate) {
          this._rebuildNotchFilters(ev.data.params.sampleRate);
        }
      }
    };
  }

  _rebuildNotchFilters(sr) {
    for (let ch = 0; ch < 2; ch++) {
      setBiquadNotch(this._notch60[ch],   60, 30, sr);
      setBiquadNotch(this._notch120[ch], 120, 30, sr);
      setBiquadNotch(this._notch180[ch], 180, 30, sr);
    }
  }

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input?.length || !output?.length) return true;

    const numChannels = Math.min(input.length, output.length);
    const blockSize   = input[0].length;

    for (let ch = 0; ch < numChannels; ch++) {
      const inData   = input[ch];
      const outData  = output[ch];
      const notch60  = this._notch60[ch]  || this._notch60[0];
      const notch120 = this._notch120[ch] || this._notch120[0];
      const notch180 = this._notch180[ch] || this._notch180[0];

      for (let n = 0; n < blockSize; n++) {
        let x = inData[n];

        if (this._params.bypass) {
          outData[n] = x;
          continue;
        }

        // Stage 1: Hum removal — pre-spectral IIR notch cascade
        if (this._params.humReduce > 0) {
          const h   = this._params.humReduce;
          const dry = x;
          x = processBiquad(notch60,  x);
          x = processBiquad(notch120, x);
          x = processBiquad(notch180, x);
          x = dry * (1 - h) + x * h;
        }

        // Stage 2: Fill overlap-add input ring buffer
        this._inBuf[this._writePos] = x;
        this._writePos = (this._writePos + 1) & (FFT_SIZE - 1);

        // Run spectral pass every HOP_SIZE samples
        if (this._writePos % HOP_SIZE === 0) {
          this._processSpectralHop();
        }

        const readPos = (this._writePos - blockSize + n + FFT_SIZE) & (FFT_SIZE - 1);
        outData[n] = this._outBuf[readPos] * this._params.outGain;
      }
    }
    return true;
  }

  // ── Single spectral pass: ONE forward STFT → in-place ops → ONE iSTFT ─────
  _processSpectralHop() {
    const re = this._reBuffer;
    const im = this._imBuffer;

    // Copy windowed frame into re[], zero im[]
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (this._writePos - FFT_SIZE + i + FFT_SIZE) & (FFT_SIZE - 1);
      re[i] = this._inBuf[idx] * HANN[i];
      im[i] = 0;
    }

    // ① FORWARD STFT — exactly once
    fft(re, im, false);

    // Compute magnitude and phase
    const mag   = new Float32Array(NUM_BINS);
    const phase = new Float32Array(NUM_BINS);
    for (let k = 0; k < NUM_BINS; k++) {
      mag[k]   = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }

    // Stage 3: Noise profile (slow EMA)
    const alpha = 0.005;
    for (let k = 0; k < NUM_BINS; k++) {
      this._prevMag[k] = alpha * mag[k] + (1 - alpha) * this._prevMag[k];
    }

    // Stage 4: Spectral subtraction — mag' = max(mag - β·noise, floor·mag)
    const beta  = 1 + this._params.noiseReduce * 4;
    const floor = this._params.spectralFloor * 0.01;
    for (let k = 0; k < NUM_BINS; k++) {
      mag[k] = Math.max(mag[k] - beta * this._prevMag[k], floor * mag[k]);
    }

    // Stage 5: Wiener gain
    const w = this._params.wienerAmount;
    if (w > 0) {
      for (let k = 0; k < NUM_BINS; k++) {
        const snr  = mag[k] / (this._prevMag[k] + 1e-9);
        const gain = snr / (snr + 1);
        mag[k] = mag[k] * (1 - w) + mag[k] * gain * w;
      }
    }

    // Stage 6: Per-bin spectral gate
    const gt = this._params.gateThresh;
    const gr = this._params.gateRange;
    for (let k = 0; k < NUM_BINS; k++) {
      if (mag[k] < gt * this._prevMag[k] * 10) mag[k] *= (1 - gr);
    }

    // Stage 7: Apply ML mask from SharedArrayBuffer (async, non-blocking)
    if (this._hasSAB) {
      if (Atomics.load(this._flagsOut, 1) === 1) {
        for (let k = 0; k < NUM_BINS; k++) this._mlMask[k] = this._outputView[k];
        Atomics.store(this._flagsOut, 1, 0);
      }
      this._inputView.set(mag);
      Atomics.add(this._flagsIn, 0, 1);
    }
    for (let k = 0; k < NUM_BINS; k++) mag[k] *= this._mlMask[k];

    // Stage 8: Harmonic enhancement (even-order in spectral domain)
    if (this._params.harmonicEnhance > 0) {
      const h = this._params.harmonicEnhance * 0.1;
      for (let k = 0; k < NUM_BINS; k++) mag[k] += h * mag[k] * mag[k];
    }

    // Reconstruct complex spectrum from modified magnitudes + original phase
    for (let k = 0; k < NUM_BINS; k++) {
      re[k] = mag[k] * Math.cos(phase[k]);
      im[k] = mag[k] * Math.sin(phase[k]);
    }
    // Enforce conjugate symmetry for real-valued iFFT
    for (let k = 1; k < HALF; k++) {
      re[FFT_SIZE - k] =  re[k];
      im[FFT_SIZE - k] = -im[k];
    }

    // ② INVERSE STFT — exactly once
    fft(re, im, true);

    // Overlap-add into output ring buffer
    const olaScale = FFT_SIZE / HOP_SIZE * 0.5;
    for (let i = 0; i < FFT_SIZE; i++) {
      const writeIdx = (this._writePos - FFT_SIZE + i + FFT_SIZE) & (FFT_SIZE - 1);
      this._outBuf[writeIdx] += re[i] * HANN[i] / olaScale;
    }

    this._frameCount++;
    if (this._frameCount % 64 === 0) {
      this.port.postMessage({
        type:  'meter',
        frame: this._frameCount,
        rms:   this._calcRMS(re),
      });
    }
  }

  _calcRMS(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }
}

registerProcessor('dsp-processor', DSPProcessor);
