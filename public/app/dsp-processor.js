/* ============================================
   VoiceIsolate Pro — STFT AudioWorklet Processor
   Single-Pass Spectral: ONE FFT → in-place → ONE iFFT
   Threads from Space v8 · dsp-processor.js

   32-stage Octa-Pass pipeline (spectral stages 05–20)
   execute entirely within the single STFT pass.

   Ring-buffer accumulates 128-sample blocks → 4096pt
   frames with 75% overlap (hop = 1024).
   ============================================ */

// ── Radix-2 Cooley-Tukey FFT with pre-computed twiddle table ──────────────
// Pre-computed twiddles eliminate ~24K cos/sin calls per 4096pt frame.
// Table indexed by [stage][position] → (re, im) pairs stored interleaved.
const FFT_TWIDDLES = new Map();

function ensureTwiddles(n) {
  if (FFT_TWIDDLES.has(n)) return FFT_TWIDDLES.get(n);
  const stages = Math.log2(n);
  const table = new Float64Array(n * 2); // max needed: n complex twiddles
  // Pre-compute for forward transform; inverse just conjugates (flip im sign)
  let offset = 0;
  for (let s = 0; s < stages; s++) {
    const len = 1 << (s + 1);
    const half = len >> 1;
    const ang = -6.283185307179586 / len;
    for (let j = 0; j < half; j++) {
      const a = ang * j;
      table[offset++] = Math.cos(a);
      table[offset++] = Math.sin(a);
    }
  }
  FFT_TWIDDLES.set(n, table);
  return table;
}

function fftInPlace(re, im, inverse) {
  const n = re.length;
  const table = ensureTwiddles(n);
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
  const sign = inverse ? -1.0 : 1.0;
  let tOff = 0;
  const stages = Math.log2(n);
  for (let s = 0; s < stages; s++) {
    const len = 1 << (s + 1);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < half; j++) {
        const wRe = table[tOff + j * 2];
        const wIm = table[tOff + j * 2 + 1] * sign; // conjugate for inverse
        const k = i + j;
        const m = k + half;
        const tRe = re[m] * wRe - im[m] * wIm;
        const tIm = re[m] * wIm + im[m] * wRe;
        re[m] = re[k] - tRe;
        im[m] = im[k] - tIm;
        re[k] += tRe;
        im[k] += tIm;
      }
    }
    tOff += half * 2;
  }
}

// ── 32-band ERB centre frequencies (precomputed, 50 Hz – 20 kHz) ─────────
const ERB_CENTRES = [
  50, 73, 100, 132, 170, 214, 267, 329, 403, 490,
  593, 715, 860, 1032, 1237, 1480, 1770, 2115, 2525, 3014,
  3597, 4293, 5124, 6115, 7298, 8710, 10397, 12413, 14821, 17702,
  19500, 20500  // last 2 act as high-band sentinels
];

// ── Main AudioWorklet Processor ──────────────────────────────────────────
class DspProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);

    // ── FFT Configuration ──
    this.fftSize = 4096;
    this.numBins = this.fftSize / 2 + 1; // 2049
    this.overlap = 4;                      // 75%
    this.hopSize = this.fftSize / this.overlap; // 1024
    this.sr      = sampleRate;

    // ── Pre-allocate ALL buffers (ZERO allocations in process()) ──
    this.inputRing   = new Float32Array(this.fftSize);
    this.outputRing  = new Float32Array(this.fftSize);
    this.fftRe       = new Float32Array(this.fftSize);
    this.fftIm       = new Float32Array(this.fftSize);
    this.window      = new Float32Array(this.fftSize);
    this.magnitude   = new Float32Array(this.numBins);
    this.phase       = new Float32Array(this.numBins);
    this.noiseProfile = new Float32Array(this.numBins);
    this.noiseProfileAccum = new Float32Array(this.numBins);
    this.noiseSmoothGain = new Float32Array(this.numBins);
    this.prevMagEstimate = new Float32Array(this.numBins);

    // Ephraim-Malah Log-MMSE state buffers
    this.prevGain     = new Float32Array(this.numBins).fill(1.0); // gain smoothing
    this.snrPrior     = new Float32Array(this.numBins);            // a priori SNR (ξ)
    this.noiseVar     = new Float32Array(this.numBins);            // noise variance σ²_n
    // MCRA continuous noise estimation (Minima Controlled Recursive Averaging)
    this.noisePowerMin   = new Float32Array(this.numBins).fill(1e10); // running minimum
    this.noisePowerSmth  = new Float32Array(this.numBins);            // smoothed power
    this.speechPresProb  = new Float32Array(this.numBins);            // P(speech present)
    this.mcraBlockCount  = 0;
    this.mcraBlockSize   = 15; // frames per minima search window (~320ms)
    // De-clipping state
    this.clipCount       = 0;
    this.prevSample      = 0;

    // ERB band energy & gains
    this.erbGains    = new Float32Array(32);
    this.erbBandMap  = null; // will be computed in init

    // Hann window (periodic)
    for (let i = 0; i < this.fftSize; i++) {
      this.window[i] = 0.5 * (1.0 - Math.cos(6.283185307179586 * i / this.fftSize));
    }
    // COLA correction for Hann² at 75% overlap = 1.5 → multiply by 2/3
    this.olaGain = 2.0 / 3.0;

    // Ring buffer state
    this.writePos = 0;
    this.hopAccum = 0;

    // Noise profile state
    this.noiseProfiled     = false;
    this.noiseFrameCount   = 0;
    this.noiseFrameTarget  = 12; // ~250ms at 48kHz / 1024 hop
    this.silenceThreshold  = 0.005; // RMS threshold for "quiet" frame
    this.autoProfileTimer  = 0;

    // ── DSP Parameters (all 52 sliders default values) ──
    this.params = {
      // Gate
      gateThresh: -42, gateRange: -40, gateAttack: 2, gateRelease: 80,
      gateHold: 20, gateLookahead: 5,
      // Noise Reduction
      nrAmount: 55, nrSensitivity: 50, nrSpectralSub: 40,
      nrFloor: -60, nrSmoothing: 35,
      // EQ (10 bands)
      eqSub: -8, eqBass: 0, eqWarmth: 1, eqBody: 0, eqLowMid: -1,
      eqMid: 1, eqPresence: 3, eqClarity: 2, eqAir: 1, eqBrill: -2,
      // Dynamics
      compThresh: -24, compRatio: 4, compAttack: 8, compRelease: 200,
      compKnee: 6, compMakeup: 6, limThresh: -1, limRelease: 10,
      // Spectral
      hpFreq: 80, hpQ: 0.71, lpFreq: 14000, lpQ: 0.71,
      deEssFreq: 7000, deEssAmt: 30, specTilt: 0, formantShift: 0,
      // Advanced
      derevAmt: 40, derevDecay: 0.5, harmRecov: 20, harmOrder: 3,
      stereoWidth: 100, phaseCorr: 0,
      // Separation
      voiceIso: 70, bgSuppress: 50, voiceFocusLo: 120, voiceFocusHi: 6000,
      crosstalkCancel: 0,
      // Output
      outGain: 0, dryWet: 100, ditherAmt: 0, outWidth: 100,
    };

    // Time-domain states (gate, compressor)
    this._gateGain  = 1.0;
    this._compEnv   = 0.0;
    this._gateHoldCount = 0;

    // DC offset removal state (PDF §14.1: "must be removed first")
    this._dcState = 0.0;  // single-pole high-pass at ~5 Hz

    // Biquad states for post-STFT HP/LP (2nd-order)
    this._hpState = [0, 0, 0, 0]; // x1, x2, y1, y2
    this._lpState = [0, 0, 0, 0];

    // ── SharedArrayBuffer refs (optional, set via port) ──
    this._spectrumSAB = null; // for main thread 3D spectrogram viz
    this._controlSAB  = null;

    // Build ERB band map for current sample rate
    this._buildERBMap();

    // ── Message port: receive slider updates + SAB refs ──
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.sliders) {
        Object.assign(this.params, d.sliders);
      }
      if (d.type === 'sab-spectrum' && d.sab instanceof SharedArrayBuffer) {
        this._spectrumSAB = new Float32Array(d.sab);
      }
      if (d.type === 'sab-control' && d.sab instanceof SharedArrayBuffer) {
        this._controlSAB = new Int32Array(d.sab);
      }
      if (d.type === 'reset-noise') {
        this.noiseProfiled   = false;
        this.noiseFrameCount = 0;
        this.noiseProfile.fill(0);
      }
    };
  }

  // ── Build ERB filterbank: map FFT bins → 32 ERB bands ──────────────────
  _buildERBMap() {
    const sr   = this.sr;
    const N    = this.fftSize;
    const nBins = this.numBins;
    // bandStart[b] = first bin, bandEnd[b] = last bin (exclusive)
    const bandStart = new Int32Array(32);
    const bandEnd   = new Int32Array(32);

    for (let b = 0; b < 32; b++) {
      const lo = b === 0 ? 0 : ERB_CENTRES[b - 1];
      const hi = b < 31 ? ERB_CENTRES[b + 1] : sr / 2;
      const loMid = (ERB_CENTRES[b] + lo) / 2;
      const hiMid = (ERB_CENTRES[b] + hi) / 2;
      bandStart[b] = Math.max(0, Math.round(loMid * N / sr));
      bandEnd[b]   = Math.min(nBins, Math.round(hiMid * N / sr));
      if (bandEnd[b] <= bandStart[b]) bandEnd[b] = bandStart[b] + 1;
    }
    this.erbBandMap = { start: bandStart, end: bandEnd };
  }

  // ── PROCESS (called every 128 samples at audio rate) ───────────────────
  process(inputs, outputs) {
    const input  = inputs[0];
    const output = outputs[0];
    if (!input || !input.length || !input[0]) return true;

    const inCh  = input[0];   // mono / L channel
    const outCh = output[0];
    if (!outCh) return true;

    const N   = this.fftSize;
    const hop = this.hopSize;

    // Accumulate input into ring, read processed output
    for (let i = 0; i < 128; i++) {
      // Write input sample
      this.inputRing[this.writePos] = inCh[i];

      // Read previously processed output
      outCh[i] = this.outputRing[this.writePos];
      // Clear for next OLA frame
      this.outputRing[this.writePos] = 0.0;

      this.writePos = (this.writePos + 1) & (N - 1); // mod N (power of 2)

      // Every hop samples → run STFT frame
      if (++this.hopAccum >= hop) {
        this.hopAccum = 0;
        this._processSTFTFrame();
      }
    }

    // ── Post-STFT time-domain processing (gate, compressor, limiter) ──
    this._applyTimeDomain(outCh);

    // Copy to additional output channels (stereo pass-through)
    if (output.length > 1 && output[1]) {
      output[1].set(outCh);
    }

    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SINGLE-PASS STFT: ONE FFT → all spectral ops → ONE iFFT
  //  Order follows iZotope professional restoration cascade (PDF ref §14):
  //    1. Forward STFT
  //    2. Noise estimation (MCRA continuous)
  //    3. De-hum (tonal removal BEFORE broadband NR)
  //    4. De-clipping detection + repair
  //    5. Broadband NR (Ephraim-Malah Log-MMSE)
  //    6. ERB spectral gate (psychoacoustic)
  //    7. Voice band focus / separation prep
  //    8. Spectral EQ
  //    9. De-essing
  //   10. Spectral tilt
  //   11. Harmonic recovery (AFTER NR to regenerate destroyed harmonics)
  //   12. Inverse STFT
  // ══════════════════════════════════════════════════════════════════════════
  _processSTFTFrame() {
    const N     = this.fftSize;
    const nBins = this.numBins;
    const wp    = this.writePos;
    const re    = this.fftRe;
    const im    = this.fftIm;
    const win   = this.window;
    const mag   = this.magnitude;
    const ph    = this.phase;

    // ── Stage 05: Forward STFT (analysis window) ──────────────────────
    for (let i = 0; i < N; i++) {
      re[i] = this.inputRing[(wp + i) & (N - 1)] * win[i];
    }
    im.fill(0);
    fftInPlace(re, im, false);

    // ── Compute magnitude + phase ─────────────────────────────────────
    for (let k = 0; k < nBins; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      ph[k]  = Math.atan2(im[k], re[k]);
    }

    // ── Stage 03: MCRA noise estimation (continuous, non-VAD-dependent) ─
    this._updateNoiseProfile(mag);

    // ── Stage 15: Hum Elimination FIRST (before broadband NR per PDF §14.4)
    //    "Attempting to remove hum later using broadband NR forces
    //     the algorithm to over-subtract, destroying audio quality."
    this._humRemoval(mag);

    // ── Stage 16: De-clipping detection (spectral domain) ─────────────
    this._deClipRepair(mag, ph);

    // ── Stage 13: Ephraim-Malah Log-MMSE broadband NR ─────────────────
    if (this.noiseProfiled) {
      this._logMMSE(mag);
    }

    // ── Stage 14: ERB Spectral Gate (32-band psychoacoustic) ──────────
    if (this.noiseProfiled) {
      this._erbGate(mag);
    }

    // ── Stage 17: Voice Band Focus ────────────────────────────────────
    this._voiceBandFocus(mag);

    // ── Stage 18: Spectral EQ (10-band in frequency domain) ──────────
    this._spectralEQ(mag);

    // ── Stage 22: De-essing (frequency-selective attenuation) ─────────
    this._deEss(mag);

    // ── Stage 23: Spectral Tilt ───────────────────────────────────────
    this._spectralTilt(mag);

    // ── Stage 19: Harmonic Recovery AFTER NR (regenerate destroyed harmonics)
    this._harmonicRecovery(mag, ph);

    // ── Reconstruct complex spectrum from modified magnitude + phase ──
    for (let k = 0; k < nBins; k++) {
      re[k] = mag[k] * Math.cos(ph[k]);
      im[k] = mag[k] * Math.sin(ph[k]);
    }

    // ── Hermitian symmetry for real-valued iFFT ──────────────────────
    for (let k = 1; k < N / 2; k++) {
      re[N - k] =  re[k];
      im[N - k] = -im[k];
    }

    // ── Stage 20: Inverse STFT ────────────────────────────────────────
    fftInPlace(re, im, true);
    const invN = 1.0 / N;

    // ── Synthesis window + overlap-add ────────────────────────────────
    for (let i = 0; i < N; i++) {
      this.outputRing[(wp + i) & (N - 1)] +=
        re[i] * invN * win[i] * this.olaGain;
    }

    // ── Export spectrum to SharedArrayBuffer for visualization ────────
    if (this._spectrumSAB && this._spectrumSAB.length >= nBins) {
      for (let k = 0; k < nBins; k++) {
        this._spectrumSAB[k] = 20.0 * Math.log10(Math.max(mag[k], 1e-10));
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  SPECTRAL PROCESSING STAGES (all operate on magnitude array in-place)
  // ══════════════════════════════════════════════════════════════════════════

  // ── MCRA Noise Estimation (Minima Controlled Recursive Averaging) ──────
  //  Ref: PDF §8 — "MCRA for non-stationary environments"
  //  Continuously tracks noise floor without requiring explicit VAD.
  //  Uses smoothed power spectrum + running minimum to estimate noise.
  _updateNoiseProfile(mag) {
    const nBins = this.numBins;
    const alphaS = 0.92;   // power spectrum smoothing
    const alphaD = 0.85;   // noise update smoothing
    const delta  = 2.0;    // speech-presence threshold factor

    for (let k = 0; k < nBins; k++) {
      const power = mag[k] * mag[k];

      // Smooth power spectrum (recursive average)
      this.noisePowerSmth[k] = alphaS * this.noisePowerSmth[k] + (1 - alphaS) * power;

      // Update running minimum per block window
      if (this.noisePowerSmth[k] < this.noisePowerMin[k]) {
        this.noisePowerMin[k] = this.noisePowerSmth[k];
      }
    }

    this.mcraBlockCount++;
    if (this.mcraBlockCount >= this.mcraBlockSize) {
      this.mcraBlockCount = 0;
      // Reset minima for next window — carry forward current smoothed as baseline
      for (let k = 0; k < nBins; k++) {
        this.noisePowerMin[k] = this.noisePowerSmth[k];
      }
    }

    // Speech presence probability + conditional noise update
    for (let k = 0; k < nBins; k++) {
      // Soft sigmoid speech presence (replaces hard step function)
      const ratio = this.noisePowerSmth[k] / (this.noisePowerMin[k] + 1e-20);
      const pSpeech = 1.0 / (1.0 + Math.exp(-5.0 * (ratio - delta))); // smooth 0→1
      this.speechPresProb[k] = 0.7 * this.speechPresProb[k] + 0.3 * pSpeech;

      // Update noise estimate: faster when speech absent, frozen when present
      const pNoise = 1.0 - this.speechPresProb[k];
      const alphaAdapt = alphaD + (1 - alphaD) * this.speechPresProb[k];
      this.noiseVar[k] = alphaAdapt * this.noiseVar[k] + (1 - alphaAdapt) * pNoise * mag[k] * mag[k];

      // Legacy compat: maintain noiseProfile as sqrt(variance)
      this.noiseProfile[k] = Math.sqrt(Math.max(this.noiseVar[k], 1e-20));
    }

    // Initial profile convergence: need at least ~10 frames
    if (!this.noiseProfiled) {
      this.noiseFrameCount++;
      if (this.noiseFrameCount >= this.noiseFrameTarget) {
        this.noiseProfiled = true;
      }
    }
  }

  // ── Ephraim-Malah Log-MMSE Spectral Amplitude Estimator ────────────────
  //  Ref: PDF §8 — "Ephraim-Malah algorithm employs MMSE-STSA estimator"
  //  "decision-directed approach to estimate a priori SNR"
  //  "smooths gain function over time... aggressive noise suppression
  //   without introducing metallic musical noise artifacts"
  //
  //  The Log-MMSE gain function:
  //    G(k) = ξ(k) / (1 + ξ(k)) * exp(0.5 * E1(v(k)))
  //  where:
  //    ξ(k)  = a priori SNR (decision-directed)
  //    γ(k)  = a posteriori SNR = |Y(k)|² / σ²_n(k)
  //    v(k)  = ξ(k) * γ(k) / (1 + ξ(k))
  //    E1(v) = exponential integral ≈ approximated via rational function
  _logMMSE(mag) {
    const nBins    = this.numBins;
    const amount   = this.params.nrAmount / 100;           // 0–1 user control
    if (amount < 0.01) return; // bypass when NR disabled
    const subAlpha = this.params.nrSpectralSub / 100;      // spectral sub blend
    const floorDB  = this.params.nrFloor;                  // noise floor dB
    const smooth   = 0.92 + (this.params.nrSmoothing / 100) * 0.07; // α_dd: 0.92–0.99
    const specFloor = Math.pow(10, floorDB / 20);          // β spectral floor
    const prevGain  = this.prevGain;
    const snrPrior  = this.snrPrior;
    const prevMag   = this.prevMagEstimate;

    for (let k = 1; k < nBins; k++) {
      const noiseV = this.noiseVar[k];
      if (noiseV < 1e-20) continue;

      const power  = mag[k] * mag[k];

      // ── A posteriori SNR: γ(k) = |Y(k)|² / σ²_n(k)
      const gammaK = power / noiseV;

      // ── A priori SNR via decision-directed (Ephraim-Malah 1984):
      //    ξ(k) = α_dd * |Ŝ(k-1)|² / σ²_n(k) + (1-α_dd) * max(γ(k)-1, 0)
      const prevCleanPower = prevMag[k] * prevMag[k];
      const xiDD = smooth * (prevCleanPower / noiseV)
                 + (1 - smooth) * Math.max(gammaK - 1, 0);
      // Clamp to prevent extreme values
      const xi = Math.max(xiDD, 1e-4);
      snrPrior[k] = xi;

      // ── v(k) = ξ * γ / (1 + ξ)
      const v = (xi * gammaK) / (1 + xi);

      // ── Exponential integral E1(v) approximation (Abramowitz & Stegun)
      //    For v > 1: E1(v) ≈ e^(-v)/v * (v² + a1*v + a2) / (v² + b1*v + b2)
      //    For v ≤ 1: E1(v) ≈ -ln(v) - 0.5772 + v - v²/4
      let e1;
      if (v > 1) {
        const a1 = 2.334733, a2 = 0.250621;
        const b1 = 3.330657, b2 = 1.681534;
        e1 = Math.exp(-v) / (v + 1e-20) * (v * v + a1 * v + a2) / (v * v + b1 * v + b2);
      } else {
        e1 = Math.max(-Math.log(v + 1e-20) - 0.5772156649 + v - v * v * 0.25, 0);
      }

      // ── Log-MMSE gain: G = ξ/(1+ξ) * exp(0.5 * E1(v))
      let gain = (xi / (1 + xi)) * Math.exp(0.5 * e1);

      // ── Apply user-controlled amount (blend between unity and full NR)
      gain = 1.0 - amount * (1.0 - gain);

      // ── Spectral floor to prevent musical noise (PDF §7 "spectral flooring
      //    establishes minimum amplitude... masks warbling beneath uniform floor")
      gain = Math.max(gain, specFloor);

      // ── Adaptive temporal gain smoothing ────────────────────────────
      //    Fast attack (0.3) during speech → preserve transients
      //    Slow release (0.85) during noise → prevent flutter/musical noise
      const pSpeech = this.speechPresProb[k] || 0;
      const smoothCoef = 0.3 + 0.55 * (1.0 - pSpeech); // 0.3 speech → 0.85 noise
      const gainSmooth = smoothCoef * prevGain[k] + (1 - smoothCoef) * gain;
      prevGain[k] = gainSmooth;

      // ── Apply gain + store clean estimate for next frame's decision-directed
      const cleaned = mag[k] * gainSmooth;
      prevMag[k] = cleaned;
      mag[k] = cleaned;
    }
  }

  // ── De-Clipping Detection + Spectral Repair ────────────────────────────
  //  Ref: PDF §14.2 — "De-clipping algorithms must run to interpolate
  //   and redraw missing waveform peaks before spectral analysis."
  //  In spectral domain: detect flat-top peaks (consecutive max-magnitude
  //  bins) and interpolate surrounding spectral shape.
  _deClipRepair(mag, phase) {
    const nBins = this.numBins;
    // Find max magnitude in frame
    let maxMag = 0;
    for (let k = 1; k < nBins; k++) {
      if (mag[k] > maxMag) maxMag = mag[k];
    }
    if (maxMag < 0.9) return; // no clipping detected

    // Count bins at or near max (clipping signature: flat spectral ceiling)
    let clipBins = 0;
    for (let k = 1; k < nBins; k++) {
      if (mag[k] > maxMag * 0.98) clipBins++;
    }

    // If >15% of bins are clipped, apply soft-clip repair
    if (clipBins > nBins * 0.15) {
      const ceiling = maxMag * 0.85;
      for (let k = 1; k < nBins; k++) {
        if (mag[k] > ceiling) {
          // Soft sigmoid compression above ceiling
          const excess = (mag[k] - ceiling) / (maxMag - ceiling + 1e-10);
          mag[k] = ceiling + (maxMag - ceiling) * (2.0 / (1.0 + Math.exp(-3 * excess)) - 1.0) * 0.3;
        }
      }
    }
  }

  // ── ERB Spectral Gate: 32-band psychoacoustic gating ───────────────────
  //  With cross-band gain smoothing to prevent sharp discontinuities
  _erbGate(mag) {
    if (!this.erbBandMap) return;
    const { start, end } = this.erbBandMap;
    const sensitivity = this.params.nrSensitivity / 100;
    if (sensitivity < 0.01) return; // bypass when sensitivity=0
    const gateFloor   = Math.pow(10, (this.params.nrFloor + 10) / 20);

    for (let b = 0; b < 32; b++) {
      // Band energy
      let bandEnergy = 0;
      let noiseEnergy = 0;
      const count = end[b] - start[b];
      for (let k = start[b]; k < end[b]; k++) {
        bandEnergy  += mag[k] * mag[k];
        noiseEnergy += this.noiseProfile[k] * this.noiseProfile[k];
      }
      bandEnergy  /= count || 1;
      noiseEnergy /= count || 1;

      // Band SNR
      const snr = noiseEnergy > 1e-10 ? bandEnergy / noiseEnergy : 100;
      // Gate: soft knee around threshold
      const thresh = 1.0 + (1.0 - sensitivity) * 5.0; // 1–6 depending on sensitivity
      let gain;
      if (snr > thresh * 2) {
        gain = 1.0;
      } else if (snr > thresh) {
        gain = (snr - thresh) / thresh; // linear ramp 0→1
      } else {
        gain = gateFloor;
      }

      this.erbGains[b] = gain;
    }

    // ── Cross-band gain smoothing (3-tap moving average) ────────────
    // Prevents sharp gain jumps between adjacent perceptual bands
    const smoothed = this.erbGains;
    let prev = smoothed[0];
    for (let b = 1; b < 31; b++) {
      const cur = smoothed[b];
      const next = smoothed[b + 1];
      smoothed[b] = 0.25 * prev + 0.5 * cur + 0.25 * next;
      prev = cur;
    }

    // Apply smoothed gains to bins
    for (let b = 0; b < 32; b++) {
      const g = smoothed[b];
      for (let k = start[b]; k < end[b]; k++) {
        mag[k] *= g;
      }
    }
  }

  // ── Hum Removal: conditional notch at 50/60 Hz + harmonics ──────────────
  //  Only activates when hum energy at fundamental >6dB above surrounding bins.
  //  Ref: PDF §14.4 — "specialized De-buzz detector locks onto fundamental"
  _humRemoval(mag) {
    const sr    = this.sr;
    const N     = this.fftSize;
    const binHz = sr / N;

    // Measure energy at 50 Hz and 60 Hz vs surrounding ±5 bins
    const bin50 = Math.round(50 / binHz);
    const bin60 = Math.round(60 / binHz);

    const measureHum = (centerK) => {
      if (centerK < 3 || centerK >= this.numBins - 3) return 0;
      const peak = mag[centerK];
      let surround = 0;
      let count = 0;
      for (let d = -5; d <= 5; d++) {
        if (d === 0 || d === -1 || d === 1) continue; // skip center ±1
        const k = centerK + d;
        if (k > 0 && k < this.numBins) { surround += mag[k]; count++; }
      }
      surround /= count || 1;
      return surround > 1e-10 ? peak / surround : 0;
    };

    const ratio50 = measureHum(bin50);
    const ratio60 = measureHum(bin60);

    // Only proceed if hum is >4× (≈6dB) above surrounding energy
    const humThreshold = 4.0;
    if (ratio50 < humThreshold && ratio60 < humThreshold) return;

    const fundamental = ratio50 > ratio60 ? 50 : 60;

    // Attenuate fundamental + 8 harmonics with adaptive depth
    for (let h = 1; h <= 9; h++) {
      const freq    = fundamental * h;
      const centerK = Math.round(freq / binHz);
      if (centerK >= this.numBins) break;
      // Notch width: ±2 bins for fundamental, ±1 for harmonics
      const width   = h === 1 ? 2 : 1;
      // Attenuation decreases for higher harmonics (less energy)
      const maxAttn = h === 1 ? 0.02 : 0.05 + h * 0.02;
      for (let k = centerK - width; k <= centerK + width; k++) {
        if (k > 0 && k < this.numBins) {
          const dist = Math.abs(k - centerK);
          const attn = dist === 0 ? maxAttn : maxAttn + (1 - maxAttn) * (dist / (width + 1));
          mag[k] *= attn;
        }
      }
    }
  }

  // ── Voice Band Focus: boost voice range, suppress outside ──────────────
  _voiceBandFocus(mag) {
    const voiceIso = this.params.voiceIso / 100;
    if (voiceIso < 0.01) return;

    const sr    = this.sr;
    const N     = this.fftSize;
    const binHz = sr / N;
    const loK   = Math.round(this.params.voiceFocusLo / binHz);
    const hiK   = Math.round(this.params.voiceFocusHi / binHz);
    const suppress = this.params.bgSuppress / 100 * voiceIso;
    const floor    = 1.0 - suppress * 0.95; // minimum 5% pass-through

    for (let k = 1; k < this.numBins; k++) {
      if (k < loK || k > hiK) {
        // Smooth rolloff around edges (±10 bins)
        const distFromEdge = k < loK ? (loK - k) : (k - hiK);
        const rolloff = Math.min(distFromEdge / 10, 1.0);
        mag[k] *= floor + (1.0 - floor) * (1.0 - rolloff);
      }
    }
  }

  // ── Spectral EQ: 10-band parametric in frequency domain ────────────────
  _spectralEQ(mag) {
    const sr    = this.sr;
    const N     = this.fftSize;
    const binHz = sr / N;

    const bands = [
      { freq: 40,    gain: this.params.eqSub },
      { freq: 100,   gain: this.params.eqBass },
      { freq: 200,   gain: this.params.eqWarmth },
      { freq: 400,   gain: this.params.eqBody },
      { freq: 800,   gain: this.params.eqLowMid },
      { freq: 1500,  gain: this.params.eqMid },
      { freq: 3000,  gain: this.params.eqPresence },
      { freq: 5000,  gain: this.params.eqClarity },
      { freq: 10000, gain: this.params.eqAir },
      { freq: 16000, gain: this.params.eqBrill },
    ];

    for (const band of bands) {
      if (Math.abs(band.gain) < 0.1) continue; // skip inactive bands
      const linGain = Math.pow(10, band.gain / 20);
      const centerK = Math.round(band.freq / binHz);
      // Bell width in bins (1 octave ~= centerK * 0.41)
      const widthK  = Math.max(4, Math.round(centerK * 0.41));

      for (let k = Math.max(1, centerK - widthK); k <= Math.min(this.numBins - 1, centerK + widthK); k++) {
        const dist = Math.abs(k - centerK) / widthK;
        // Raised cosine shape
        const shape = 0.5 * (1.0 + Math.cos(Math.PI * Math.min(dist, 1.0)));
        const g = 1.0 + (linGain - 1.0) * shape;
        mag[k] *= g;
      }
    }
  }

  // ── De-essing: attenuate sibilant frequencies ──────────────────────────
  _deEss(mag) {
    const amt = this.params.deEssAmt / 100;
    if (amt < 0.01) return;

    const sr      = this.sr;
    const N       = this.fftSize;
    const binHz   = sr / N;
    const centerK = Math.round(this.params.deEssFreq / binHz);
    const widthK  = Math.round(2000 / binHz); // ±2kHz range

    // Measure energy in sibilance band
    let sibEnergy = 0, count = 0;
    for (let k = Math.max(1, centerK - widthK); k <= Math.min(this.numBins - 1, centerK + widthK); k++) {
      sibEnergy += mag[k] * mag[k];
      count++;
    }
    sibEnergy = Math.sqrt(sibEnergy / (count || 1));

    // Dynamic threshold: only attenuate when sibilance exceeds background
    const threshold = 0.02;
    if (sibEnergy > threshold) {
      const reduction = amt * 0.7; // max 70% reduction
      for (let k = Math.max(1, centerK - widthK); k <= Math.min(this.numBins - 1, centerK + widthK); k++) {
        const dist = Math.abs(k - centerK) / widthK;
        const shape = 0.5 * (1.0 + Math.cos(Math.PI * Math.min(dist, 1.0)));
        mag[k] *= 1.0 - reduction * shape;
      }
    }
  }

  // ── Spectral Tilt: dB/octave slope ─────────────────────────────────────
  _spectralTilt(mag) {
    const tilt = this.params.specTilt;
    if (Math.abs(tilt) < 0.1) return;

    const sr    = this.sr;
    const N     = this.fftSize;
    const binHz = sr / N;
    const refK  = Math.round(1000 / binHz); // reference at 1kHz

    for (let k = 1; k < this.numBins; k++) {
      const octaves = Math.log2(k / refK);
      const gainDB  = tilt * octaves;
      mag[k] *= Math.pow(10, gainDB / 20);
    }
  }

  // ── Harmonic Recovery: soft saturation to regenerate destroyed harmonics
  _harmonicRecovery(mag, phase) {
    const recov = this.params.harmRecov / 100;
    if (recov < 0.01) return;
    const order = Math.min(8, Math.max(2, this.params.harmOrder));

    // For each voice-band bin, add attenuated harmonic content
    const sr    = this.sr;
    const N     = this.fftSize;
    const binHz = sr / N;
    const loK   = Math.round(this.params.voiceFocusLo / binHz);
    const hiK   = Math.min(Math.round(this.params.voiceFocusHi / binHz), this.numBins / order);

    for (let k = loK; k < hiK; k++) {
      if (mag[k] < 1e-6) continue;
      for (let h = 2; h <= order; h++) {
        const hk = k * h;
        if (hk >= this.numBins) break;
        // Add harmonic energy (attenuated by 1/h²) only if below existing level
        const harmonicMag = mag[k] * recov / (h * h);
        if (harmonicMag > mag[hk]) {
          mag[hk] = harmonicMag;
          phase[hk] = phase[k] * h; // phase-locked
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  TIME-DOMAIN POST-PROCESSING (after iSTFT)
  // ══════════════════════════════════════════════════════════════════════════

  _applyTimeDomain(block) {
    const len = block.length;
    const p   = this.params;
    const sr  = this.sr;

    // ── DC Offset Removal (PDF §14.1 — "must be removed FIRST") ─────
    //    Single-pole HP: y[n] = x[n] - x[n-1] + R*y[n-1], R ≈ 0.9993 @ 48kHz
    //    "Processing an off-center waveform induces severe clicking artifacts"
    {
      const R = 1.0 - (2.0 * Math.PI * 5.0 / sr);
      let prevX = this._dcPrevX || 0;
      let prevY = this._dcState;
      for (let i = 0; i < len; i++) {
        const x = block[i];
        const y = x - prevX + R * prevY;
        prevX = x;
        prevY = y;
        block[i] = y;
      }
      this._dcState = prevY;
      this._dcPrevX = prevX;
    }

    // ── High-Pass Filter (2nd-order Butterworth) ─────────────────────
    if (p.hpFreq > 20) {
      const w0 = 6.283185307179586 * p.hpFreq / sr;
      const alpha = Math.sin(w0) / (2 * p.hpQ);
      const cos0  = Math.cos(w0);
      const a0    = 1 + alpha;
      const b0 = (1 + cos0) / 2 / a0;
      const b1 = -(1 + cos0) / a0;
      const b2 = (1 + cos0) / 2 / a0;
      const a1 = -(-2 * cos0) / a0;
      const a2 = -(1 - alpha) / a0;
      let [x1, x2, y1, y2] = this._hpState;
      for (let i = 0; i < len; i++) {
        const x = block[i];
        const y = b0 * x + b1 * x1 + b2 * x2 + a1 * y1 + a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        block[i] = y;
      }
      this._hpState[0] = x1; this._hpState[1] = x2;
      this._hpState[2] = y1; this._hpState[3] = y2;
    }

    // ── Low-Pass Filter ──────────────────────────────────────────────
    if (p.lpFreq < sr / 2 - 100) {
      const w0 = 6.283185307179586 * p.lpFreq / sr;
      const alpha = Math.sin(w0) / (2 * p.lpQ);
      const cos0  = Math.cos(w0);
      const a0    = 1 + alpha;
      const b0 = (1 - cos0) / 2 / a0;
      const b1 = (1 - cos0) / a0;
      const b2 = (1 - cos0) / 2 / a0;
      const a1 = -(-2 * cos0) / a0;
      const a2 = -(1 - alpha) / a0;
      let [x1, x2, y1, y2] = this._lpState;
      for (let i = 0; i < len; i++) {
        const x = block[i];
        const y = b0 * x + b1 * x1 + b2 * x2 + a1 * y1 + a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        block[i] = y;
      }
      this._lpState[0] = x1; this._lpState[1] = x2;
      this._lpState[2] = y1; this._lpState[3] = y2;
    }

    // ── Noise Gate (time-domain) ─────────────────────────────────────
    const gateThreshLin   = Math.pow(10, p.gateThresh / 20);
    const gateRangeLin    = Math.pow(10, p.gateRange / 20);
    const gateAttackCoef  = Math.exp(-1 / (sr * p.gateAttack / 1000));
    const gateReleaseCoef = Math.exp(-1 / (sr * p.gateRelease / 1000));
    const holdSamples     = Math.round(sr * p.gateHold / 1000);
    let g = this._gateGain;
    let holdCount = this._gateHoldCount;

    for (let i = 0; i < len; i++) {
      const abs = Math.abs(block[i]);
      if (abs >= gateThreshLin) {
        g = g + (1 - g) * (1 - gateAttackCoef);
        holdCount = holdSamples;
      } else if (holdCount > 0) {
        holdCount--;
      } else {
        g = g * gateReleaseCoef + gateRangeLin * (1 - gateReleaseCoef);
      }
      block[i] *= g;
    }
    this._gateGain = g;
    this._gateHoldCount = holdCount;

    // ── Feed-Forward Compressor ──────────────────────────────────────
    const compThreshLin  = Math.pow(10, p.compThresh / 20);
    const compSlope      = 1 - 1 / Math.max(1, p.compRatio);
    const compAttackCoef = Math.exp(-1 / (sr * p.compAttack / 1000));
    const compRelCoef    = Math.exp(-1 / (sr * p.compRelease / 1000));
    const compMakeupLin  = Math.pow(10, p.compMakeup / 20);
    const limThreshLin   = Math.pow(10, p.limThresh / 20);
    let env = this._compEnv;

    for (let i = 0; i < len; i++) {
      const abs = Math.abs(block[i]);
      env = abs > env
        ? abs * (1 - compAttackCoef) + env * compAttackCoef
        : abs * (1 - compRelCoef) + env * compRelCoef;

      let gain = 1.0;
      if (env > compThreshLin) {
        gain = Math.pow(env / compThreshLin, -compSlope);
      }

      // Apply + makeup + brickwall limiter
      const out = block[i] * gain * compMakeupLin;
      block[i] = Math.max(-limThreshLin, Math.min(limThreshLin, out));
    }
    this._compEnv = env;

    // ── Output Gain ──────────────────────────────────────────────────
    if (p.outGain !== 0) {
      const outLin = Math.pow(10, p.outGain / 20);
      for (let i = 0; i < len; i++) block[i] *= outLin;
    }
  }
}

registerProcessor('dsp-processor', DspProcessor);
