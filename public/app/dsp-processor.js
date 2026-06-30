/**
 * VoiceIsolate Pro — dsp-processor.js
 * AudioWorkletProcessor: Threads from Space v8
 * ==========================================================
 * Architecture:
 *   1. Accumulate 128-sample quanta into a 4096-pt ring buffer (mono mix)
 *   2. Every HOP_SIZE (1024) new samples: apply periodic Hann window + single
 *      forward FFT (one STFT per hop — strict single-pass constraint)
 *   3. Post mag+phase frame to main thread via SharedArrayBuffer
 *      (main thread routes to ml-worker.js for ONNX inference)
 *   4. Read ML mask back from output SAB (written by ml-worker) non-blocking
 *   5. Reconstruct complex spectrum via polar form: re=mag*cos(pha), im=mag*sin(pha)
 *      Restore conjugate symmetry for DC, positive bins, and Nyquist
 *   6. Single inverse FFT (iSTFT) → synthesis Hann window → overlap-add
 *      Output ring write pointer advances by HOP_SIZE only
 *   7. Drain 128 samples per quantum from output ring with brickwall limiter
 *
 * FIXES applied (2026-05-14):
 *   [1] OLA write pointer: was += FFT_SIZE, now += HOP_SIZE  (destroyed overlap)
 *   [2] Frame trigger: was `if (_filled >= FFT_SIZE)`, now `while` loop
 *       + dedicated _inRd cursor advancing by HOP_SIZE  (non-overlapping blocks)
 *   [3] Phase reconstruction: was scalar multiply on re/im, now polar re-synthesis
 *       (mag*cos(pha), mag*sin(pha)) — preserves phase fidelity
 *   [4] Buffer transfer bug: mag.buffer was transferred (detached) before use,
 *       now cloned via slice() for postMessage fallback
 *   [5] Periodic Hann window: denominator was N-1 (asymmetric), now N (periodic)
 *       required for energy-preserving OLA at 75% overlap
 *   [6] DC/Nyquist bins: excluded from conjugate symmetry loop, handled explicitly
 *
 * SharedArrayBuffer layout (Int32 header + Float32 payload):
 *   inputSAB:
 *     [  0 ..  19]  Int32 flags (5 slots × 4 bytes): [writeGen, readGen, capacity, halfN, reserved]
 *     [ 20 ..  20+HALF_BINS*4)           mag (Float32 × HALF_BINS)
 *     [ 20+HALF_BINS*4 ..  20+HALF_BINS*8)  pha (Float32 × HALF_BINS)
 *     [ 20+HALF_BINS*8 ..  20+HALF_BINS*8+HOP_SIZE*4)  pcm (Float32 × HOP_SIZE — newest mono hop)
 *   outputSAB:
 *     [  0 ..  19]  Int32 flags (5 slots × 4 bytes): [writeGen, readGen, capacity, halfN, reserved]
 *     [ 20 ..  20+HALF_BINS*4)  mask (Float32 × HALF_BINS, values 0..1)
 */

const FFT_SIZE   = 4096;
const HOP_SIZE   = 1024;           // 75% overlap
const HALF_BINS  = FFT_SIZE / 2 + 1;
const RENDER_QUANTUM = 128;
const STARTUP_PRIME_SAMPLES = HOP_SIZE - RENDER_QUANTUM;
const FLAG_SLOTS = 5;                                                   // Bug #2 fix: 5 slots = 20 bytes, matches SharedRingBuffer header
const SAB_HEADER_BYTES = Int32Array.BYTES_PER_ELEMENT * FLAG_SLOTS;     // 20

// ─── OLA normalisation scalar for periodic Hann at 75% overlap ───────────────
// sum of (unsquared) Hann windows spaced HOP apart = FFT_SIZE / (2 * HOP_SIZE) = 2.0
// So we divide by 2 during synthesis to normalise energy
const OLA_NORM = 1.0 / (FFT_SIZE / (2.0 * HOP_SIZE)); // = 0.5

// ─── In-place Cooley-Tukey radix-2 FFT (worklet-safe, no imports) ─────────────
function fftInPlace(re, im, inverse = false) {
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
  // Butterfly stages
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const ang  = (inverse ? 2 : -2) * Math.PI / len;
    const wRe  = Math.cos(ang);
    const wIm  = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i+k],                       uIm = im[i+k];
        const vRe = re[i+k+half]*cRe - im[i+k+half]*cIm;
        const vIm = re[i+k+half]*cIm + im[i+k+half]*cRe;
        re[i+k]      = uRe + vRe;  im[i+k]      = uIm + vIm;
        re[i+k+half] = uRe - vRe;  im[i+k+half] = uIm - vIm;
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

/**
 * FIX [5]: Periodic (DFT-even) Hann window — denominator N, not N-1.
 * With 75% overlap the sum of squared windows = FFT_SIZE / (2*HOP_SIZE) = 2.
 * Using N-1 (symmetric window) breaks this identity and causes amplitude ripple.
 */
function makeHannWindow(N) {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / N)); // periodic form
  }
  return w;
}

// [WHISPER UPDATE] Inline WhisperHunterAI for worklet context (Part 4)
function _whSigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function _mapWhisperUi(ui) {
  const u = Math.max(0, Math.min(100, Number(ui) || 0));
  return _whSigmoid((u - 50) / 15);
}
class WhisperHunterCore {
  constructor(fftSize, sampleRate) {
    this.halfBins = fftSize / 2 + 1;
    this.sampleRate = sampleRate;
    this.fftSize = fftSize;
    this.noiseFloor = 0;
    this.noisePsd = new Float32Array(this.halfBins);
    this._alpha = 0.95;
    this._scBinThreshold = Math.round(800 / (sampleRate / fftSize));
    this._epsilon = 1e-10;
    this._f0Est = 220;
  }
  processFrame(re, im, params) {
    const halfN = this.halfBins;
    let energy = 0; let scNum = 0; let scDen = 0;
    const mags = new Float32Array(halfN);
    for (let k = 0; k < halfN; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mags[k] = mag;
      energy += mag * mag;
      scNum += k * mag; scDen += mag;
    }
    energy /= halfN;
    const sc = scDen > 1e-12 ? scNum / scDen : 0;
    const thetaE = Math.max(this.noiseFloor * (params.sensitivity ?? 0.5), 1e-12);
    const vad = (energy > thetaE * 0.08) && (sc > this._scBinThreshold) ? 1 : 0;
    if (!vad) {
      this.noiseFloor = this._alpha * this.noiseFloor + (1 - this._alpha) * energy;
      for (let k = 0; k < halfN; k++) {
        this.noisePsd[k] = this._alpha * this.noisePsd[k] + (1 - this._alpha) * mags[k] * mags[k];
      }
      return 0;
    }
    const wStr = 1 + 2 * (params.threshold ?? 0.5);
    const binHz = this.sampleRate / this.fftSize;
    for (let k = 0; k < halfN; k++) {
      const sigPow = mags[k] * mags[k];
      let gain = Math.pow(Math.max(0, 1 - this.noisePsd[k] / (sigPow + this._epsilon)), wStr);
      gain = Math.max(params.clarity ?? 0.5, gain);
      re[k] *= gain; im[k] *= gain;
    }
    const pHarm = params.harmonic ?? 0;
    if (pHarm > 0.1) {
      for (let h = 1; h <= 4; h++) {
        const kh = Math.round((h * this._f0Est) / binHz);
        if (kh > 0 && kh < halfN) {
          const b = 1 + pHarm * 0.5;
          re[kh] *= b; im[kh] *= b;
        }
      }
    }
    return 1;
  }
}

class DSPProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this._re  = new Float32Array(FFT_SIZE);
    this._im  = new Float32Array(FFT_SIZE);
    this._win = makeHannWindow(FFT_SIZE);

    // Input ring: large enough for FFT_SIZE look-back + one full write burst
    this._inRing = new Float32Array(FFT_SIZE * 4);
    // Startup primer: synthesize one FFT window of silence so first frame timing is deterministic.
    this._inRing.fill(0, 0, FFT_SIZE);
    this._inRd   = 0;        // FIX [2]: read/frame-start cursor — advances by HOP_SIZE
    this._inWr   = FFT_SIZE; // Pre-filled with FFT_SIZE zeros for deterministic startup latency
                               // _inWr=FFT_SIZE means FFT_SIZE primer samples are treated as already written.

    // Output ring: large enough for several overlapping frames in flight
    this._outRing = new Float32Array(FFT_SIZE * 8);
    this._outRd   = 0;
    this._outWr   = 0;

    // How many new samples have arrived since last frame trigger
    this._newSamples = STARTUP_PRIME_SAMPLES; // primes hop counter so the first render quantum can emit a frame

    // SABs — injected via port 'initSAB' message
    this._inputSAB    = null;
    this._outputSAB   = null;
    this._inputFlags  = null;
    this._outputFlags = null;
    this._inputView   = null;  // Float32[HALF_BINS*2]: mag then pha
    this._outputView  = null;  // Float32[HALF_BINS]:   mask values 0..1
    this._pcmView     = null;  // Float32[HOP_SIZE]:    raw PCM region (Bug #3)

    // DSP params — updated live via port 'params' message
    this._params = {
      outGain:     0.0,   // dB
      dryWet:      1.0,   // 0=dry, 1=wet
      nrAmount:    0.78,
      gateThresh:  -42,   // dBFS
      gateRange:   -60,   // dB attenuation below gate
      hpFreq:      80,    // Hz
      lpFreq:      18000, // Hz
      compThresh:  -24,   // dBFS
      compRatio:   4,
      compAttack:  10,    // ms
      compRelease: 150,   // ms
      compKnee:    6,     // dB
      compMakeup:  0,     // dB
      limThresh:   -1,    // dBFS
      specTilt:    0.0,   // dB/oct
      eqSub:       0.0,
      eqBass:      0.0,
      eqWarmth:    0.0,
      eqBody:      0.0,
      eqLowMid:    0.0,
      eqMid:       0.0,
      eqPresence:  0.0,
      eqClarity:   0.0,
      eqAir:       0.0,
      eqBrill:     0.0,
      whisperLift: 18,
      crowdNull:   72,
      bassCrush:   90,
      reverbStrip: 600,
      voiceTunnel: 65,
      musicKill:   80,
      snrFloor:    -52,
      whisperMode: 2,
      whisperClarity: 65,
      whisperSensitivity: 55,
      whisperThreshold: 50,
      harmRecov: 0
    };

    const sRateInit = typeof sampleRate !== 'undefined' ? sampleRate : 48000;
    this._whisperHunter = new WhisperHunterCore(FFT_SIZE, sRateInit);

    // [WHISPER UPDATE] Circular magnitude buffer for music-kill median tracking
    this._circularMagBuffer = Array.from({ length: 5 }, () => new Float32Array(HALF_BINS));
    this._frameIdx = 0;
    this._noiseProfile = new Float32Array(HALF_BINS);

    // Define reasonable safety bounds for DSP stability
    this._bounds = {
      outGain:     [-60, 24],
      dryWet:      [0, 1],
      nrAmount:    [0, 1],
      gateThresh:  [-120, 0],
      gateRange:   [-120, 0],
      hpFreq:      [10, 20000],
      lpFreq:      [10, 20000],
      compThresh:  [-120, 0],
      compRatio:   [1, 100],
      compAttack:  [0.1, 1000],
      compRelease: [1, 5000],
      compKnee:    [0, 24],
      compMakeup:  [-24, 24],
      limThresh:   [-60, 0],
      specTilt:    [-12, 12],
      eqSub:       [-24, 24],
      eqBass:      [-24, 24],
      eqWarmth:    [-24, 24],
      eqBody:      [-24, 24],
      eqLowMid:    [-24, 24],
      eqMid:       [-24, 24],
      eqPresence:  [-24, 24],
      eqClarity:   [-24, 24],
      eqAir:       [-24, 24],
      eqBrill:     [-24, 24],
      whisperLift: [0, 40],
      crowdNull:   [0, 100],
      bassCrush:   [0, 100],
      reverbStrip: [0, 2000],
      voiceTunnel: [0, 100],
      musicKill:   [0, 100],
      snrFloor:    [-80, -20],
      whisperMode: [0, 3],
      whisperClarity: [0, 100],
      whisperSensitivity: [0, 100],
      whisperThreshold: [0, 100],
      harmRecov: [0, 100]
    };

    // Gate hold state: prevents clicking on rapid gate transitions
    this._gateHoldSamples = 0;
    const GATE_HOLD_MS    = 20;
    this._GATE_HOLD_LEN   = Math.round((GATE_HOLD_MS / 1000) * sampleRate);

    // Compressor envelope state
    this._envDb  = 0;
    this._gainDb = 0;

    this.port.onmessage = (ev) => this._onMessage(ev.data);
  }

  // ── Message handler ────────────────────────────────────────────────────────
  _onMessage(msg) {
    if (!msg) return;
    switch (msg.type) {
      case 'initSAB': {
        this._inputSAB    = msg.inputSAB;
        this._outputSAB   = msg.outputSAB;
        this._inputFlags  = new Int32Array(this._inputSAB,  0, FLAG_SLOTS);
        this._outputFlags = new Int32Array(this._outputSAB, 0, FLAG_SLOTS);
        // mag stored at [0..HALF_BINS), pha at [HALF_BINS..HALF_BINS*2)
        this._inputView   = new Float32Array(this._inputSAB,  SAB_HEADER_BYTES, HALF_BINS * 2);
        this._outputView  = new Float32Array(this._outputSAB, SAB_HEADER_BYTES, HALF_BINS);
        // Bug #3: PCM region immediately after mag+pha payload
        const pcmByteOffset = SAB_HEADER_BYTES + HALF_BINS * 2 * Float32Array.BYTES_PER_ELEMENT;
        if (this._inputSAB.byteLength >= pcmByteOffset + HOP_SIZE * Float32Array.BYTES_PER_ELEMENT) {
          this._pcmView = new Float32Array(this._inputSAB, pcmByteOffset, HOP_SIZE);
        }
        this.port.postMessage({ type: 'sabReady', inputSAB: this._inputSAB, outputSAB: this._outputSAB });
        break;
      }
      case 'setParams':
      case 'params': {
        const payload = msg.payload || msg.params;
        if (payload) {
          for (const [k, v] of Object.entries(payload)) {
            if (k in this._params && k in this._bounds) {
              const val = Number(v);
              if (Number.isFinite(val)) {
                this._params[k] = Math.max(this._bounds[k][0], Math.min(this._bounds[k][1], val));
              }
            }
          }
        }
        break;
      }
      case 'param': {
        const { id, value } = msg;
        if (typeof id === 'string' && id in this._params && id in this._bounds) {
          const val = Number(value);
          if (Number.isFinite(val)) {
            this._params[id] = Math.max(this._bounds[id][0], Math.min(this._bounds[id][1], val));
          }
        }
        break;
      }
    }
  }

  // ── Main audio callback (called every 128 samples by the Web Audio engine) ──
  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const outCh = output[0];
    const Q     = outCh.length; // always 128

    // Mix to mono: average all available input channels
    const numCh = input.length;
    const mono   = new Float32Array(Q);
    for (let c = 0; c < numCh; c++) {
      const ch = input[c];
      for (let i = 0; i < Q; i++) mono[i] += ch[i];
    }
    if (numCh > 1) {
      for (let i = 0; i < Q; i++) mono[i] /= numCh;
    }

    // Noise gate with hold to prevent clicks
    let rms = 0;
    for (let i = 0; i < Q; i++) rms += mono[i] * mono[i];
    rms = Math.sqrt(rms / Q);
    const rmsDb = rms > 0 ? 20.0 * Math.log10(rms) : -160.0;
    const belowGate = rmsDb < this._params.gateThresh;

    if (!belowGate) {
      this._gateHoldSamples = this._GATE_HOLD_LEN;
    } else if (this._gateHoldSamples > 0) {
      this._gateHoldSamples -= Q;
    }
    const gated = belowGate && this._gateHoldSamples <= 0;

    // Write mono (or silence) into input ring
    const inLen = this._inRing.length;
    for (let i = 0; i < Q; i++) {
      this._inRing[this._inWr] = gated ? 0.0 : mono[i];
      this._inWr = (this._inWr + 1) % inLen;
    }
    this._newSamples += Q;

    // FIX [2]: trigger a new frame for every HOP_SIZE new samples accumulated
    while (this._newSamples >= HOP_SIZE) {
      this._processFrame();
      this._newSamples -= HOP_SIZE;
    }

    // Drain output ring into output channel(s)
    const outLen  = this._outRing.length;
    const avail   = (this._outWr - this._outRd + outLen) % outLen;
    const outGain = Math.pow(10.0, (this._params.outGain || 0.0) / 20.0);
    const lim     = Math.pow(10.0, (this._params.limThresh || -1.0) / 20.0);

    // Compressor parameters
    const ct = this._params.compThresh || -24;
    const cr = this._params.compRatio || 4;
    const ck = Math.max(0, this._params.compKnee || 0);
    const sr = typeof sampleRate !== 'undefined' ? sampleRate : 48000;
    const cAtk = Math.exp(-1 / ((this._params.compAttack || 10) * sr / 1000));
    const cRel = Math.exp(-1 / ((this._params.compRelease || 150) * sr / 1000));
    const cMakeup = Math.pow(10.0, (this._params.compMakeup || 0) / 20.0);

    if (avail >= Q) {
      for (let i = 0; i < Q; i++) {
        let s = this._outRing[this._outRd];
        // Zero the slot as we read it (ring reuse)
        this._outRing[this._outRd] = 0.0;
        this._outRd = (this._outRd + 1) % outLen;

        // Compressor logic
        const sDb = 20 * Math.log10(Math.abs(s) + 1e-9);
        let gainReduction = 0;
        if (cr > 1) {
          const halfKnee = ck * 0.5;
          if (ck > 0 && Math.abs(sDb - ct) < halfKnee) {
            const over = sDb - ct + halfKnee;
            gainReduction = (1 - 1 / cr) * (over * over) / (2 * ck);
          } else if (sDb > ct + halfKnee) {
            gainReduction = (sDb - ct) * (1 - 1 / cr);
          }
        }
        if (gainReduction > this._envDb) {
           this._envDb = cAtk * this._envDb + (1 - cAtk) * gainReduction;
        } else {
           this._envDb = cRel * this._envDb + (1 - cRel) * gainReduction;
        }
        s *= Math.pow(10.0, -this._envDb / 20.0) * cMakeup * outGain;

        // Brickwall limiter
        if (s >  lim) s =  lim;
        if (s < -lim) s = -lim;
        
        // Dry/Wet mixing
        const dryWet = typeof this._params.dryWet === 'number' ? this._params.dryWet : 1.0;
        outCh[i] = mono[i] * (1.0 - dryWet) + s * dryWet;
      }
    } else {
      // Pipeline latency — not enough processed samples yet.
      // Output scaled dry signal only.
      const dryWet = typeof this._params.dryWet === 'number' ? this._params.dryWet : 1.0;
      for (let i = 0; i < Q; i++) {
        outCh[i] = mono[i] * (1.0 - dryWet);
      }
    }

    // Copy mono output to all output channels (worklet may have stereo outputs)
    for (let c = 1; c < output.length; c++) {
      output[c].set(outCh);
    }

    return true;
  }

  // ── Spectral processing frame (one hop) ────────────────────────────────────
  _processFrame() {
    const inLen = this._inRing.length;

    // FIX [2]: read FFT_SIZE samples starting from _inRd (the frame start cursor)
    // _inRd points to the oldest sample of this frame window
    const frameStart = this._inRd;
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (frameStart + i) % inLen;
      this._re[i] = this._inRing[idx] * this._win[i]; // analysis window
      this._im[i] = 0.0;
    }
    // Advance read cursor by one hop so next frame is offset by HOP_SIZE
    this._inRd = (this._inRd + HOP_SIZE) % inLen;

    // SINGLE-PASS STFT BOUNDARY
    // Forward transform entry for the canonical live AudioWorklet path.
    fftInPlace(this._re, this._im, false);

    // Convert to polar: magnitude + phase for all positive bins + DC + Nyquist
    const mag = new Float32Array(HALF_BINS);
    const pha = new Float32Array(HALF_BINS);
    for (let k = 0; k < HALF_BINS; k++) {
      mag[k] = Math.sqrt(this._re[k] * this._re[k] + this._im[k] * this._im[k]);
      pha[k] = Math.atan2(this._im[k], this._re[k]);
    }

    // Non-blocking read of ML mask from output SAB
    let mask = null;
    if (this._outputView && this._outputFlags) {
      const writeGen = Atomics.load(this._outputFlags, 0);
      const readGen  = Atomics.load(this._outputFlags, 1);
      if (writeGen !== readGen) {
        mask = new Float32Array(HALF_BINS);
        mask.set(this._outputView.subarray(0, HALF_BINS));
        Atomics.store(this._outputFlags, 1, writeGen); // acknowledge
      }
    }

    // Write mag+pha+pcm to input SAB for main thread → ml-worker inference
    if (this._inputView && this._inputFlags) {
      this._inputView.set(mag, 0);            // mag at offset 0
      this._inputView.set(pha, HALF_BINS);    // pha at offset HALF_BINS
      // Bug #3: copy the NEWEST HOP_SIZE raw samples (end of the analysis window)
      // into the PCM region so ml-worker delivers temporally-aligned PCM to Demucs.
      // Two-slice copy avoids per-sample modulo in the AudioWorklet hot path.
      if (this._pcmView) {
        const pcmStart = (frameStart + FFT_SIZE - HOP_SIZE) % inLen;
        const toEnd = inLen - pcmStart;
        if (toEnd >= HOP_SIZE) {
          this._pcmView.set(this._inRing.subarray(pcmStart, pcmStart + HOP_SIZE));
        } else {
          this._pcmView.set(this._inRing.subarray(pcmStart, pcmStart + toEnd));
          this._pcmView.set(this._inRing.subarray(0, HOP_SIZE - toEnd), toEnd);
        }
      }
      Atomics.add(this._inputFlags, 0, 1);    // bump write generation

      // FIX [4]: fallback postMessage for pre-SAB frames — clone buffer, do NOT transfer
      if (Atomics.load(this._inputFlags, 0) <= 2) {
        this.port.postMessage({ type: 'magnitude', mag: mag.slice().buffer });
      }
    }

    // [WHISPER UPDATE] Extreme isolation spectral ops (Steps A–E, in-place before mask)
    const params = this._params;
    const sRate = typeof sampleRate !== 'undefined' ? sampleRate : 48000;
    const numBins = HALF_BINS;

    const bassCrushCutoff = Math.round((params.bassCrush / 100) * 0.045 * FFT_SIZE);
    for (let k = 0; k < bassCrushCutoff; k++) mag[k] *= 0.0001;

    const frameMedian = new Float32Array(numBins);
    const bufIdx = this._frameIdx % 5;
    const vals = new Float32Array(5);
    for (let k = 0; k < numBins; k++) {
      vals[0] = this._circularMagBuffer[0][k];
      vals[1] = this._circularMagBuffer[1][k];
      vals[2] = this._circularMagBuffer[2][k];
      vals[3] = this._circularMagBuffer[3][k];
      vals[4] = this._circularMagBuffer[4][k];
      vals.sort();
      frameMedian[k] = vals[2];
      const ratio = mag[k] / (frameMedian[k] + 1e-10);
      if (ratio < 1.3) mag[k] *= (1 - params.musicKill / 100);
    }
    this._circularMagBuffer[bufIdx].set(mag);
    this._frameIdx++;

    const crowdLowBin = Math.round(200 / (sRate / FFT_SIZE));
    const crowdHighBin = Math.round(2500 / (sRate / FFT_SIZE));
    const crowdOSF = 1.5 + (params.crowdNull / 100) * 4.5;
    const crowdFloor = 0.005;
    for (let k = crowdLowBin; k < crowdHighBin; k++) {
      const suppressed = mag[k] - crowdOSF * this._noiseProfile[k];
      mag[k] = Math.max(suppressed, crowdFloor * mag[k]);
      this._noiseProfile[k] = this._noiseProfile[k] * 0.99 + mag[k] * 0.01;
    }

    const frameTimeSec = HOP_SIZE / sRate;
    const rt60Sec = Math.max(params.reverbStrip / 1000, 0.001);
    const decayMask = Math.exp(-Math.log(1000) * frameTimeSec / rt60Sec);
    const revAmt = params.reverbStrip > 0 ? (1 - decayMask) * 0.9 : 0;
    const revMultiplier = 1 - revAmt;
    for (let k = 0; k < numBins; k++) {
      mag[k] *= revMultiplier;
    }

    const snrThresh = Math.pow(10, params.snrFloor / 20);
    for (let k = 0; k < numBins; k++) {
      if (mag[k] < snrThresh) mag[k] = 0;
    }

    const wmModes = {
      0: { maskFloor: 0.15, postGain: 1.0 },
      1: { maskFloor: 0.08, postGain: 3.2 },
      2: { maskFloor: 0.03, postGain: 8.0 },
      3: { maskFloor: 0.005, postGain: 18.0 },
    };
    const wm = wmModes[Math.round(params.whisperMode)] || wmModes[2];

    // Build masked magnitude spectrum
    const maskedMag = new Float32Array(HALF_BINS);
    if (mask) {
      for (let k = 0; k < HALF_BINS; k++) {
        const m = Math.max(wm.maskFloor, Math.min(1.0, mask[k]));
        maskedMag[k] = mag[k] * m;
      }
    } else {
      const alpha = this._params.nrAmount || 0.0;
      const factor = Math.max(0.0, 1.0 - alpha * 0.5);
      for (let k = 0; k < HALF_BINS; k++) {
        maskedMag[k] = mag[k] * Math.max(wm.maskFloor, factor);
      }
    }

    // [WHISPER UPDATE] Step F — whisper lift on high-confidence mask bins
    const liftGain = Math.pow(10, params.whisperLift / 20) * wm.postGain;
    for (let k = 0; k < HALF_BINS; k++) {
      const m = mask ? Math.max(0.0, Math.min(1.0, mask[k])) : 0.6;
      if (m > 0.55) maskedMag[k] *= liftGain;
    }

    // ── Spectral EQ & Filters ──
    const binHz = sRate / FFT_SIZE;

    const eq = [
      Math.pow(10, (this._params.eqSub || 0)/20),
      Math.pow(10, (this._params.eqBass || 0)/20),
      Math.pow(10, (this._params.eqWarmth || 0)/20),
      Math.pow(10, (this._params.eqBody || 0)/20),
      Math.pow(10, (this._params.eqLowMid || 0)/20),
      Math.pow(10, (this._params.eqMid || 0)/20),
      Math.pow(10, (this._params.eqPresence || 0)/20),
      Math.pow(10, (this._params.eqClarity || 0)/20),
      Math.pow(10, (this._params.eqAir || 0)/20),
      Math.pow(10, (this._params.eqBrill || 0)/20)
    ];

    const hpFreq = this._params.hpFreq || 80;
    const lpFreq = this._params.lpFreq || 18000;
    const tilt = this._params.specTilt || 0; 

    for (let k = 0; k < HALF_BINS; k++) {
      const hz = k * binHz;
      let gain = 1.0;

      // Graphic EQ
      if      (hz < 60) gain *= eq[0];
      else if (hz < 200) gain *= eq[1];
      else if (hz < 500) gain *= eq[2];
      else if (hz < 1000) gain *= eq[3];
      else if (hz < 2000) gain *= eq[4];
      else if (hz < 4000) gain *= eq[5];
      else if (hz < 6000) gain *= eq[6];
      else if (hz < 10000) gain *= eq[7];
      else if (hz < 16000) gain *= eq[8];
      else gain *= eq[9];

      // HP/LP filters
      if (hz < hpFreq) gain *= Math.pow(hz / (hpFreq + 1e-9), 2);
      if (hz > lpFreq) gain *= Math.pow(lpFreq / hz, 4);

      // Tilt
      if (tilt !== 0 && hz > 100) {
         const octavesFrom1k = Math.log2(hz / 1000);
         gain *= Math.pow(10, (tilt * octavesFrom1k) / 20);
      }

      maskedMag[k] *= gain;
    }

    // [WHISPER UPDATE] Voice tunnel — formant-focused peaking emphasis
    const voiceTunnel = params.voiceTunnel || 0;
    if (voiceTunnel > 0) {
      const tunnelQ1 = 2 + (voiceTunnel / 100) * 8;
      const tunnelG1 = voiceTunnel * 0.12;
      const tunnelQ2 = 3 + (voiceTunnel / 100) * 6;
      const tunnelG2 = voiceTunnel * 0.08;
      const loCut = 300 + (200 * voiceTunnel / 100);
      const hiCut = 3400 - (600 * voiceTunnel / 100);
      for (let k = 0; k < HALF_BINS; k++) {
        const hz = k * binHz;
        let g = 1;
        const d1 = Math.abs(hz - 1200) / (1200 / tunnelQ1);
        const d2 = Math.abs(hz - 2800) / (2800 / tunnelQ2);
        if (d1 < 1) g *= Math.pow(10, (tunnelG1 * (1 - d1)) / 20);
        if (d2 < 1) g *= Math.pow(10, (tunnelG2 * (1 - d2)) / 20);
        if (hz < loCut || hz > hiCut) g *= 0.85;
        maskedMag[k] *= g;
      }
    }

    // [WHISPER UPDATE] WhisperHunterAI listen→process on complex spectrum (Part 4)
    const whRe = new Float32Array(HALF_BINS);
    const whIm = new Float32Array(HALF_BINS);
    for (let k = 0; k < HALF_BINS; k++) {
      whRe[k] = maskedMag[k] * Math.cos(pha[k]);
      whIm[k] = maskedMag[k] * Math.sin(pha[k]);
    }
    this._whisperHunter.processFrame(whRe, whIm, {
      clarity: _mapWhisperUi(params.whisperClarity ?? 65),
      sensitivity: _mapWhisperUi(params.whisperSensitivity ?? 55),
      threshold: _mapWhisperUi(params.whisperThreshold ?? 50),
      harmonic: Math.pow(Math.max(0, Math.min(100, params.harmRecov ?? 0)) / 100, 2),
    });
    for (let k = 0; k < HALF_BINS; k++) {
      maskedMag[k] = Math.sqrt(whRe[k] * whRe[k] + whIm[k] * whIm[k]);
    }

    // FIX [3] + FIX [6]: Reconstruct complex spectrum using polar form.
    // DC (k=0) and Nyquist (k=HALF_BINS-1) are real-only in a real-valued FFT.
    // All other positive bins get conjugate-symmetric mirror.

    // DC bin — purely real, no imaginary component
    this._re[0] = maskedMag[0] * Math.cos(pha[0]);
    this._im[0] = 0.0;

    // Positive bins 1 .. HALF_BINS-2 with conjugate mirror
    for (let k = 1; k < HALF_BINS - 1; k++) {
      const r = maskedMag[k];
      const p = pha[k];
      const re =  r * Math.cos(p);
      const im =  r * Math.sin(p);
      this._re[k]           =  re;
      this._im[k]           =  im;
      this._re[FFT_SIZE - k] =  re;  // conjugate: same real
      this._im[FFT_SIZE - k] = -im;  // conjugate: negated imaginary
    }

    // Nyquist bin — purely real (FFT_SIZE/2), no imaginary component
    const nyq = HALF_BINS - 1;
    this._re[nyq] = maskedMag[nyq] * Math.cos(pha[nyq]);
    this._im[nyq] = 0.0;

    // SINGLE-PASS STFT BOUNDARY
    // Inverse transform exit for the canonical live AudioWorklet path.
    fftInPlace(this._re, this._im, true);

    // Synthesis Hann window + overlap-add normalised by OLA_NORM (= 0.5 at 75%)
    const outLen = this._outRing.length;
    for (let i = 0; i < FFT_SIZE; i++) {
      const sample = this._re[i] * this._win[i] * OLA_NORM;
      const idx    = (this._outWr + i) % outLen;
      this._outRing[idx] += sample;
    }

    // FIX [1]: advance write pointer by HOP_SIZE, NOT FFT_SIZE
    // This ensures successive frames overlap correctly (75% overlap = 3/4 of FFT_SIZE)
    this._outWr = (this._outWr + HOP_SIZE) % outLen;
  }
}

registerProcessor('dsp-processor', DSPProcessor);
