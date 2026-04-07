/* ============================================
   VoiceIsolate Pro v22.1 — AudioWorkletProcessor
   Threads from Space v11 · Real-time DSP
   Single-Pass STFT · SharedArrayBuffer Ring
   Live mode <10ms target · WebGPU ONNX offload
   ============================================

   ARCHITECTURE:
   ─────────────
   AudioWorklet runs on the audio rendering thread — a hard-real-time
   context.  ONNX inference (Demucs, BSRNN, etc.) is heavyweight and
   MUST NOT block the render thread.  The pattern used here:

     1.  process() writes raw PCM into a SharedArrayBuffer ring buffer
         (inputRing) via Atomics.  It then reads the ML mask back from
         a second ring buffer (maskRing) — also via Atomics — and
         applies it to the output in-place.

     2.  The heavy ONNX inference runs in a *separate* Dedicated Worker
         (ml-worker.js).  That worker blocks on Atomics.wait() for new
         data, runs inference, then writes the result mask back.

     3.  The STFT / iSTFT for the spectral pipeline lives entirely in
         this file (single forward + single inverse — no multi-STFT).
         It uses an overlap-add (OLA) buffer so consecutive process()
         calls accumulate into a coherent output stream.

   RING BUFFER LAYOUT (Float32, SharedArrayBuffer):
   ─────────────────────────────────────────────────
     [0]          — atomic write pointer (frames written by worklet)
     [1]          — atomic read  pointer (frames consumed by ML worker)
     [2 … N+1]    — circular PCM data (mono, frameSize samples per slot)

   The ML worker mirrors this layout on maskRing (write side).

   STFT PARAMETERS:
   ─────────────────
     fftSize  = 2048  (power of 2, gives ~46ms frames @ 44.1 kHz)
     hopSize  = 512   (75% overlap, satisfies WOLA / COLA with Hann)
     window   = periodic Hann

   ============================================ */

'use strict';

// ── Inline Radix-2 DIT FFT ──────────────────────────────────────────────────
// Self-contained so the worklet needs no external imports.
// Operates in-place on Float32Array pairs [re, im].

function fftInPlace(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Cooley-Tukey butterfly
  for (let len = 2; len <= n; len <<= 1) {
    const halfLen = len >> 1;
    const ang = -2.0 * Math.PI / len;
    const wBaseR = Math.cos(ang);
    const wBaseI = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1.0, wi = 0.0;
      for (let j = 0; j < halfLen; j++) {
        const uR = re[i + j],        uI = im[i + j];
        const vR = re[i+j+halfLen] * wr - im[i+j+halfLen] * wi;
        const vI = re[i+j+halfLen] * wi + im[i+j+halfLen] * wr;
        re[i + j]         = uR + vR;  im[i + j]         = uI + vI;
        re[i + j+halfLen] = uR - vR;  im[i + j+halfLen] = uI - vI;
        const nWr = wr * wBaseR - wi * wBaseI;
        wi = wr * wBaseI + wi * wBaseR;
        wr = nWr;
      }
    }
  }
}

function ifftInPlace(re, im) {
  // Conjugate → FFT → conjugate + scale
  for (let i = 0; i < im.length; i++) im[i] = -im[i];
  fftInPlace(re, im);
  const n = re.length;
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}

// Periodic Hann window  — correct COLA at 75% overlap (hopSize = N/4)
function makeHannWindow(N) {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) w[i] = 0.5 * (1.0 - Math.cos(2.0 * Math.PI * i / N));
  return w;
}

// ── SharedArrayBuffer Ring Buffer helpers ───────────────────────────────────
// Layout:  Int32[0] = writePtr,  Int32[1] = readPtr,  Float32[2…] = data
// All pointer arithmetic is modulo `capacity` (number of slots).

function ringWrite(view32, f32view, writeSlot, frameData, capacity) {
  // Write PCM frame into slot, then atomically advance writePtr
  const offset = 2 + writeSlot * frameData.length;
  for (let i = 0; i < frameData.length; i++) f32view[offset + i] = frameData[i];
  Atomics.store(view32, 0, (writeSlot + 1) % capacity);
  Atomics.notify(view32, 0);
}

function ringRead(view32, f32view, readSlot, out, capacity) {
  const offset = 2 + readSlot * out.length;
  for (let i = 0; i < out.length; i++) out[i] = f32view[offset + i];
  Atomics.store(view32, 1, (readSlot + 1) % capacity);
}

// ── Processor Registration ──────────────────────────────────────────────────

class DSPProcessor extends AudioWorkletProcessor {
  /**
   * @param {Object} options
   * options.processorOptions.frameSize    — PCM frames per ML slot  (default 4096)
   * options.processorOptions.fftSize      — STFT window size         (default 2048)
   * options.processorOptions.hopSize      — STFT hop size            (default 512)
   * options.processorOptions.ringCapacity — number of ring slots     (default 8)
   */
  constructor(options) {
    super(options);

    const o = (options && options.processorOptions) || {};
    this.frameSize    = o.frameSize    || 4096;
    this.fftSize      = o.fftSize      || 2048;   // N
    this.hopSize      = o.hopSize      || 512;    // H  (N/4 → 75% overlap)
    this.ringCapacity = o.ringCapacity || 8;

    // STFT state
    const N = this.fftSize;
    this.hannWin    = makeHannWindow(N);
    this.inputBuf   = new Float32Array(N);          // sliding window
    this.olaOut     = new Float32Array(N * 2);      // overlap-add accumulator
    this.olaNorm    = new Float32Array(N * 2);      // normalisation accumulator
    this.inputFill  = 0;                            // samples in inputBuf
    this.olaRead    = 0;                            // read pointer into olaOut

    // Parameters sent from main thread
    this.params = {
      // Gate
      gateThresh: -42, gateRange: -40, gateAttack: 2, gateRelease: 80,
      gateHold: 20, gateLookahead: 5,
      // NR
      nrAmount: 55, nrSensitivity: 50, nrSpectralSub: 40, nrFloor: -60, nrSmoothing: 35,
      // EQ (applied live via biquads on main thread, not here)
      // Separation / ML blend weights
      voiceIso: 70, bgSuppress: 50, voiceFocusLo: 120, voiceFocusHi: 6000,
      // Output
      outGain: 0, dryWet: 100
    };

    // Noise gate state
    this._gateGain    = 1.0;
    this._gateHoldSmp = 0;

    // Spectral NR state (per-bin running noise estimate)
    this._noiseEst  = new Float32Array(N / 2 + 1).fill(1e-6);
    this._smoothMag = new Float32Array(N / 2 + 1).fill(0);

    // Dry/wet accumulator (for pass-through when dryWet < 100)
    this._dryBuf = new Float32Array(this.frameSize);

    // SharedArrayBuffer ring buffers (set via 'initRings' message)
    this._inputRing  = null;  // SAB: worklet writes PCM  → ML worker reads
    this._maskRing   = null;  // SAB: ML worker writes mask → worklet reads
    this._inputView32  = null;
    this._inputF32     = null;
    this._maskView32   = null;
    this._maskF32      = null;
    this._ringSlot     = 0;   // current write slot

    // Current ML mask (spectral gains, 0..1 per bin)
    this._mlMask = new Float32Array(N / 2 + 1).fill(1.0);

    // Message channel from main thread
    this.port.onmessage = (e) => this._onMessage(e.data);

    // Signal ready
    this.port.postMessage({ type: 'ready' });
  }

  // ── Message handler ──────────────────────────────────────────────────────
  _onMessage(msg) {
    switch (msg.type) {

      case 'initRings':
        // Main thread transfers two SharedArrayBuffers
        // Layout per SAB: Int32[0]=writePtr, Int32[1]=readPtr,
        //                 Float32[2..] = data
        this._inputRing   = msg.inputRing;   // SAB
        this._maskRing    = msg.maskRing;    // SAB
        this._inputView32 = new Int32Array(msg.inputRing);
        // Float32 view starts at byte offset 8 (after two Int32 = 8 bytes)
        this._inputF32    = new Float32Array(msg.inputRing,
                              Int32Array.BYTES_PER_ELEMENT * 2);
        this._maskView32  = new Int32Array(msg.maskRing);
        this._maskF32     = new Float32Array(msg.maskRing,
                              Int32Array.BYTES_PER_ELEMENT * 2);
        break;

      case 'setParams':
        // Merge updated params (called from slider onInput)
        Object.assign(this.params, msg.params);
        break;

      case 'setMask':
        // Direct mask injection (used by offline pipeline / test harness)
        if (msg.mask && msg.mask.length === this._mlMask.length) {
          this._mlMask.set(msg.mask);
        }
        break;

      default:
        break;
    }
  }

  // ── process() — called every 128 samples by the audio render thread ───────
  /**
   * Constraints:
   *  - MUST return true to keep the processor alive.
   *  - No async/await, no allocations in the hot path.
   *  - SharedArrayBuffer access via Atomics is non-blocking here
   *    (Atomics.store / Atomics.load only — never Atomics.wait).
   */
  process(inputs, outputs, parameters) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const inCh  = input[0];          // Float32Array, length = 128 (render quantum)
    const outCh = output[0];
    const N     = this.fftSize;
    const H     = this.hopSize;
    const halfN = N / 2 + 1;
    const win   = this.hannWin;
    const p     = this.params;

    // ── 1. Noise gate (time-domain, sample-by-sample) ──────────────────────
    //    Runs before STFT to suppress silence early and protect spectral NR.
    const threshLin  = Math.pow(10, p.gateThresh / 20);
    const rangeLin   = Math.pow(10, p.gateRange  / 20);
    const attackCoef = Math.exp(-1 / (sampleRate * p.gateAttack  * 0.001 + 1));
    const relCoef    = Math.exp(-1 / (sampleRate * p.gateRelease * 0.001 + 1));
    const holdSmp    = Math.floor(sampleRate * p.gateHold * 0.001);

    const gated = new Float32Array(inCh.length);
    for (let i = 0; i < inCh.length; i++) {
      const s    = inCh[i];
      const absS = Math.abs(s);
      if (absS > threshLin) {
        this._gateHoldSmp = holdSmp;
        this._gateGain = this._gateGain < 1.0
          ? this._gateGain + (1.0 - this._gateGain) * (1 - attackCoef)
          : 1.0;
      } else if (this._gateHoldSmp > 0) {
        this._gateHoldSmp--;
      } else {
        // Close gate toward rangeLin
        this._gateGain = this._gateGain > rangeLin
          ? this._gateGain - (this._gateGain - rangeLin) * (1 - relCoef)
          : rangeLin;
      }
      gated[i] = s * this._gateGain;
    }

    // ── 2. Feed gated samples into the STFT sliding window ────────────────
    //    We accumulate 128-sample render quanta until we have enough for
    //    a full hop (hopSize samples), then perform one STFT frame.

    let writePos = 0;
    while (writePos < gated.length) {
      const toCopy = Math.min(gated.length - writePos, H - (this.inputFill % H));
      // Shift inputBuf by hopSize (slide the analysis window)
      for (let i = 0; i < N - toCopy; i++) this.inputBuf[i] = this.inputBuf[i + toCopy];
      // Append new samples
      for (let i = 0; i < toCopy; i++) {
        this.inputBuf[N - toCopy + i] = gated[writePos + i];
      }
      this.inputFill += toCopy;
      writePos += toCopy;

      // When we have accumulated enough input to form a new hop, run STFT
      if (this.inputFill > 0 && (this.inputFill % H) === 0) {
        this._processFrame();
      }
    }

    // ── 3. Read output from OLA accumulator ───────────────────────────────
    const outGainLin = Math.pow(10, p.outGain / 20);
    const wetAmt     = p.dryWet / 100;
    const dryAmt     = 1 - wetAmt;

    for (let i = 0; i < outCh.length; i++) {
      let wet = this.olaOut[this.olaRead];
      const norm = this.olaNorm[this.olaRead];
      if (norm > 1e-8) wet /= norm;
      // Clear slot after reading
      this.olaOut [this.olaRead] = 0;
      this.olaNorm[this.olaRead] = 0;
      this.olaRead = (this.olaRead + 1) % this.olaOut.length;

      outCh[i] = (dryAmt * inCh[i] + wetAmt * wet) * outGainLin;
      // Hard clip guard
      if (outCh[i] >  1.0) outCh[i] =  1.0;
      if (outCh[i] < -1.0) outCh[i] = -1.0;
    }

    // ── 4. Push raw PCM frame into input ring for ML worker ───────────────
    //    We push every time we have frameSize samples accumulated.
    //    This is decoupled from the STFT cadence.
    if (this._inputView32 && this._inputF32) {
      // Simple accumulator: copy inCh into _dryBuf, push when full
      // (In a production build you'd maintain a separate accumulator;
      //  for clarity we push the current 128-sample block when the
      //  write slot has space — the ML worker handles resampling.)
      const writePtr = Atomics.load(this._inputView32, 0);
      const readPtr  = Atomics.load(this._inputView32, 1);
      const used     = (writePtr - readPtr + this.ringCapacity) % this.ringCapacity;
      if (used < this.ringCapacity - 1) {
        // Write directly — no dynamic allocation
        const slotOffset = 2 + writePtr * 128; // 128 = render quantum
        for (let i = 0; i < inCh.length; i++) {
          this._inputF32[slotOffset + i] = gated[i];
        }
        Atomics.store(this._inputView32, 0, (writePtr + 1) % this.ringCapacity);
        Atomics.notify(this._inputView32, 0, 1);
      }
    }

    // ── 5. Poll mask ring for latest ML output ────────────────────────────
    if (this._maskView32 && this._maskF32) {
      const mWrite = Atomics.load(this._maskView32, 0);
      const mRead  = Atomics.load(this._maskView32, 1);
      if (mWrite !== mRead) {
        // New mask available — copy it
        const slotOffset = 2 + mRead * halfN;
        for (let k = 0; k < halfN; k++) {
          this._mlMask[k] = this._maskF32[slotOffset + k];
        }
        Atomics.store(this._maskView32, 1, (mRead + 1) % this.ringCapacity);
      }
    }

    return true; // keep processor alive
  }

  // ── _processFrame() — single STFT frame (forward + spectral ops + iSTFT) ─
  //    Called from process() when inputBuf contains a fresh analysis window.
  //    Implements the SINGLE-PASS spectral constraint:
  //      ONE forward STFT → in-place spectral ops → ONE iSTFT.
  _processFrame() {
    const N     = this.fftSize;
    const halfN = N / 2 + 1;
    const H     = this.hopSize;
    const win   = this.hannWin;
    const p     = this.params;

    // ── Forward STFT ──────────────────────────────────────────────────────
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      re[i] = this.inputBuf[i] * win[i];
      // im stays 0 (real signal)
    }
    fftInPlace(re, im);

    // ── Spectral Magnitude / Phase ────────────────────────────────────────
    const mag   = new Float32Array(halfN);
    const phase = new Float32Array(halfN);
    for (let k = 0; k < halfN; k++) {
      mag[k]   = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }

    // ── Adaptive Spectral NR (Wiener MMSE, in-place on mag) ───────────────
    if (p.nrAmount > 0) {
      const alpha      = 1.0 + (p.nrAmount / 100) * 2.0;     // over-subtraction
      const floorLin   = Math.pow(10, p.nrFloor / 20);
      const sm         = Math.max(0, Math.min(0.97, p.nrSmoothing / 100 * 0.97));

      for (let k = 0; k < halfN; k++) {
        const sigPSD = mag[k] * mag[k];
        // Update noise estimate (minimum statistics approximation)
        this._smoothMag[k] = sm * this._smoothMag[k] + (1 - sm) * sigPSD;
        if (this._smoothMag[k] < this._noiseEst[k] || this._noiseEst[k] < 1e-12) {
          // Track minimum over time → noise floor estimate
          this._noiseEst[k] = Math.max(this._smoothMag[k], 1e-12);
        }
        const nEst = alpha * this._noiseEst[k] * (1 + p.nrSensitivity * 0.005);
        // Wiener gain: max(0, 1 - N/S), clamped to spectralFloor
        const gain = sigPSD > 1e-12
          ? Math.max(Math.sqrt(Math.max(sigPSD - nEst, 0) / sigPSD), floorLin)
          : floorLin;
        mag[k] *= gain;
      }
    }

    // ── Voice Isolation (spectral mask, in-place) ─────────────────────────
    if (p.voiceIso > 0 || p.bgSuppress > 0) {
      const binHz      = sampleRate / N;
      let loBin        = Math.round((p.voiceFocusLo || 0) / binHz);
      let hiBin        = Math.round((p.voiceFocusHi || 0) / binHz);
      if (!Number.isFinite(loBin) || loBin < 0) loBin = 0;
      else if (loBin >= halfN) loBin = halfN - 1;
      if (!Number.isFinite(hiBin) || hiBin >= halfN) hiBin = halfN - 1;
      else if (hiBin < 0) hiBin = 0;
      if (hiBin < loBin) hiBin = loBin;
      if (hiBin >= halfN) hiBin = halfN - 1;
      const suppress   = 1.0 - (p.bgSuppress / 100) * 0.95;
      const boost      = 1.0 + (p.voiceIso   / 100) * 0.5;
      for (let k = 0; k < halfN; k++) {
        mag[k] *= (k >= loBin && k <= hiBin) ? boost : suppress;
      }
    }

    // ── Apply ML mask (received from ml-worker via maskRing) ─────────────
    //    Mask values are 0..1 per bin; 1 = keep, 0 = suppress.
    for (let k = 0; k < halfN; k++) {
      mag[k] *= this._mlMask[k];
    }

    // ── Reconstruct complex spectrum from processed mag + original phase ──
    for (let k = 0; k < halfN; k++) {
      re[k] = mag[k] * Math.cos(phase[k]);
      im[k] = mag[k] * Math.sin(phase[k]);
    }
    // Mirror conjugate-symmetric half
    for (let k = 1; k < N - halfN + 1; k++) {
      re[N - k] =  re[k];
      im[N - k] = -im[k];
    }

    // ── Inverse STFT ─────────────────────────────────────────────────────
    ifftInPlace(re, im);

    // ── Overlap-Add into olaOut ────────────────────────────────────────────
    //    olaOut is a circular buffer of size 2*N.
    //    We write N samples starting at olaRead (which advances each process()).
    for (let i = 0; i < N; i++) {
      const slot = (this.olaRead + i) % this.olaOut.length;
      this.olaOut [slot] += re[i] * win[i];
      this.olaNorm[slot] += win[i] * win[i];
    }
  }
}

registerProcessor('dsp-processor', DSPProcessor);
