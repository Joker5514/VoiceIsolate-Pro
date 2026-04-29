// ─────────────────────────────────────────────────────────────────────────────
//  voice-isolate-processor.js  —  VoiceIsolate Pro
//  AudioWorkletProcessor — dedicated voice isolation path.
//
//  Architecture contract (identical to dsp-processor.js):
//   • Exactly ONE forward STFT at the start of the spectral phase
//   • All spectral operations are in-place on the complex spectrum
//   • Exactly ONE inverse STFT reconstructing the time-domain signal
//   • ML masks are exchanged via SharedArrayBuffer (non-blocking)
//
//  SAB layout (header-first — differs from dsp-processor.js):
//   inputSAB:  [Int32 header × 4] [Float32 mag × NUM_BINS]
//     header[0] = magic  (0x56495043 = "VIPC")
//     header[1] = reserved
//     header[2] = frame counter (Atomics.add by worklet each hop)
//     header[3] = reserved
//   outputSAB: [Int32 header × 4] [Float32 mask × NUM_BINS]
//     header[0] = magic  (0x564F5554 = "VOUT")
//     header[1] = reserved
//     header[2] = mask-ready flag (set to 1 by ml-worker, cleared by worklet)
//     header[3] = reserved
//
//  This processor is registered at load time but not currently wired into the
//  main audio graph.  If instantiated, ml-worker.js poll loop must be updated
//  to handle this header-first protocol (see ml-worker.js line ~698).
// ─────────────────────────────────────────────────────────────────────────────

const FFT_SIZE  = 4096;
const HOP_SIZE  = 1024;
const HALF      = FFT_SIZE >>> 1;
const NUM_BINS  = HALF + 1;
const EPSILON   = 1e-9;
const HEADER_INTS = 4;                        // Int32 words before float payload
const HEADER_BYTES = HEADER_INTS * 4;         // 16 bytes
const MAGIC_IN  = 0x56495043;                 // "VIPC"
const MAGIC_OUT = 0x564F5554;                 // "VOUT"

// ── Cooley-Tukey in-place iterative FFT ──────────────────────────────────────
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
    const ang = sign * 2 * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let curRe = 1, curIm = 0;
      const half = len >>> 1;
      for (let k = 0; k < half; k++) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const tRe = curRe * re[i + k + half] - curIm * im[i + k + half];
        const tIm = curRe * im[i + k + half] + curIm * re[i + k + half];
        re[i + k]        =  uRe + tRe;
        im[i + k]        =  uIm + tIm;
        re[i + k + half] =  uRe - tRe;
        im[i + k + half] =  uIm - tIm;
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

// ── Pre-computed Hann window (periodic form for COLA) ────────────────────────
const HANN = new Float32Array(FFT_SIZE);
for (let i = 0; i < FFT_SIZE; i++) {
  HANN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / FFT_SIZE));
}

// ── Soft-knee Wiener suppression (pure attenuation, never amplifies) ─────────
function wienerGain(noiseMag, signalMag, alpha, beta) {
  const np = noiseMag * noiseMag;
  const sp = signalMag * signalMag;
  const snr = sp / (alpha * np + 1e-10);
  return Math.max(beta, Math.min(1.0, snr / (snr + 1.0)));
}

// ── Voice-band perceptual weighting (300 Hz – 3.4 kHz telephone band + wings) ─
function voiceBandWeight(bin, sr) {
  const hz = bin * sr / FFT_SIZE;
  if (hz < 80)    return 0.15;
  if (hz < 200)   return 0.55;
  if (hz < 300)   return 0.80;
  if (hz <= 3400) return 1.00;
  if (hz <= 5000) return 0.85;
  if (hz <= 7000) return 0.65;
  if (hz <= 10000) return 0.45;
  return 0.20;
}

// ── IIR biquad helpers ────────────────────────────────────────────────────────
function makeBiquad() {
  return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, z1: 0, z2: 0 };
}
function setBiquadHP(bq, freq, q, sr) {
  const w0 = 2 * Math.PI * freq / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const cosW0 = Math.cos(w0);
  const a0 = 1 + alpha;
  bq.b0 =  (1 + cosW0) / (2 * a0);
  bq.b1 = -(1 + cosW0) / a0;
  bq.b2 =  (1 + cosW0) / (2 * a0);
  bq.a1 = (-2 * cosW0) / a0;
  bq.a2 = (1 - alpha)  / a0;
}
function processBiquad(bq, x) {
  const y = bq.b0 * x + bq.z1;
  bq.z1   = bq.b1 * x - bq.a1 * y + bq.z2;
  bq.z2   = bq.b2 * x - bq.a2 * y;
  return y;
}

// ── Envelope follower ─────────────────────────────────────────────────────────
function makeEnvFollower(attack, release) {
  return { env: 0, attack: attack || 0.05, release: release || 0.001 };
}
function tickEnv(ef, x) {
  const abs = Math.abs(x);
  ef.env = abs > ef.env
    ? ef.attack  * abs + (1 - ef.attack)  * ef.env
    : ef.release * abs + (1 - ef.release) * ef.env;
  return ef.env;
}

// ── Minimum-statistics noise floor (per-bin EMA of running minimum) ──────────
function updateNoiseFloor(floor, mag, alphaRise, alphaFall) {
  for (let k = 0; k < floor.length; k++) {
    const target = mag[k] < floor[k] ? mag[k] : floor[k] * alphaRise + mag[k] * (1 - alphaRise);
    floor[k] = alphaFall * floor[k] + (1 - alphaFall) * target;
    if (floor[k] < 1e-7) floor[k] = 1e-7;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
class VoiceIsolateProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    this._sr = sampleRate;

    // ── OLA working buffers ───────────────────────────────────────────────────
    this._inBuf    = new Float32Array(FFT_SIZE);
    this._outBuf   = new Float32Array(FFT_SIZE);
    this._outWSum  = new Float32Array(FFT_SIZE);
    this._writePos = 0;
    this._readPos  = 0;
    this._re       = new Float32Array(FFT_SIZE);
    this._im       = new Float32Array(FFT_SIZE);

    // ── Spectral state ────────────────────────────────────────────────────────
    this._mag       = new Float32Array(NUM_BINS);
    this._phase     = new Float32Array(NUM_BINS);
    this._noiseFloor = new Float32Array(NUM_BINS).fill(1e-4);
    this._mlMask    = new Float32Array(NUM_BINS).fill(1);
    this._smoothGain = 1.0;
    this._frameCount = 0;
    this._spectralReportInterval = 4;

    // ── SAB (header-first layout) ─────────────────────────────────────────────
    const po = options && options.processorOptions;
    if (po && po.inputSAB && po.outputSAB) {
      this._inSAB    = po.inputSAB;
      this._outSAB   = po.outputSAB;
      this._hdrIn    = new Int32Array(this._inSAB, 0, HEADER_INTS);
      this._hdrOut   = new Int32Array(this._outSAB, 0, HEADER_INTS);
      this._floatIn  = new Float32Array(this._inSAB,  HEADER_BYTES, NUM_BINS);
      this._floatOut = new Float32Array(this._outSAB, HEADER_BYTES, NUM_BINS);
      Atomics.store(this._hdrIn,  0, MAGIC_IN);
      Atomics.store(this._hdrOut, 0, MAGIC_OUT);
      this._hasSAB = true;
    } else {
      this._hasSAB = false;
    }

    // ── Noise gate state ──────────────────────────────────────────────────────
    this._gateOpen  = [false, false];
    this._gateHold  = [0, 0];
    this._gateEnv   = [makeEnvFollower(0.02, 0.001), makeEnvFollower(0.02, 0.001)];

    // ── HP filter (80 Hz, removes DC / rumble before STFT) ───────────────────
    this._hp = [makeBiquad(), makeBiquad()];

    // ── DSP params mirroring the 52-slider system ─────────────────────────────
    this._p = {
      gateThresh:    -55,
      gateRange:     -40,
      gateAttack:      3,
      gateRelease:   100,
      gateHold:       20,
      nrAmount:       80,
      nrSensitivity:  70,
      nrFloor:       -55,
      nrSmoothing:    50,
      noiseOverSubtract: 1.5,
      spectralFloor:  0.01,
      voiceIso:       90,
      bgSuppress:     85,
      voiceFocusLo:  300,
      voiceFocusHi: 3400,
      harmRecov:      15,
      harmOrder:       3,
      outGain:         0,
      dryWet:        100,
      bypass:        false,
    };

    this._rebuildFilters();

    this.port.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.type === 'params') {
        Object.assign(this._p, d.params);
        if (d.params.gateAttack !== undefined || d.params.gateRelease !== undefined ||
            d.params.sampleRate !== undefined) {
          if (d.params.sampleRate) this._sr = d.params.sampleRate;
          this._rebuildFilters();
        }
      } else if (d.type === 'init') {
        if (d.sampleRate) this._sr = d.sampleRate;
        this._rebuildFilters();
      } else if (d.type === 'disconnect') {
        this._resetSAB();
      }
    };
    this.port.addEventListener('close', () => this._resetSAB());
  }

  _rebuildFilters() {
    const sr = this._sr;
    for (let ch = 0; ch < 2; ch++) setBiquadHP(this._hp[ch], 80, 0.707, sr);
    const att = Math.exp(-1 / (sr * Math.max(0.1, this._p.gateAttack)  / 1000));
    const rel = Math.exp(-1 / (sr * Math.max(0.1, this._p.gateRelease) / 1000));
    for (let ch = 0; ch < 2; ch++) {
      this._gateEnv[ch].attack  = 1 - att;
      this._gateEnv[ch].release = 1 - rel;
    }
  }

  _resetSAB() {
    if (!this._hasSAB) return;
    Atomics.store(this._hdrIn,  2, 0);
    Atomics.store(this._hdrOut, 2, 0);
  }

  process(inputs, outputs, _parameters) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!output || !output.length) return true;

    // Drain OLA leftovers when source disconnects
    if (!input || !input.length) {
      const bsz = (output[0] && output[0].length) || 0;
      for (let n = 0; n < bsz; n++) {
        const rp = (this._readPos + n) & (FFT_SIZE - 1);
        const ws = this._outWSum[rp];
        const v  = ws > 1e-8 ? this._outBuf[rp] / ws : 0;
        this._outBuf[rp]  = 0;
        this._outWSum[rp] = 0;
        for (let ch = 0; ch < output.length; ch++) output[ch][n] = v;
      }
      this._readPos = (this._readPos + bsz) & (FFT_SIZE - 1);
      return true;
    }

    const nCh  = Math.min(input.length, output.length);
    const bsz  = input[0].length;
    const outG = Math.pow(10, this._p.outGain / 20);
    const dw   = Math.max(0, Math.min(1, this._p.dryWet / 100));
    const gtL  = Math.pow(10, this._p.gateThresh / 20);
    const grG  = Math.pow(10, this._p.gateRange  / 20);
    const holdS = Math.round((this._p.gateHold / 1000) * this._sr);

    this._smoothGain += 0.25 * (outG - this._smoothGain);
    const gainLin = this._smoothGain;

    for (let ch = 0; ch < nCh; ch++) {
      const inD  = input[ch];
      const outD = output[ch];
      const hp   = this._hp[ch] || this._hp[0];
      const genv = this._gateEnv[ch] || this._gateEnv[0];
      const baseRp = this._readPos;

      for (let n = 0; n < bsz; n++) {
        const dry = inD[n];
        if (this._p.bypass) { outD[n] = dry; continue; }

        // HP filter (removes sub-80 Hz rumble)
        let x = processBiquad(hp, dry);

        // Noise gate
        const env = tickEnv(genv, x);
        if (env > gtL) {
          this._gateOpen[ch] = true;
          this._gateHold[ch] = holdS;
        } else if (this._gateHold[ch] > 0) {
          this._gateHold[ch]--;
        } else {
          this._gateOpen[ch] = false;
        }
        x = this._gateOpen[ch] ? x : x * grG;

        this._inBuf[this._writePos] = x;
        this._writePos = (this._writePos + 1) & (FFT_SIZE - 1);

        if (this._writePos % HOP_SIZE === 0) {
          this._spectralHop(this._writePos);
        }

        const rp  = (baseRp + n) & (FFT_SIZE - 1);
        const ws  = this._outWSum[rp];
        const wet = (ws > 1e-8 ? this._outBuf[rp] / ws : 0) * gainLin;
        this._outBuf[rp]  = 0;
        this._outWSum[rp] = 0;
        outD[n] = dry * (1 - dw) + wet * dw;
      }
    }
    this._readPos = (this._readPos + bsz) & (FFT_SIZE - 1);
    return true;
  }

  // ── ONE forward STFT → in-place spectral ops → ONE inverse STFT ─────────────
  _spectralHop(snapWP) {
    const re = this._re;
    const im = this._im;
    const sr = this._sr;

    // Window and fill re[]
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = this._inBuf[(snapWP + i) & (FFT_SIZE - 1)] * HANN[i];
      im[i] = 0;
    }

    // ① SINGLE FORWARD STFT
    fft(re, im, false);

    const mag   = this._mag;
    const phase = this._phase;
    for (let k = 0; k < NUM_BINS; k++) {
      mag[k]   = Math.sqrt(re[k] * re[k] + im[k] * im[k]) || 0;
      phase[k] = Math.atan2(im[k], re[k]);
    }

    // ── In-place op 1: Noise floor tracking ──────────────────────────────────
    updateNoiseFloor(this._noiseFloor, mag, 0.96, 0.999);

    // ── In-place op 2: Spectral subtraction + Wiener ──────────────────────────
    const beta   = 1 + (this._p.nrAmount / 100) * 3.0;
    const sens   = 1 + (this._p.nrSensitivity / 200);
    const floor  = Math.pow(10, this._p.nrFloor / 20);
    const smCoef = Math.max(0, Math.min(0.98, this._p.nrSmoothing / 100 * 0.98));
    const alpha  = Math.max(1e-6, this._p.noiseOverSubtract);
    const wBeta  = Math.max(0, Math.min(1, this._p.spectralFloor));

    for (let k = 0; k < NUM_BINS; k++) {
      const noise = beta * this._noiseFloor[k] * sens;
      const absFloor = Math.max(floor * mag[k], 1e-7);
      const suppressed = Math.max(mag[k] - noise, absFloor);
      const smoothed = smCoef * mag[k] + (1 - smCoef) * suppressed;
      const wg = wienerGain(this._noiseFloor[k], smoothed, alpha, wBeta);
      mag[k] = smoothed * wg;
    }

    // ── In-place op 3: Voice-band masking (isolation + background suppress) ───
    const binPerHz  = NUM_BINS / (sr / 2);
    const loB       = Math.round(this._p.voiceFocusLo * binPerHz);
    const hiB       = Math.round(this._p.voiceFocusHi * binPerHz);
    const isoBoost  = 1 + (this._p.voiceIso    / 100) * 0.6;
    const bgSupG    = 1 - (this._p.bgSuppress  / 100) * 0.96;
    for (let k = 0; k < NUM_BINS; k++) {
      const vw = voiceBandWeight(k, sr);
      const inBand = (k >= loB && k <= hiB);
      mag[k] *= inBand ? isoBoost * vw : bgSupG * (1 - vw * 0.5);
    }

    // ── In-place op 4: ML mask from SAB (non-blocking, header-first protocol) ─
    if (this._hasSAB) {
      if (Atomics.load(this._hdrOut, 2) === 1) {
        for (let k = 0; k < NUM_BINS; k++) {
          const v = this._floatOut[k];
          this._mlMask[k] = (Number.isFinite(v) && v >= 0) ? Math.min(v, 1) : 1;
        }
        Atomics.store(this._hdrOut, 2, 0);
      }
      this._floatIn.set(mag);
      Atomics.add(this._hdrIn, 2, 1);
    }
    for (let k = 0; k < NUM_BINS; k++) mag[k] *= this._mlMask[k];

    // ── In-place op 5: Harmonic enhancement ──────────────────────────────────
    if (this._p.harmRecov > 0) {
      const h = (this._p.harmRecov / 100) * 0.10;
      const ord = Math.max(2, Math.min(8, Math.round(this._p.harmOrder)));
      const guard = Math.floor(NUM_BINS * 0.85);
      for (let k = 0; k < guard; k++) {
        const normed = Math.min(mag[k], 1.0);
        let enhanced = mag[k];
        for (let o = 2; o <= ord; o++) {
          const term = (h / (o - 1)) * Math.pow(normed, o);
          if (!isFinite(term)) { enhanced = mag[k]; break; }
          enhanced += term;
        }
        mag[k] = isFinite(enhanced) ? Math.min(enhanced, mag[k] * 2.0) : mag[k];
      }
    }

    // Safety: clamp out NaN/Inf/negatives
    for (let k = 0; k < NUM_BINS; k++) {
      if (!isFinite(mag[k]) || mag[k] < 0) mag[k] = 0;
    }

    // Reconstruct complex spectrum
    for (let k = 0; k < NUM_BINS; k++) {
      re[k] = mag[k] * Math.cos(phase[k]);
      im[k] = mag[k] * Math.sin(phase[k]);
    }
    // Hermitian symmetry for real-valued iFFT
    for (let k = 1; k < HALF; k++) {
      re[FFT_SIZE - k] =  re[k];
      im[FFT_SIZE - k] = -im[k];
    }

    // ② SINGLE INVERSE STFT
    fft(re, im, true);

    // Overlap-add
    for (let i = 0; i < FFT_SIZE; i++) {
      const widx = (snapWP + i) & (FFT_SIZE - 1);
      this._outBuf[widx]  += re[i] * HANN[i];
      this._outWSum[widx] += HANN[i] * HANN[i];
    }

    this._frameCount++;

    if (this._frameCount % this._spectralReportInterval === 0) {
      let rms = 0;
      for (let k = 0; k < NUM_BINS; k++) rms += mag[k] * mag[k];
      rms = Math.sqrt(rms / NUM_BINS);
      this.port.postMessage({ type: 'SPECTRAL_FRAME', frame: this._frameCount, rms });
    }
  }
}

registerProcessor('voice-isolate-processor', VoiceIsolateProcessor);
