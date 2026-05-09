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
  fft(re, im, true);
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
// SharedArrayBuffer layout (header-first protocol for ml-worker.js):
// inputSAB:  [4 x Int32 flags][Float32 magnitudes + phases]
// outputSAB: [4 x Int32 flags][Float32 mask]
// ---------------------------------------------------------------------------
const FFT_SIZE   = 4096;   // must be power-of-2
const HOP_SIZE   = 1024;   // 75% overlap
const HALF_BINS  = FFT_SIZE / 2 + 1;
const FLAG_SLOTS = 4;
const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS;
const INPUT_PAYLOAD_FLOATS = HALF_BINS * 2; // [mag(half) | phase(half)]
const OUTPUT_PAYLOAD_FLOATS = HALF_BINS;    // [mask(half)]
const INPUT_SAB_BYTES = SAB_HEADER_BYTES + INPUT_PAYLOAD_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const OUTPUT_SAB_BYTES = SAB_HEADER_BYTES + OUTPUT_PAYLOAD_FLOATS * Float32Array.BYTES_PER_ELEMENT;

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
    // Expect main thread to pass:
    // options.processorOptions.sharedArrayBuffer = { inputSAB, outputSAB }
    const sabOptions = options?.processorOptions?.sharedArrayBuffer;
    const inputSAB = sabOptions?.inputSAB;
    const outputSAB = sabOptions?.outputSAB;
    if (inputSAB && outputSAB) {
      this._inputSAB = inputSAB;
      this._outputSAB = outputSAB;
    } else {
      // Fallback: allocate local SABs; notify main thread for forwarding.
      this._inputSAB = new SharedArrayBuffer(INPUT_SAB_BYTES);
      this._outputSAB = new SharedArrayBuffer(OUTPUT_SAB_BYTES);
      console.warn('[DSPProcessor] No SAB pair received — allocated fallback SABs');
    }

    this._flagsIn = new Int32Array(this._inputSAB, 0, FLAG_SLOTS);
    this._flagsOut = new Int32Array(this._outputSAB, 0, FLAG_SLOTS);
    this._inputView = new Float32Array(this._inputSAB, SAB_HEADER_BYTES, INPUT_PAYLOAD_FLOATS);
    this._outputView = new Float32Array(this._outputSAB, SAB_HEADER_BYTES, OUTPUT_PAYLOAD_FLOATS);
    this._maskScratch = new Float32Array(HALF_BINS);

    this.port.postMessage({
      type: 'sabReady',
      inputSAB: this._inputSAB,
      outputSAB: this._outputSAB,
    });

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
    fft(this._re, this._im, false);

    // ---- 3a. Compute magnitude spectrum → write to SAB for ONNX ----
    const mag = this._inputView.subarray(0, HALF_BINS);
    const phase = this._inputView.subarray(HALF_BINS, HALF_BINS * 2);
    for (let k = 0; k < HALF_BINS; k++) {
      mag[k] = Math.sqrt(this._re[k] ** 2 + this._im[k] ** 2);
      phase[k] = Math.atan2(this._im[k], this._re[k]);
    }

    // Signal ONNX worker with frame counter increment on each hop.
    Atomics.add(this._flagsIn, 0, 1);

    // ---- 3b. Read mask from SAB (if ONNX has completed) ----
    let mask;
    if (Atomics.load(this._flagsOut, 1) === 1) {
      mask = this._outputView;
      Atomics.store(this._flagsOut, 1, 0);
    } else {
      // ONNX not ready yet — use spectral gate as fallback
      mask = this._maskScratch;
      mask.fill(1);
      const threshold = this._params.gate * (mag.reduce((a, b) => a + b, 0) / HALF_BINS);
      for (let k = 0; k < HALF_BINS; k++) {
        mask[k] = mag[k] > threshold ? 1 : 0;
      }
    }

    // ---- 3c. In-place spectral operations (apply mask + classical DSP) ----
    const sampleRate = this.context.sampleRate;
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
    // Hann 75% overlap normalization.
    const olaScale = 2 * HOP_SIZE / FFT_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (this._ringHead + i) % FFT_SIZE;
      this._outputRing[idx] += this._re[i] * this._window[i] * olaScale;
    }
  }
}

registerProcessor('dsp-processor', DSPProcessor);
