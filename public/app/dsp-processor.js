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
//   • Classical DSP (gate, notch, de-ess, spectral subtract, Wiener) runs inline.
// ─────────────────────────────────────────────────────────────────────────────

const FFT_SIZE = 4096;   // STFT window (samples) — ~85ms @ 48 kHz
const HOP_SIZE = 1024;   // 75% overlap
const HALF     = FFT_SIZE >>> 1;
const NUM_BINS = HALF + 1;

// ── Cooley-Tukey in-place iterative FFT ─────────────────────────────────────
function fft(re, im, inverse = false) {
  const N = re.length;
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

// ── Pre-computed Hann window (periodic form for COLA) ───────────────────────
const HANN = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / FFT_SIZE));
}

// ── IIR biquad helpers (used for hum notch + de-ess) ────────────────────────
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
function setBiquadPeak(bq, freq, q, gainDb, sr) {
  const w0    = 2 * Math.PI * freq / sr;
  const A     = Math.pow(10, gainDb / 40);
  const alpha = Math.sin(w0) / (2 * q);
  const cosW0 = Math.cos(w0);
  const a0    = 1 + alpha / A;
  bq.b0 = (1 + alpha * A) / a0;
  bq.b1 = (-2 * cosW0)    / a0;
  bq.b2 = (1 - alpha * A) / a0;
  bq.a1 = (-2 * cosW0)    / a0;
  bq.a2 = (1 - alpha / A) / a0;
}
function processBiquad(bq, x) {
  const y = bq.b0 * x + bq.z1;
  bq.z1   = bq.b1 * x - bq.a1 * y + bq.z2;
  bq.z2   = bq.b2 * x - bq.a2 * y;
  return y;
}

// ── Simple peak-envelope follower for de-essing ──────────────────────────────
function makeEnvFollower() {
  return { env: 0, attack: 0.0005, release: 0.05 };
}
function processEnvFollower(ef, x) {
  const abs = Math.abs(x);
  ef.env = abs > ef.env
    ? ef.attack  * abs + (1 - ef.attack)  * ef.env
    : ef.release * abs + (1 - ef.release) * ef.env;
  return ef.env;
}

// ────────────────────────────────────────────────────────────────────────────
class DSPProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this._sampleRate = sampleRate; // AudioWorklet global

    // ── Working buffers ──────────────────────────────────────────────────────
    this._inBuf        = new Float32Array(FFT_SIZE);
    this._outBuf       = new Float32Array(FFT_SIZE);
    this._outWindowSum = new Float32Array(FFT_SIZE);
    this._writePos     = 0;
    this._reBuffer     = new Float32Array(FFT_SIZE);
    this._imBuffer     = new Float32Array(FFT_SIZE);
    this._prevMag      = new Float32Array(NUM_BINS);   // slow noise floor EMA
    this._fastMag      = new Float32Array(NUM_BINS);   // fast spectral reference EMA
    this._magBuffer    = new Float32Array(NUM_BINS);
    this._phaseBuffer  = new Float32Array(NUM_BINS);
    this._mlMask       = new Float32Array(NUM_BINS).fill(1);

    // ── SharedArrayBuffer rings ──────────────────────────────────────────────
    // inputSAB  layout: [Float32 mag × NUM_BINS] [Int32 flags × 4]
    //   flagsIn[0]  = frame counter (written by worklet)
    //   flagsIn[1]  = (reserved)
    // outputSAB layout: [Float32 mask × NUM_BINS] [Int32 flags × 4]
    //   flagsOut[1] = mask-ready flag (written by ml-worker)
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

    // ── Noise gate state ─────────────────────────────────────────────────────
    this._gateOpen     = [false, false];
    this._gateHoldSamp = [0, 0];   // remaining hold samples
    this._gateLookBuf  = [null, null];
    this._gateLookPos  = [0, 0];

    // ── Per-channel IIR filters ──────────────────────────────────────────────
    // Hum notch filters (60/120/180 Hz, two channels)
    this._notch60  = [makeBiquad(), makeBiquad()];
    this._notch120 = [makeBiquad(), makeBiquad()];
    this._notch180 = [makeBiquad(), makeBiquad()];
    // De-essing sidechain filter (peaking) + envelope followers
    this._deEssBand = [makeBiquad(), makeBiquad()];
    this._deEssEnv  = [makeEnvFollower(), makeEnvFollower()];
    // Wideband envelope follower for gate sidechain
    this._gateEnv   = [makeEnvFollower(), makeEnvFollower()];
    this._rebuildFilters(this._sampleRate);

    // ── DSP parameter state (updated via port.onmessage) ────────────────────
    // Mirrors the 52-slider SLIDER_MAP keys that are relevant to live mode
    this._params = {
      // Gate
      gateThresh:      -42,    // dB
      gateRange:       -40,    // dB  (attenuation when gate closed)
      gateAttack:        2,    // ms
      gateRelease:      80,    // ms
      gateHold:         20,    // ms
      gateLookahead:     5,    // ms (lookahead ring buffer)
      // NR
      nrAmount:         55,    // %
      nrSensitivity:    50,    // %
      nrSpectralSub:    40,    // %
      nrFloor:         -60,    // dB
      nrSmoothing:      35,    // %
      // De-ess
      deEssFreq:      7000,    // Hz
      deEssAmt:         30,    // %
      // Spectral tilt
      specTilt:          0,    // dB/oct
      // Voice focus
      voiceFocusLo:    120,    // Hz
      voiceFocusHi:   6000,    // Hz
      voiceIso:         70,    // %
      bgSuppress:       50,    // %
      // Harmonic enhance
      harmRecov:        20,    // %
      harmOrder:         3,    // x
      // Output
      outGain:           0,    // dB
      dryWet:          100,    // %
      // Misc
      humReduce:        50,    // %
      bypass:        false,
    };

    this._frameCount = 0;
    // How often to send SPECTRAL_FRAME to main thread (every N hops)
    this._spectralFrameInterval = 4;
    this._spectralFrameMag = new Float32Array(NUM_BINS);

    // Receive slider updates from main thread
    this.port.onmessage = (ev) => {
      const d = ev.data;
      if (d?.type === 'params') {
        Object.assign(this._params, d.params);
        // Rebuild filters if sample rate or de-ess freq changed
        if (d.params.sampleRate || d.params.deEssFreq || d.params.deEssAmt) {
          this._rebuildFilters(d.params.sampleRate || this._sampleRate);
        }
        // Rebuild gate lookahead buffer if lookahead changed
        if (d.params.gateLookahead !== undefined) {
          this._initLookahead();
        }
      } else if (d?.type === 'init') {
        // Main thread sends sampleRate explicitly on worklet init
        this._sampleRate = d.sampleRate || sampleRate;
        this._rebuildFilters(this._sampleRate);
        this._initLookahead();
      }
    };

    this._initLookahead();
  }

  // Allocate lookahead ring buffer based on gateLookahead param
  _initLookahead() {
    const lookSamp = Math.max(1, Math.round(
      (this._params.gateLookahead / 1000) * this._sampleRate
    ));
    for (let ch = 0; ch < 2; ch++) {
      this._gateLookBuf[ch] = new Float32Array(lookSamp);
      this._gateLookPos[ch] = 0;
    }
  }

  _rebuildFilters(sr) {
    // Hum notch
    for (let ch = 0; ch < 2; ch++) {
      setBiquadNotch(this._notch60[ch],   60, 30, sr);
      setBiquadNotch(this._notch120[ch], 120, 30, sr);
      setBiquadNotch(this._notch180[ch], 180, 30, sr);
    }
    // De-ess sidechain: narrow peak at deEssFreq with gain = -deEssAmt*0.15 dB
    const deEssGainDb = -(this._params.deEssAmt / 100) * 15;
    for (let ch = 0; ch < 2; ch++) {
      setBiquadPeak(this._deEssBand[ch], this._params.deEssFreq, 3, deEssGainDb, sr);
    }
    // Tune gate envelope followers to attack/release params
    const attackCoef  = Math.exp(-1 / (this._sampleRate * this._params.gateAttack  / 1000));
    const releaseCoef = Math.exp(-1 / (this._sampleRate * this._params.gateRelease / 1000));
    for (let ch = 0; ch < 2; ch++) {
      this._gateEnv[ch].attack  = 1 - attackCoef;
      this._gateEnv[ch].release = 1 - releaseCoef;
    }
  }

  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input?.length || !output?.length) return true;

    const numChannels = Math.min(input.length, output.length);
    const blockSize   = input[0].length;
    const sr          = this._sampleRate;

    // Pre-compute param-derived constants (avoids per-sample division)
    const gateThreshLin = Math.pow(10, this._params.gateThresh / 20);
    const gateRangeGain = Math.pow(10, this._params.gateRange  / 20);  // < 1.0
    const holdSamples   = Math.round((this._params.gateHold / 1000) * sr);
    const outGainLin    = Math.pow(10, this._params.outGain / 20);
    const dryWetFrac    = Math.max(0, Math.min(1, this._params.dryWet / 100));
    const humReduce     = Math.max(0, Math.min(1, this._params.humReduce / 100));

    for (let ch = 0; ch < numChannels; ch++) {
      const gateCh = ch < 2 ? ch : 0;
      const inData  = input[ch];
      const outData = output[ch];
      const notch60  = this._notch60[ch]  || this._notch60[0];
      const notch120 = this._notch120[ch] || this._notch120[0];
      const notch180 = this._notch180[ch] || this._notch180[0];
      const deEssBq  = this._deEssBand[ch] || this._deEssBand[0];
      const deEssEf  = this._deEssEnv[ch]  || this._deEssEnv[0];
      const gateEf   = this._gateEnv[ch]   || this._gateEnv[0];

      for (let n = 0; n < blockSize; n++) {
        let x = inData[n];
        const dry = x;

        if (this._params.bypass) {
          outData[n] = x;
          continue;
        }

        // ── Pre-spectral Stage A: Hum removal (IIR notch cascade) ────────────
        if (humReduce > 0) {
          const humOut = processBiquad(notch180,
            processBiquad(notch120,
              processBiquad(notch60, x)));
          x = dry * (1 - humReduce) + humOut * humReduce;
        }

        // ── Pre-spectral Stage B: Lookahead noise gate ───────────────────────
        // Write to lookahead ring; read back the delayed sample
        const gateLookBuf = this._gateLookBuf[gateCh] || this._gateLookBuf[0];
        let gateLookPos = this._gateLookPos[gateCh];
        if (gateLookPos === undefined) gateLookPos = this._gateLookPos[0];
        const lookLen = gateLookBuf.length;
        const delayed = gateLookBuf[gateLookPos];
        gateLookBuf[gateLookPos] = x;
        gateLookPos = (gateLookPos + 1) % lookLen;
        this._gateLookPos[gateCh] = gateLookPos;

        // Sidechain: track signal level
        const envVal = processEnvFollower(gateEf, x);
        if (envVal > gateThreshLin) {
          this._gateOpen[gateCh]     = true;
          this._gateHoldSamp[gateCh] = holdSamples;
        } else if (this._gateHoldSamp[gateCh] > 0) {
          this._gateHoldSamp[gateCh]--;
        } else {
          this._gateOpen[gateCh] = false;
        }
        x = this._gateOpen[gateCh] ? delayed : delayed * gateRangeGain;

        // ── Pre-spectral Stage C: Time-domain de-essing ──────────────────────
        if (this._params.deEssAmt > 0) {
          const sibBand = processBiquad(deEssBq, x);
          const sibEnv = processEnvFollower(deEssEf, sibBand);
          const ratio = Math.min(1, sibEnv / (Math.abs(x) + 1e-9));
          const reduction = Math.max(0, Math.min(0.85, ((ratio - 0.35) / 0.65) * (this._params.deEssAmt / 100) * 0.85));
          x -= sibBand * reduction;
        }

        // ── Feed OLA input ring ───────────────────────────────────────────────
        this._inBuf[this._writePos] = x;
        this._writePos = (this._writePos + 1) & (FFT_SIZE - 1);

        // Trigger spectral pass every HOP_SIZE samples
        if (this._writePos % HOP_SIZE === 0) {
          this._processSpectralHop();
        }

        // Read OLA output (normalized by window sum, then clear slots)
        const readPos = (this._writePos - blockSize + n + FFT_SIZE) & (FFT_SIZE - 1);
        const wsum    = this._outWindowSum[readPos];
        const normalized = wsum > 1e-8 ? this._outBuf[readPos] / wsum : 0;
        this._outBuf[readPos]       = 0;
        this._outWindowSum[readPos] = 0;

        // Dry/wet + output gain
        const wetSig = normalized * outGainLin;
        outData[n]   = dry * (1 - dryWetFrac) + wetSig * dryWetFrac;
      }
    }
    return true;
  }

  // ── Single spectral pass: ONE forward STFT → in-place ops → ONE iSTFT ──────
  _processSpectralHop() {
    const re = this._reBuffer;
    const im = this._imBuffer;
    const sr = this._sampleRate;

    // ── Copy windowed frame into re[], zero im[] ─────────────────────────────
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = (this._writePos - FFT_SIZE + i + FFT_SIZE) & (FFT_SIZE - 1);
      re[i] = this._inBuf[idx] * HANN[i];
      im[i] = 0;
    }

    // ① SINGLE FORWARD STFT ──────────────────────────────────────────────────
    fft(re, im, false);

    // Extract magnitude and phase (positive bins only)
    const mag   = this._magBuffer;
    const phase = this._phaseBuffer;
    for (let k = 0; k < NUM_BINS; k++) {
      mag[k]   = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }

    // ── In-place op 1: Dual-EMA noise floor tracking ─────────────────────────
    // Slow EMA (~10s TC) = true noise floor; only advances when bin is below
    // the fast reference (speech formants do not contaminate the floor).
    // Fast EMA (~3 hops) = spectral reference to detect transient speech peaks.
    const alphaSlow = 0.002;
    const alphaFast = 0.15;
    for (let k = 0; k < NUM_BINS; k++) {
      this._fastMag[k] = alphaFast * mag[k] + (1 - alphaFast) * this._fastMag[k];
      if (mag[k] < this._fastMag[k] * 1.5) {
        this._prevMag[k] = alphaSlow * mag[k] + (1 - alphaSlow) * this._prevMag[k];
      }
    }

    // ── In-place op 2: Spectral subtraction ─────────────────────────────────
    const beta      = 1 + (this._params.nrAmount / 100) * (1 + this._params.nrSpectralSub / 100) * 3;
    const floorLin  = Math.pow(10, this._params.nrFloor / 20);
    const smCoef    = Math.max(0, Math.min(0.98, this._params.nrSmoothing / 100 * 0.98));
    for (let k = 0; k < NUM_BINS; k++) {
      const noise = beta * this._prevMag[k] * (1 + this._params.nrSensitivity / 200);
      // Smoothed over-subtraction (anti-musical-noise)
      const suppressed = Math.max(mag[k] - noise, floorLin * mag[k]);
      mag[k] = smCoef * mag[k] + (1 - smCoef) * suppressed;
    }

    // ── In-place op 3: Wiener gain ───────────────────────────────────────────
    const w = this._params.nrAmount / 100 * 0.9;
    if (w > 0) {
      for (let k = 0; k < NUM_BINS; k++) {
        const snr  = mag[k] / (this._prevMag[k] + 1e-9);
        const gain = snr / (snr + 1);
        mag[k] = mag[k] * (1 - w) + mag[k] * gain * w;
      }
    }

    // ── In-place op 4: Voice-band focus + background suppression ─────────────
    if (this._params.voiceIso > 0 || this._params.bgSuppress > 0) {
      const binPerHz   = NUM_BINS / (sr / 2);
      const loB        = Math.round(this._params.voiceFocusLo * binPerHz);
      const hiB        = Math.round(this._params.voiceFocusHi * binPerHz);
      const suppressG  = 1 - (this._params.bgSuppress / 100) * 0.95;
      const boostG     = 1 + (this._params.voiceIso    / 100) * 0.5;
      for (let k = 0; k < NUM_BINS; k++) {
        mag[k] *= (k >= loB && k <= hiB) ? boostG : suppressG;
      }
    }

    // ── In-place op 5: Spectral tilt compensation ────────────────────────────
    if (Math.abs(this._params.specTilt) > 0.1) {
      for (let k = 1; k < NUM_BINS; k++) {
        const freq = k * sr / FFT_SIZE;
        const oct  = Math.log2(freq / 1000);
        const tG   = Math.pow(10, (this._params.specTilt * oct) / 20);
        mag[k] *= Math.max(0.01, Math.min(10, tG));
      }
    }

    // ── In-place op 6: ML mask from SAB (async, non-blocking) ────────────────
    if (this._hasSAB) {
      if (Atomics.load(this._flagsOut, 1) === 1) {
        for (let k = 0; k < NUM_BINS; k++) this._mlMask[k] = this._outputView[k];
        Atomics.store(this._flagsOut, 1, 0);
      }
      this._inputView.set(mag);
      Atomics.add(this._flagsIn, 0, 1);
    }
    for (let k = 0; k < NUM_BINS; k++) mag[k] *= this._mlMask[k];

    // ── In-place op 7: Harmonic enhancement (below Nyquist guard) ────────────
    if (this._params.harmRecov > 0) {
      const h        = (this._params.harmRecov / 100) * 0.12;
      const ord      = Math.max(2, Math.min(8, Math.round(this._params.harmOrder)));
      const guardBin = Math.floor(NUM_BINS * 0.85);
      for (let k = 0; k < guardBin; k++) {
        // Polynomial harmonic boost, clamped to +6 dB (×2) per bin
        let enhanced = mag[k];
        for (let o = 2; o <= ord; o++) {
          enhanced += h / (o - 1) * Math.pow(mag[k], o);
        }
        mag[k] = Math.min(enhanced, mag[k] * 2.0);
      }
    }

    // ── Reconstruct complex spectrum (magnitude + original phase) ────────────
    for (let k = 0; k < NUM_BINS; k++) {
      re[k] = mag[k] * Math.cos(phase[k]);
      im[k] = mag[k] * Math.sin(phase[k]);
    }
    // Enforce Hermitian symmetry for real-valued iFFT output
    for (let k = 1; k < HALF; k++) {
      re[FFT_SIZE - k] =  re[k];
      im[FFT_SIZE - k] = -im[k];
    }

    // ② SINGLE INVERSE STFT ──────────────────────────────────────────────────
    fft(re, im, true);

    // ── Overlap-add into output ring (normalized by windowed sum at read time) ─
    for (let i = 0; i < FFT_SIZE; i++) {
      const widx = (this._writePos - FFT_SIZE + i + FFT_SIZE) & (FFT_SIZE - 1);
      this._outBuf[widx]       += re[i] * HANN[i];
      this._outWindowSum[widx] += HANN[i] * HANN[i];
    }

    this._frameCount++;

    // ── Post SPECTRAL_FRAME to main thread for VisualizationEngine VU meters ─
    // Send every _spectralFrameInterval hops to cap postMessage overhead.
    if (this._frameCount % this._spectralFrameInterval === 0) {
      this._spectralFrameMag.set(mag);
      this.port.postMessage({
        type:  'SPECTRAL_FRAME',
        frame: this._frameCount,
        mag:   this._spectralFrameMag,
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
