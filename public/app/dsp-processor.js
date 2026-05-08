/**
 * dsp-processor.js — VoiceIsolate Pro AudioWorkletProcessor
 * Architecture: Threads from Space v8
 * Single-Pass STFT: ONE forward FFT → in-place spectral ops → ONE iSTFT
 * SharedArrayBuffer bridge to main thread for ONNX inference
 * Constraint: 100% local, no external fetch, <10ms live latency target
 */

// ---------------------------------------------------------------------------
// Lightweight Cooley-Tukey in-place FFT (power-of-2, real/imag Float32Arrays)
// ---------------------------------------------------------------------------
function fft(re, im) {
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
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k],         uIm = im[i + k];
        const vRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const vIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k]        = uRe + vRe;
        im[i + k]        = uIm + vIm;
        re[i + k + half] = uRe - vRe;
        im[i + k + half] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// Inverse FFT: conjugate, forward FFT, conjugate + scale
function ifft(re, im) {
  const N = re.length;
  // Conjugate
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fft(re, im);
  // Conjugate + scale
  for (let i = 0; i < N; i++) {
    re[i] /= N;
    im[i] = -im[i] / N;
  }
}

// ---------------------------------------------------------------------------
// Hann window generator
// ---------------------------------------------------------------------------
function makeHannWindow(size) {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

// ---------------------------------------------------------------------------
// SharedArrayBuffer layout (Float32, frames × bins)
// Offsets (in float32 elements):
//   [0]            : control word  (0=idle, 1=ready for ONNX, 2=ONNX done)
//   [1 .. BINS]    : magnitude spectrum (input to ONNX on main thread)
//   [BINS+1 .. 2*BINS] : mask returned by ONNX (main thread writes here)
// ---------------------------------------------------------------------------
const FFT_SIZE   = 2048;   // must be power-of-2
const HOP_SIZE   = 512;    // 75% overlap
const HALF_BINS  = FFT_SIZE / 2 + 1;
const SAB_FLOATS = 1 + HALF_BINS * 2; // control + mag + mask

class DSPProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // ---- Hann window ----
    this._window = makeHannWindow(FFT_SIZE);

    // ---- Overlap-add ring buffers ----
    this._inputRing  = new Float32Array(FFT_SIZE);  // circular input buffer
    this._outputRing = new Float32Array(FFT_SIZE);  // OLA accumulator
    this._ringHead   = 0;  // write pointer
    this._hopAccum   = 0;  // samples accumulated since last FFT trigger

    // ---- FFT work arrays ----
    this._re = new Float32Array(FFT_SIZE);
    this._im = new Float32Array(FFT_SIZE);

    // ---- SharedArrayBuffer bridge ----
    // Expect main thread to pass sab via options.processorOptions
    const sab = options?.processorOptions?.sharedArrayBuffer;
    if (sab) {
      this._sab     = new Float32Array(sab);
      this._sabCtrl = new Int32Array(sab);  // control word as int
    } else {
      // Fallback: allocate local (no ONNX cooperation, bypass mode)
      const localSab = new SharedArrayBuffer(SAB_FLOATS * Float32Array.BYTES_PER_ELEMENT);
      this._sab     = new Float32Array(localSab);
      this._sabCtrl = new Int32Array(localSab);
      console.warn('[DSPProcessor] No SharedArrayBuffer received — running bypass mode');
    }

    // ---- DSP parameter state (updated via port.postMessage) ----
    this._params = {
      noiseReduction:  0.5,   // 0–1
      voiceBoost:      0.5,
      reverbReduction: 0.5,
      lowCut:          80,    // Hz
      highCut:         8000,  // Hz
      gate:            0.01,  // linear magnitude threshold
      // ... additional params mapped from 52 sliders on main thread
    };

    // Listen for parameter updates from main thread
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'params') {
        Object.assign(this._params, e.data.payload);
      }
    };
  }

  /**
   * Main audio processing callback.
   * Called every render quantum (128 samples @ 48 kHz ≈ 2.67 ms)
   */
  process(inputs, outputs) {
    const input  = inputs[0]?.[0];   // mono input channel
    const output = outputs[0]?.[0];  // mono output channel
    if (!input || !output) return true;

    const blockSize = input.length; // typically 128

    for (let n = 0; n < blockSize; n++) {
      // Write input sample into ring buffer
      this._inputRing[this._ringHead] = input[n];

      // Read processed output from OLA buffer (with latency = FFT_SIZE)
      output[n] = this._outputRing[this._ringHead];
      this._outputRing[this._ringHead] = 0; // clear after reading

      this._ringHead = (this._ringHead + 1) % FFT_SIZE;
      this._hopAccum++;

      // Trigger a new STFT frame every HOP_SIZE samples
      if (this._hopAccum >= HOP_SIZE) {
        this._hopAccum = 0;
        this._processFrame();
      }
    }

    return true; // keep processor alive
  }

  /**
   * Single-pass STFT frame processing:
   *   1. Fill FFT buffer from ring (applying Hann window)
   *   2. ONE forward FFT
   *   3. In-place spectral operations (gain, gating, masking from ONNX)
   *   4. ONE inverse FFT
   *   5. Overlap-add back into output ring
   */
  _processFrame() {
    // ---- 1. Window + copy ring into FFT arrays ----
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (this._ringHead + i) % FFT_SIZE;
      this._re[i] = this._inputRing[idx] * this._window[i];
      this._im[i] = 0;
    }

    // ---- 2. ONE Forward STFT ----
    fft(this._re, this._im);

    // ---- 3a. Compute magnitude spectrum → write to SAB for ONNX ----
    const mag = new Float32Array(HALF_BINS);
    for (let k = 0; k < HALF_BINS; k++) {
      mag[k] = Math.sqrt(this._re[k] ** 2 + this._im[k] ** 2);
    }

    // Signal ONNX worker with magnitude (non-blocking best-effort)
    // ctrl=0 means idle; we only push if idle to avoid stale data
    if (Atomics.compareExchange(this._sabCtrl, 0, 0, 1) === 0) {
      this._sab.set(mag, 1);          // write mag starting at offset 1
      Atomics.store(this._sabCtrl, 0, 1); // mark ready for ONNX
    }

    // ---- 3b. Read mask from SAB (if ONNX has completed) ----
    let mask;
    if (Atomics.load(this._sabCtrl, 0) === 2) {
      // ONNX done — read mask
      mask = this._sab.slice(1 + HALF_BINS, 1 + HALF_BINS * 2);
      Atomics.store(this._sabCtrl, 0, 0); // reset to idle
    } else {
      // ONNX not ready yet — use spectral gate as fallback
      mask = new Float32Array(HALF_BINS).fill(1);
      const threshold = this._params.gate * (mag.reduce((a, b) => a + b, 0) / HALF_BINS);
      for (let k = 0; k < HALF_BINS; k++) {
        mask[k] = mag[k] > threshold ? 1 : 0;
      }
    }

    // ---- 3c. In-place spectral operations (apply mask + classical DSP) ----
    const sampleRate = 48000;
    const lowBin  = Math.floor(this._params.lowCut  / (sampleRate / FFT_SIZE));
    const highBin = Math.ceil(this._params.highCut  / (sampleRate / FFT_SIZE));
    const nrGain  = 1 - this._params.noiseReduction; // attenuate noise components
    const vbGain  = 1 + this._params.voiceBoost;     // boost voice band

    for (let k = 0; k < HALF_BINS; k++) {
      let g = mask[k];

      // Hard band pass: zero bins outside [lowCut, highCut]
      if (k < lowBin || k > highBin) {
        g = 0;
      } else {
        // Noise reduction attenuation on non-voice bins
        g *= (mask[k] < 0.5 ? nrGain : vbGain);
      }

      this._re[k] *= g;
      this._im[k] *= g;

      // Mirror for the negative-frequency bins (Hermitian symmetry)
      if (k > 0 && k < FFT_SIZE / 2) {
        this._re[FFT_SIZE - k] = this._re[k];
        this._im[FFT_SIZE - k] = -this._im[k];
      }
    }

    // ---- 4. ONE Inverse STFT ----
    ifft(this._re, this._im);

    // ---- 5. Overlap-add into output ring ----
    // Scale to compensate for OLA window gain (Hann 75% overlap → 1.5)
    const olaScale = HOP_SIZE / (FFT_SIZE * 0.5);
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (this._ringHead + i) % FFT_SIZE;
      this._outputRing[idx] += this._re[i] * this._window[i] * olaScale;
    }
  }
}

registerProcessor('dsp-processor', DSPProcessor);
