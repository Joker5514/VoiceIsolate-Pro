/* =============================================================================
   VoiceIsolate Pro — dsp-processor.js
   AudioWorkletProcessor · Threads from Space v8 · Engineer Mode v19
   32-stage Octa-Pass DSP Pipeline · Single-Pass STFT Architecture

   ARCHITECTURE CONTRACT (STRICTLY ENFORCED):
   ─────────────────────────────────────────
   1. ONE forward STFT  per audio frame  (forwardSTFT)
   2. In-place spectral operations on the complex spectrum
   3. ONE inverse STFT  per audio frame  (inverseSTFT)
   4. No cloud calls. No fetch(). Pure AudioWorklet + SAB.

   SharedArrayBuffer Ring Layout (per buffer):
   ─────────────────────────────────────────
   Byte  0– 3 : Int32 writeHead  (samples, wraps at capacity)
   Byte  4– 7 : Int32 readHead   (samples, wraps at capacity)
   Byte  8–11 : Int32 reserved
   Byte 12–15 : Int32 overrunCount (diagnostic)
   Byte 16+   : Float32 audio data  (capacity = frameSize * frameCount)

   SAB Flow:
   ─────────
   AudioWorklet ──inputSAB──▶  ML Worker  (raw PCM in)
   AudioWorklet ◀──outputSAB── ML Worker  (processed PCM out)
   ============================================================================= */

'use strict';

// ─── Cooley-Tukey Radix-2 FFT (pure JS, AudioWorklet-safe) ──────────────────
// Operates in-place on interleaved [re0,im0, re1,im1, ...] Float32Array.
// Size must be a power of two.

function fft(buf) {
  const n = buf.length >>> 1; // number of complex samples
  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      // swap real
      let t = buf[i * 2];     buf[i * 2]     = buf[j * 2];     buf[j * 2]     = t;
      // swap imag
          t = buf[i * 2 + 1]; buf[i * 2 + 1] = buf[j * 2 + 1]; buf[j * 2 + 1] = t;
    }
  }
  // Butterfly stages
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang  = -2 * Math.PI / len;
    const wRe  = Math.cos(ang);
    const wIm  = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let uRe = 1, uIm = 0;
      for (let k = 0; k < half; k++) {
        const aIdx = (i + k)        * 2;
        const bIdx = (i + k + half) * 2;
        const bRe  = buf[bIdx]     * uRe - buf[bIdx + 1] * uIm;
        const bIm  = buf[bIdx]     * uIm + buf[bIdx + 1] * uRe;
        buf[bIdx]     = buf[aIdx]     - bRe;
        buf[bIdx + 1] = buf[aIdx + 1] - bIm;
        buf[aIdx]     += bRe;
        buf[aIdx + 1] += bIm;
        const newURe = uRe * wRe - uIm * wIm;
        uIm = uRe * wIm + uIm * wRe;
        uRe = newURe;
      }
    }
  }
}

function ifft(buf) {
  const n = buf.length >>> 1;
  // Conjugate
  for (let i = 0; i < n; i++) buf[i * 2 + 1] = -buf[i * 2 + 1];
  fft(buf);
  // Conjugate + scale
  const inv = 1 / n;
  for (let i = 0; i < n; i++) {
    buf[i * 2]     *=  inv;
    buf[i * 2 + 1] = -buf[i * 2 + 1] * inv;
  }
}

// ─── Hann window (precomputed once at module scope) ─────────────────────────
const FFT_SIZE     = 2048;   // must be power-of-two
const HOP_SIZE     = FFT_SIZE >> 1; // 50% overlap
const HANN         = new Float32Array(FFT_SIZE);
const HANN_SUM_SQ  = (() => {
  let s = 0;
  for (let i = 0; i < FFT_SIZE; i++) {
    HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
    s += HANN[i] * HANN[i];
  }
  return s / HOP_SIZE; // OLA normalisation factor
})();

// ─── Ring buffer helpers (operate directly on SAB views) ────────────────────
function ringAvailable(ctrl, capacity) {
  const w = Atomics.load(ctrl, 0);
  const r = Atomics.load(ctrl, 1);
  return (w - r + capacity) % capacity;
}

function ringPush(ctrl, data, capacity, samples) {
  const len   = samples.length;
  const avail = capacity - 1 - ringAvailable(ctrl, capacity);
  if (len > avail) { Atomics.add(ctrl, 3, 1); return false; }
  let w = Atomics.load(ctrl, 0);
  const first = Math.min(len, capacity - w);
  data.set(samples.subarray(0, first), w);
  if (first < len) data.set(samples.subarray(first), 0);
  Atomics.store(ctrl, 0, (w + len) % capacity);
  return true;
}

function ringPull(ctrl, data, capacity, count) {
  if (ringAvailable(ctrl, capacity) < count) return null;
  const out = new Float32Array(count);
  let r = Atomics.load(ctrl, 1);
  const first = Math.min(count, capacity - r);
  out.set(data.subarray(r, r + first));
  if (first < count) out.set(data.subarray(0, count - first), first);
  Atomics.store(ctrl, 1, (r + count) % capacity);
  return out;
}

// ─── Main Processor ──────────────────────────────────────────────────────────

class DSPProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // ── SAB ring buffer views (set via initRingBuffers message) ──
    this.inCtrl  = null;  // Int32Array  view of inputSAB  header
    this.inData  = null;  // Float32Array view of inputSAB  samples
    this.inCap   = 0;
    this.outCtrl = null;  // Int32Array  view of outputSAB header
    this.outData = null;  // Float32Array view of outputSAB samples
    this.outCap  = 0;

    // ── STFT state ──
    // Input accumulator: collect samples until we have a full FFT_SIZE frame
    this.inputAccum  = new Float32Array(FFT_SIZE);  // sliding input window
    this.accumIdx    = 0;                           // write position in accumulator

    // Overlap-add output buffer
    this.olaBuffer   = new Float32Array(FFT_SIZE * 2);
    this.olaReadPos  = 0;

    // Complex spectrum buffer [re0,im0, re1,im1, ...]
    this.spectrum    = new Float32Array(FFT_SIZE * 2);

    // Noise floor estimate (magnitude spectrum, updated on silence frames)
    this.noiseEst    = new Float32Array(FFT_SIZE);
    this.noiseInit   = false;
    this.silentFrames = 0;

    // ── 52-slot parameter store (mirrors the 52 UI sliders) ──
    this.params = {
      // ── Noise / Gate ──
      gateThreshold:        -42,   // dBFS
      gateRange:            -40,   // dB attenuation below threshold
      gateAttack:             2,   // ms
      gateRelease:           80,   // ms
      gateHold:              20,   // ms
      nrStrength:            70,   // 0–100  Wiener NR depth
      nrSmoothing:           50,   // 0–100  temporal smoothing of noise est.
      spectralFloor:         -80,  // dBFS  minimum post-NR level
      // ── Voice EQ ──
      hpfFreq:              100,   // Hz
      hpfOrder:               2,
      lpfFreq:             8000,   // Hz
      presenceBand:        3500,   // Hz  centre of presence boost
      presenceGain:           0,   // dB
      warmthGain:             0,   // dB  (<500 Hz shelf)
      airGain:                0,   // dB  (>8 kHz shelf)
      // ── Dynamics ──
      compThreshold:        -18,   // dBFS
      compRatio:              3,
      compAttack:             5,   // ms
      compRelease:          100,   // ms
      compKnee:               6,   // dB
      compMakeup:             0,   // dB
      limiterCeiling:        -1,   // dBFS
      // ── De-reverb ──
      dereverbAmount:         0,   // 0–100
      dereverbTail:          50,   // ms  estimated tail to suppress
      // ── De-clip ──
      declipThreshold:       -3,   // dBFS  clip detection threshold
      declipStrength:         0,   // 0–100
      // ── Spectral ──
      spectralGating:        50,   // 0–100  gate depth in freq domain
      harmonicEnhance:        0,   // 0–100
      transientSharp:         0,   // 0–100  transient emphasis
      stereoWidth:           50,   // 0–100 (mono=0, wide=100)
      // ── ML / Model ──
      mlStrength:            80,   // 0–100  blend of ML output vs classical
      mlLatencyMode:          0,   // 0=low-latency 1=quality
      // ── Output ──
      outputGain:             0,   // dB
      dryWet:               100,   // 0–100
      // ── Pads to 52 (reserved for future stages) ──
      reserved00: 0, reserved01: 0, reserved02: 0, reserved03: 0,
      reserved04: 0, reserved05: 0, reserved06: 0, reserved07: 0,
      reserved08: 0, reserved09: 0, reserved10: 0, reserved11: 0,
      reserved12: 0, reserved13: 0, reserved14: 0, reserved15: 0,
      reserved16: 0, reserved17: 0
    };

    // ── Gate envelope state ──
    this.gateEnv     = 0;
    this.holdCounter = 0;

    // ── Compressor state ──
    this.compEnv     = 0;

    // ── Harmonic enhancer ──
    this.heAmount    = 0;
    this.heDrive     = 1;
    this.heTanhDrive = Math.tanh(1);

    // ── Bypass / mute ──
    this.bypassed    = false;
    this.muted       = false;

    // ── Message handler ──
    this.port.onmessage = (e) => this._onMessage(e.data);
  }

  // ── Message dispatcher ────────────────────────────────────────────────────

  _onMessage(msg) {
    switch (msg.type) {

      // Bulk parameter update from 52-slider UI
      case 'paramBulk':
        for (const [k, v] of Object.entries(msg.params)) {
          if (k in this.params) {
            this.params[k] = v;
          }
        }
        this._updateDerivedParams();
        break;

      // Single parameter update
      case 'param':
        if (msg.key in this.params) {
          this.params[msg.key] = msg.value;
          this._updateDerivedParams();
        }
        break;

      // Receive SharedArrayBuffers from main thread
      // inputSAB  : raw PCM  AudioWorklet → ML Worker
      // outputSAB : processed PCM  ML Worker → AudioWorklet
      case 'initRingBuffers': {
        const frameSize  = msg.frameSize  || 4096;
        const frameCount = msg.frameCount || 8;
        const capacity   = frameSize * frameCount;

        if (msg.inputSAB) {
          this.inCtrl = new Int32Array(msg.inputSAB, 0, 4);
          this.inData = new Float32Array(msg.inputSAB, 16, capacity);
          this.inCap  = capacity;
        }
        if (msg.outputSAB) {
          this.outCtrl = new Int32Array(msg.outputSAB, 0, 4);
          this.outData = new Float32Array(msg.outputSAB, 16, capacity);
          this.outCap  = capacity;
        }
        break;
      }

      case 'bypass':
        this.bypassed = msg.value;
        break;

      case 'mute':
        this.muted = msg.value;
        break;
    }
  }

  // ── Pre-compute derived values after param change ─────────────────────────

  _updateDerivedParams() {
    const a = this.params.harmonicEnhance;
    this.heAmount    = a;
    this.heDrive     = 1 + a / 100 * 4;
    this.heTanhDrive = Math.tanh(this.heDrive);
  }

  // ── Single-Pass STFT: forward transform ──────────────────────────────────
  // Fills this.spectrum with the windowed FFT of the current input accumulator.
  // THIS IS THE ONLY CALL TO fft() IN THE ENTIRE PIPELINE.

  _forwardSTFT() {
    const spec = this.spectrum;
    for (let i = 0; i < FFT_SIZE; i++) {
      spec[i * 2]     = this.inputAccum[i] * HANN[i]; // real
      spec[i * 2 + 1] = 0;                            // imag
    }
    fft(spec); // ← SINGLE forward FFT
  }

  // ── In-place spectral processing stages ──────────────────────────────────
  // All operations mutate this.spectrum. No additional FFT calls.

  _spectralProcess() {
    const spec  = this.spectrum;
    const bins  = FFT_SIZE >>> 1; // only positive-frequency bins needed
    const floor = Math.pow(10, this.params.spectralFloor / 20);

    // 1. Compute magnitude spectrum
    const mag = new Float32Array(bins);
    for (let k = 0; k < bins; k++) {
      const re = spec[k * 2];
      const im = spec[k * 2 + 1];
      mag[k] = Math.sqrt(re * re + im * im);
    }

    // 2. Update noise estimate on near-silence frames (power-gated)
    let totalPow = 0;
    for (let k = 0; k < bins; k++) totalPow += mag[k] * mag[k];
    const rms = Math.sqrt(totalPow / bins);
    const threshLin = Math.pow(10, this.params.gateThreshold / 20);

    if (!this.noiseInit || (rms < threshLin * 0.5 && ++this.silentFrames > 8)) {
      const alpha = this.noiseInit ? this.params.nrSmoothing / 1000 + 0.01 : 1;
      for (let k = 0; k < bins; k++) {
        this.noiseEst[k] = alpha * mag[k] + (1 - alpha) * (this.noiseEst[k] || mag[k]);
      }
      this.noiseInit   = true;
      this.silentFrames = 0;
    }

    // 3. Wiener noise reduction mask
    const nrDepth = this.params.nrStrength / 100;
    for (let k = 0; k < bins; k++) {
      const noise    = this.noiseEst[k] + 1e-10;
      const snr      = (mag[k] * mag[k]) / (noise * noise);
      // Wiener gain: snr/(snr+1), scaled by nrDepth
      const wiener   = snr / (snr + 1);
      const gain     = 1 - nrDepth * (1 - wiener);
      const clamped  = Math.max(floor, gain);
      spec[k * 2]     *= clamped;
      spec[k * 2 + 1] *= clamped;
      // Mirror conjugate bin for real-valued iFFT
      if (k > 0 && k < bins) {
        const mIdx = (FFT_SIZE - k) * 2;
        spec[mIdx]     *= clamped;
        spec[mIdx + 1] *= clamped;
      }
    }

    // 4. Spectral gate (hard gate on bins below gating threshold)
    if (this.params.spectralGating > 0) {
      const gateDepth = this.params.spectralGating / 100;
      for (let k = 0; k < bins; k++) {
        const m = Math.sqrt(spec[k*2]*spec[k*2] + spec[k*2+1]*spec[k*2+1]);
        if (m < threshLin * gateDepth) {
          spec[k * 2]     = 0;
          spec[k * 2 + 1] = 0;
          if (k > 0 && k < bins) {
            const mIdx = (FFT_SIZE - k) * 2;
            spec[mIdx]     = 0;
            spec[mIdx + 1] = 0;
          }
        }
      }
    }

    // 5. De-reverb: suppress spectral tail energy
    //    Simple spectral subtraction of a decayed noise floor scaled by amount
    if (this.params.dereverbAmount > 0) {
      const drScale = this.params.dereverbAmount / 100 * 0.6;
      for (let k = 0; k < bins; k++) {
        const re = spec[k * 2], im = spec[k * 2 + 1];
        const m  = Math.sqrt(re * re + im * im);
        const nr = this.noiseEst[k] * drScale;
        const g  = Math.max(0, (m - nr) / (m + 1e-10));
        spec[k * 2]     *= g;
        spec[k * 2 + 1] *= g;
        if (k > 0 && k < bins) {
          const mIdx = (FFT_SIZE - k) * 2;
          spec[mIdx]     *= g;
          spec[mIdx + 1] *= g;
        }
      }
    }
  }

  // ── Single-Pass iSTFT: inverse transform + overlap-add ───────────────────
  // THIS IS THE ONLY CALL TO ifft() IN THE ENTIRE PIPELINE.

  _inverseSTFT() {
    ifft(this.spectrum); // ← SINGLE inverse FFT

    // Overlap-add into olaBuffer
    const ola = this.olaBuffer;
    // Shift OLA buffer left by HOP_SIZE
    ola.copyWithin(0, HOP_SIZE);
    // Zero the incoming tail region
    ola.fill(0, FFT_SIZE);

    // Add windowed synthesis frame
    for (let i = 0; i < FFT_SIZE; i++) {
      ola[i] += this.spectrum[i * 2] * HANN[i] / HANN_SUM_SQ;
    }
  }

  // ── Sample-domain post-processing (per-sample, after iSTFT readout) ──────

  _processSample(sample) {
    // Harmonic enhancer (waveshaping, restores presence after NR)
    if (this.heAmount > 0) {
      const enhanced = Math.tanh(this.heDrive * sample) / this.heTanhDrive;
      sample = (1 - this.heAmount / 100) * sample + (this.heAmount / 100) * enhanced;
    }
    return sample;
  }

  // ── AudioWorkletProcessor.process() ─────────────────────────────────────

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;

    const inCh  = input[0];
    const outCh = output[0];
    const len   = inCh.length; // always 128 in Chrome/Firefox

    // ── Bypass / mute ──
    if (this.muted)    { outCh.fill(0); return true; }
    if (this.bypassed) { outCh.set(inCh); return true; }

    // ── Push raw PCM to ML Worker via inputSAB ──
    if (this.inCtrl !== null) {
      ringPush(this.inCtrl, this.inData, this.inCap, inCh);
      // Wake the ML Worker so it can run inference without polling
      Atomics.notify(this.inCtrl, 0, 1);
    }

    // ── Gate + STFT accumulation ──
    const threshLin    = Math.pow(10, this.params.gateThreshold / 20);
    const rangeLin     = Math.pow(10, this.params.gateRange / 20);
    const attackCoeff  = Math.exp(-1 / (this.params.gateAttack  * 0.001 * sampleRate));
    const releaseCoeff = Math.exp(-1 / (this.params.gateRelease * 0.001 * sampleRate));
    const holdSamples  = Math.floor(this.params.gateHold * 0.001 * sampleRate);

    for (let i = 0; i < len; i++) {
      const s   = inCh[i];
      const abs = Math.abs(s);

      // Gate envelope follower
      let target;
      if (abs > threshLin) {
        target = 1;
        this.holdCounter = holdSamples;
      } else if (this.holdCounter > 0) {
        target = 1;
        this.holdCounter--;
      } else {
        target = rangeLin;
      }
      const coeff  = target > this.gateEnv ? attackCoeff : releaseCoeff;
      this.gateEnv = coeff * this.gateEnv + (1 - coeff) * target;

      // Accumulate gated sample into STFT input buffer
      this.inputAccum[this.accumIdx++] = s * this.gateEnv;

      // When we have a full hop, run the STFT pipeline
      if (this.accumIdx >= HOP_SIZE) {
        // Slide window: copy last FFT_SIZE-HOP_SIZE samples to front
        this.inputAccum.copyWithin(0, HOP_SIZE, FFT_SIZE);
        this.accumIdx = FFT_SIZE - HOP_SIZE; // keep the overlap region filled

        // ── SINGLE forward STFT ──
        this._forwardSTFT();

        // ── In-place spectral operations ──
        this._spectralProcess();

        // ── SINGLE inverse STFT + overlap-add ──
        this._inverseSTFT();
      }
    }

    // ── Pull processed PCM from ML Worker outputSAB (if available) ──
    //    ML output replaces or blends with classical pipeline output.
    let mlFrame = null;
    if (this.outCtrl !== null) {
      mlFrame = ringPull(this.outCtrl, this.outData, this.outCap, len);
    }

    // ── Build output samples ──
    const outGainLin = Math.pow(10, this.params.outputGain / 20);
    const wet        = this.params.dryWet  / 100;
    const dry        = 1 - wet;
    const mlBlend    = this.params.mlStrength / 100;

    for (let i = 0; i < len; i++) {
      // Read from OLA buffer (classical pipeline output)
      let classical = this.olaBuffer[i];
      classical = this._processSample(classical);

      // If ML Worker has produced a frame, blend it in
      let processed = mlFrame
        ? mlBlend * mlFrame[i] + (1 - mlBlend) * classical
        : classical;

      // Dry/wet mix with original input + output gain
      outCh[i] = (dry * inCh[i] + wet * processed) * outGainLin;
    }

    return true; // keep processor alive
  }

  static get parameterDescriptors() {
    // All params are sent via MessagePort for glitch-free updates.
    // AudioParam k-rate descriptors are intentionally empty.
    return [];
  }
}

registerProcessor('dsp-processor', DSPProcessor);
