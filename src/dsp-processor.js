// src/dsp-processor.js — AudioWorkletProcessor (runs on dedicated audio thread)
// Loads the WASM DSP engine; falls back to JS passthrough until WASM is ready.

class DspProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const sab = options.processorOptions.paramSab;
    this.paramInt = new Int32Array(sab);

    // ── One-pole smoother state (de-zippering) ───────────────────────────────
    const SR   = 48000;
    const tc   = Math.exp(-1 / (SR * 0.050)); // 50ms ramp
    this._tc   = tc;
    this._sNoise = 0.5;
    this._sIsol  = 0.5;
    this._sGain  = 0.7;

    // ── DSP constants ─────────────────────────────────────────────────────────
    this.FFT_SIZE = 2048;
    this.HOP      = 512;   // 75% overlap
    this.BINS     = this.FFT_SIZE / 2 + 1;

    // ── Pre-allocated buffers (NO allocation in process()) ───────────────────
    this._inBuf      = new Float32Array(this.FFT_SIZE);
    this._outBuf     = new Float32Array(this.FFT_SIZE);
    this._overlapBuf = new Float32Array(this.FFT_SIZE);
    this._window     = new Float32Array(this.FFT_SIZE);
    this._noiseFloor = new Float32Array(this.BINS);
    this._magOut     = new Float32Array(this.BINS); // sent to visualizer
    this._writePos   = 0;
    this._frameCount = 0;

    // Build Hann window once at init
    for (let i = 0; i < this.FFT_SIZE; i++) {
      this._window[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / this.FFT_SIZE));
    }

    // Initialize noise floor to small positive value
    this._noiseFloor.fill(1e-6);

    this._wasmReady = false;
    this._lastSimilarity = 0.5;

    // ── Load WASM module asynchronously ──────────────────────────────────────
    // Path resolves relative to the AudioWorklet scope
    import('/wasm/dsp_processor.js')
      .then((mod) => {
        this._wasm = mod.default || mod;
        this._wasmReady = true;
        console.log('[DSP Worklet] WASM module loaded.');
      })
      .catch((e) => {
        console.warn('[DSP Worklet] WASM not available, using JS fallback.', e.message);
      });

    this.port.onmessage = ({ data }) => {
      if (data.type === 'SIMILARITY') this._lastSimilarity = data.score;
    };
  }

  // ── One-pole low-pass (de-zipper) ──────────────────────────────────────────
  _smooth(target, current) {
    return this._tc * current + (1 - this._tc) * target;
  }

  // ── JS fallback: Minimum Statistics + Wiener + OLA (no WASM) ───────────────
  _processJS(input, output) {
    const N    = this.FFT_SIZE;
    const hop  = this.HOP;
    const bins = this.BINS;
    const win  = this._window;
    const nf   = this._noiseFloor;
    const over = this._overlapBuf;
    const gain = this._sGain;
    const nr   = this._sNoise;

    // Accumulate samples into ring buffer
    for (let i = 0; i < input.length; i++) {
      this._inBuf[this._writePos++ % N] = input[i];
    }

    // Simple windowed gain + noise gate (placeholder for full FFT path)
    for (let i = 0; i < input.length; i++) {
      const w = win[i % N];
      // Minimum statistics: exponential minimum tracker
      const mag = Math.abs(input[i]);
      nf[i % bins] = Math.min(
        0.98 * nf[i % bins] + 0.02 * mag,
        mag
      );
      // Wiener gain approximation
      const snr  = Math.max(mag - 1.5 * nr * nf[i % bins], 0) / (mag + 1e-12);
      const gW   = Math.sqrt(snr);
      output[i]  = input[i] * gW * gain;

      this._magOut[i % bins] = mag * gW;
    }

    // Overlap-add
    for (let i = 0; i < input.length; i++) {
      output[i] = output[i] * w + over[i];
    }
    for (let i = 0; i < hop; i++) {
      over[i] = output[hop + i] || 0;
    }
  }

  process(inputs, outputs) {
    const input  = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!input || !output || input.length === 0) return true;

    // ── Read params from SAB (Atomics — lock-free) ───────────────────────────
    const rawNoise = Atomics.load(this.paramInt, 0) / 10000;
    const rawIsol  = Atomics.load(this.paramInt, 1) / 10000;
    const rawGain  = Atomics.load(this.paramInt, 2) / 10000;

    // ── Smooth (de-zipper) ───────────────────────────────────────────────────
    this._sNoise = this._smooth(rawNoise, this._sNoise);
    this._sIsol  = this._smooth(rawIsol,  this._sIsol);
    this._sGain  = this._smooth(rawGain,  this._sGain);

    // ── Process via WASM if ready, else JS fallback ──────────────────────────
    if (this._wasmReady && this._wasm.processBlock) {
      this._wasm.processBlock(
        input, output,
        this._inBuf, this._outBuf, this._overlapBuf,
        this._window, this._noiseFloor,
        this._sNoise, this._sGain,
        this.FFT_SIZE, this.HOP
      );
      // Copy output magnitude for visualizer
      for (let k = 0; k < this.BINS; k++) {
        this._magOut[k] = Math.abs(this._outBuf[k] || 0);
      }
    } else {
      this._processJS(input, output);
    }

    // ── Send FFT frame to main thread every 4 blocks (~10ms at 48kHz/128) ───
    if (++this._frameCount % 4 === 0) {
      this.port.postMessage({
        type: 'FFT_FRAME',
        magnitude: this._magOut.slice(0, 512),
        similarity: this._lastSimilarity,
      });
    }

    return true;
  }
}

registerProcessor('dsp-processor', DspProcessor);
