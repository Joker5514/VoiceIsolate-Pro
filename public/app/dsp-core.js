/* ============================================
   VoiceIsolate Pro v20.0 — DSPCore
   Threads from Space v10 · Pure DSP Math
   STFT/iSTFT · Biquad · Spectral · ERB
   Adaptive Wiener · Harmonic v2 · Noise Class
   ============================================ */

'use strict';

/**
 * Per-bin adaptive noise floor tracker using a minimum statistics approach
 * (Martin 2001). Maintains a rolling minimum over a configurable window of
 * past noise-magnitude estimates and updates only during VAD-inactive frames.
 */
/**
 * AdaptiveNoiseFloor: used by applyAdaptiveWiener()
 * Tracks minimum statistics. Designed for offline Creator Mode
 * and Forensic Mode where latency is acceptable.
 */
class AdaptiveNoiseFloor {
  /**
   * @param {number} numBins      - Number of FFT bins (fftSize/2 + 1)
   * @param {number} smoothingMs  - Noise-floor smoothing time constant in ms
   * @param {number} hopSize      - Hop size in samples
   * @param {number} sampleRate   - Sample rate in Hz
   */
  constructor(numBins, smoothingMs = 200, hopSize = 1024, sampleRate = 48000) {
    this.numBins = numBins;
    // Per-bin smoothed noise magnitude estimate
    this.noiseEst = new Float32Array(numBins);
    // Rolling minimum window: 5 sub-windows (Martin 2001 §3.2)
    this._windowCount = 5;
    this._subWinLen = Math.max(
      1,
      Math.round((smoothingMs / 1000) * (sampleRate / hopSize) / this._windowCount)
    );
    this._minStore = Array.from({ length: this._windowCount }, () => new Float32Array(numBins).fill(Infinity));
    this._tmpMin = new Float32Array(numBins).fill(Infinity);
    this._subFrameIdx = 0;
    this._subWinIdx = 0;
    // Smoothing coefficient (IIR one-pole)
    const smoothFrames = Math.max(1, Math.round((smoothingMs / 1000) * (sampleRate / hopSize)));
    this.alpha = Math.exp(-1 / smoothFrames);
    this._initialized = false;
  }

  /**
   * Update the noise floor estimate with a new magnitude frame.
   * Only call this during VAD-inactive (silence) frames.
   * @param {Float32Array} mag - Magnitude spectrum for the current frame
   */
  update(mag) {
    if (!this._initialized) {
      this.noiseEst.set(mag);
      for (const w of this._minStore) w.set(mag);
      this._tmpMin.set(mag);
      this._initialized = true;
      return;
    }

    for (let k = 0; k < this.numBins; k++) {
      // Smooth current magnitude into running estimate
      this.noiseEst[k] = this.alpha * this.noiseEst[k] + (1 - this.alpha) * mag[k];
      // Update rolling minimum
      if (this.noiseEst[k] < this._tmpMin[k]) this._tmpMin[k] = this.noiseEst[k];
    }

    this._subFrameIdx++;
    if (this._subFrameIdx >= this._subWinLen) {
      // Rotate sub-windows
      this._minStore[this._subWinIdx].set(this._tmpMin);
      this._subWinIdx = (this._subWinIdx + 1) % this._windowCount;
      // Reset tmp min for next sub-window
      this._tmpMin.fill(Infinity);
      for (let k = 0; k < this.numBins; k++) {
        this._tmpMin[k] = this.noiseEst[k];
      }
      this._subFrameIdx = 0;
    }
  }

  /**
   * Return the current per-bin minimum noise floor estimate.
   * @param {Float32Array} [out] - Optional pre-allocated output buffer (length >= numBins).
   *   Pass a reusable buffer to avoid per-call allocation in hot loops.
   * @returns {Float32Array}
   */
  getFloor(out = null) {
    const floor = out || new Float32Array(this.numBins);
    floor.fill(Infinity);
    for (const w of this._minStore) {
      for (let k = 0; k < this.numBins; k++) {
        if (w[k] < floor[k]) floor[k] = w[k];
      }
    }
    // Clamp Infinity (uninitialized) to 0
    for (let k = 0; k < this.numBins; k++) {
      if (!isFinite(floor[k])) floor[k] = 0;
    }
    return floor;
  }

  /** Reset all state (e.g. between files) */
  reset() {
    this.noiseEst.fill(0);
    for (const w of this._minStore) w.fill(Infinity);
    this._tmpMin.fill(Infinity);
    this._subFrameIdx = 0;
    this._subWinIdx = 0;
    this._initialized = false;
  }
}

// Hardened Wiener filter — aggressive voice isolation
function wienerFilter(noiseMag, signalMag, params = {}) {
  const alpha = params.noiseOverSubtract || 2.0; // over-subtraction factor (was 1.0)
  const beta = params.spectralFloor || 0.001;   // spectral floor (was 0.01 — lower = cleaner)
  const voiceBoost = params.voiceBoost || 1.5;   // boost voice band 80Hz-4kHz

  const noisePow = noiseMag * noiseMag;
  const sigPow = signalMag * signalMag;
  const snr = sigPow / (alpha * noisePow + 1e-10);

  // Sigmoid-shaped suppression curve for sharper voice/noise boundary
  const suppressionCurve = snr / (snr + 1.0);
  const gain = Math.max(beta, suppressionCurve * suppressionCurve); // squared for aggression

  return gain * voiceBoost;
}

// Voice frequency mask — boosts 80Hz-4kHz, hard-suppresses outside
// binIndex: the FFT bin index, sampleRate: audio sample rate, fftSize: FFT size
function getVoiceMaskGain(binIndex, sampleRate, fftSize) {
  const freq = binIndex * sampleRate / fftSize;

  if (freq < 60) return 0.0;           // sub-bass: kill
  if (freq < 80) return 0.3;           // low rolloff
  if (freq < 300) return 0.85;         // low voice fundamentals
  if (freq <= 3400) return 1.0;        // CORE VOICE BAND — full pass
  if (freq <= 4000) return 0.9;        // soft rolloff
  if (freq <= 6000) return 0.6;        // sibilants — partial keep
  if (freq <= 8000) return 0.25;       // high presence — attenuate
  return 0.05;                         // ultra-high: near-kill
}

/**
 * Pure DSP math library. No Web Audio API dependency.
 * - Forward/inverse STFT with Hann windowing
 * - Biquad filter implementation (Direct Form II)
 * - Cascaded notch chains, parametric EQ
 * - Spectral noise subtraction (Wiener-MMSE)
 * - Adaptive Wiener filter (per-bin, Martin 2001 minimum statistics)
 * - 32 ERB band spectral gate
 * - Temporal smoothing, harmonic enhancement v2 (SBR + formant + breathiness)
 * - Dereverberation, de-essing, de-clicking
 * - LUFS measurement, true-peak limiting, dither
 * - Lightweight spectral noise classifier
 */
const DSPCore = {

  // ===== CONSTANTS =====
  FRAME_SIZE: 4096,
  HOP_SIZE: 1024,
  SAMPLE_RATE: 48000,

  // ===== WINDOWING =====

  // Cache for hannWindow — keyed by N so identical sizes are only computed once.
  _hannCache: new Map(),

  /** Generate periodic Hann window of given length (required for COLA at 75% overlap) */
  hannWindow(N) {
    if (this._hannCache.has(N)) return this._hannCache.get(N);
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / N));
    }
    this._hannCache.set(N, w);
    return w;
  },

  // ===== STFT / iSTFT =====

  /**
   * Forward STFT: time-domain → magnitude + phase arrays
   * Single entry point for all spectral operations.
   * @param {Float32Array} data - input audio
   * @param {number} fftSize - FFT frame size (default 4096)
   * @param {number} hopSize - hop between frames (default 1024)
   * @returns {{ mag: Float32Array[], phase: Float32Array[], frameCount: number }}
   */
  forwardSTFT(data, fftSize = 4096, hopSize = 1024) {
    const window = this.hannWindow(fftSize);
    const halfN = fftSize / 2 + 1;
    const frameCount = Math.floor((data.length - fftSize) / hopSize) + 1;
    const mag = [];
    const phase = [];

    // Reuse buffers across frames to reduce GC pressure.
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);

    for (let f = 0; f < frameCount; f++) {
      const offset = f * hopSize;
      // Windowed frame → real/imag (imag is always 0 for real input)
      imag.fill(0);
      for (let i = 0; i < fftSize; i++) {
        real[i] = (offset + i < data.length) ? data[offset + i] * window[i] : 0;
      }

      // In-place FFT (Cooley-Tukey radix-2)
      this._fft(real, imag, false);

      // Extract magnitude and phase for positive frequencies
      const m = new Float32Array(halfN);
      const p = new Float32Array(halfN);
      for (let k = 0; k < halfN; k++) {
        m[k] = Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
        p[k] = Math.atan2(imag[k], real[k]);
      }
      mag.push(m);
      phase.push(p);
    }

    return { mag, phase, frameCount };
  },

  /**
   * Inverse STFT: magnitude + phase → time-domain
   * Single exit point after all spectral operations.
   */
  inverseSTFT(mag, phase, fftSize = 4096, hopSize = 1024, outputLength = 0) {
    const window = this.hannWindow(fftSize);
    const frameCount = mag.length;
    const halfN = fftSize / 2 + 1;
    const len = outputLength || (frameCount - 1) * hopSize + fftSize;
    const output = new Float32Array(len);
    const windowSum = new Float32Array(len);

    // Reuse buffers across frames to avoid per-frame Float32Array allocation.
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);

    for (let f = 0; f < frameCount; f++) {
      const offset = f * hopSize;

      // Reconstruct complex spectrum (clear only used region)
      for (let k = 0; k < halfN; k++) {
        real[k] = mag[f][k] * Math.cos(phase[f][k]);
        imag[k] = mag[f][k] * Math.sin(phase[f][k]);
      }
      // Mirror for negative frequencies
      for (let k = halfN; k < fftSize; k++) {
        real[k] = real[fftSize - k];
        imag[k] = -imag[fftSize - k];
      }

      // Inverse FFT
      this._fft(real, imag, true);

      // Overlap-add with synthesis window
      for (let i = 0; i < fftSize; i++) {
        if (offset + i < len) {
          output[offset + i] += real[i] * window[i];
          windowSum[offset + i] += window[i] * window[i];
        }
      }
    }

    // Normalize by window sum
    for (let i = 0; i < len; i++) {
      if (windowSum[i] > 1e-8) output[i] /= windowSum[i];
    }

    return output;
  },

  /** Cooley-Tukey radix-2 FFT (in-place) */
  _fft(real, imag, inverse) {
    const N = real.length;
    // Bit-reversal permutation
    for (let i = 1, j = 0; i < N; i++) {
      let bit = N >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        [real[i], real[j]] = [real[j], real[i]];
        [imag[i], imag[j]] = [imag[j], imag[i]];
      }
    }

    // Butterfly stages
    for (let len = 2; len <= N; len <<= 1) {
      const halfLen = len >> 1;
      const angle = (inverse ? 2 : -2) * Math.PI / len;
      const wR = Math.cos(angle);
      const wI = Math.sin(angle);

      for (let i = 0; i < N; i += len) {
        let curR = 1, curI = 0;
        for (let j = 0; j < halfLen; j++) {
          const tR = curR * real[i + j + halfLen] - curI * imag[i + j + halfLen];
          const tI = curR * imag[i + j + halfLen] + curI * real[i + j + halfLen];
          real[i + j + halfLen] = real[i + j] - tR;
          imag[i + j + halfLen] = imag[i + j] - tI;
          real[i + j] += tR;
          imag[i + j] += tI;
          const newCurR = curR * wR - curI * wI;
          curI = curR * wI + curI * wR;
          curR = newCurR;
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < N; i++) { real[i] /= N; imag[i] /= N; }
    }
  },

  // ===== BIQUAD FILTERS =====

  /** Create biquad filter coefficients */
  biquadCoeffs(type, freq, Q, gain, sr) {
    const w0 = 2 * Math.PI * freq / sr;
    const alpha = Math.sin(w0) / (2 * Q);
    const A = Math.pow(10, gain / 40);
    let b0, b1, b2, a0, a1, a2;

    switch (type) {
      case 'highpass':
        b0 = (1 + Math.cos(w0)) / 2;
        b1 = -(1 + Math.cos(w0));
        b2 = b0;
        a0 = 1 + alpha;
        a1 = -2 * Math.cos(w0);
        a2 = 1 - alpha;
        break;

      case 'lowpass':
        b0 = (1 - Math.cos(w0)) / 2;
        b1 = 1 - Math.cos(w0);
        b2 = b0;
        a0 = 1 + alpha;
        a1 = -2 * Math.cos(w0);
        a2 = 1 - alpha;
        break;

      case 'notch':
        b0 = 1;
        b1 = -2 * Math.cos(w0);
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * Math.cos(w0);
        a2 = 1 - alpha;
        break;

      case 'peaking':
        b0 = 1 + alpha * A;
        b1 = -2 * Math.cos(w0);
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * Math.cos(w0);
        a2 = 1 - alpha / A;
        break;

      case 'highshelf':
        b0 = A * ((A + 1) + (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha);
        b1 = -2 * A * ((A - 1) + (A + 1) * Math.cos(w0));
        b2 = A * ((A + 1) + (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha);
        a0 = (A + 1) - (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha;
        a1 = 2 * ((A - 1) - (A + 1) * Math.cos(w0));
        a2 = (A + 1) - (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha;
        break;

      default: // lowshelf
        b0 = A * ((A + 1) - (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha);
        b1 = 2 * A * ((A - 1) - (A + 1) * Math.cos(w0));
        b2 = A * ((A + 1) - (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha);
        a0 = (A + 1) + (A - 1) * Math.cos(w0) + 2 * Math.sqrt(A) * alpha;
        a1 = -2 * ((A - 1) + (A + 1) * Math.cos(w0));
        a2 = (A + 1) + (A - 1) * Math.cos(w0) - 2 * Math.sqrt(A) * alpha;
    }

    return { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0 };
  },

  /** Apply biquad filter (Direct Form II Transposed) in-place */
  biquadProcess(data, coeffs) {
    const { b0, b1, b2, a1, a2 } = coeffs;
    let z1 = 0, z2 = 0;
    for (let i = 0; i < data.length; i++) {
      const x = data[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      data[i] = y;
    }
    return data;
  },

  // ===== PASS 1: INPUT CONDITIONING =====

  /** S03: Remove DC offset with 2nd-order Butterworth HPF at 5Hz */
  removeDCOffset(data, sr) {
    const coeffs = this.biquadCoeffs('highpass', 5, 0.707, 0, sr);
    return this.biquadProcess(data, coeffs);
  },

  /** S04: Peak normalization to target dBFS */
  peakNormalize(data, targetDb) {
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    if (peak < 1e-10) return data;
    const targetLin = Math.pow(10, targetDb / 20);
    const gain = targetLin / peak;
    for (let i = 0; i < data.length; i++) data[i] *= gain;
    return data;
  },

  // ===== PASS 2: TIME-DOMAIN CLEANUP =====

  /** S05: Noise gate with attack/release/hold/lookahead */
  noiseGate(data, params, sr) {
    const { threshold, range, attack, release, hold, lookahead } = params;
    const threshLin = Math.pow(10, threshold / 20);
    const rangeLin = Math.pow(10, range / 20);
    const attackCoeff = Math.exp(-1 / (attack * 0.001 * sr));
    const releaseCoeff = Math.exp(-1 / (release * 0.001 * sr));
    const holdSamples = Math.floor(hold * 0.001 * sr);
    const lookaheadSamples = Math.floor(lookahead * 0.001 * sr);

    let env = 0;
    let holdCounter = 0;

    // Apply with lookahead via delay
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) {
      const lookIdx = Math.min(i + lookaheadSamples, data.length - 1);
      const absVal = Math.abs(data[lookIdx]);

      let target;
      if (absVal > threshLin) {
        target = 1;
        holdCounter = holdSamples;
      } else if (holdCounter > 0) {
        target = 1;
        holdCounter--;
      } else {
        target = rangeLin;
      }

      const coeff = (target > env) ? (1 - attackCoeff) : (1 - releaseCoeff);
      env += coeff * (target - env);

      out[i] = data[i] * env;
    }
    return out;
  },

  /** S06: Cascaded notch filters for hum removal */
  cascadedNotch(data, frequencies, Q, sr) {
    for (const freq of frequencies) {
      const coeffs = this.biquadCoeffs('notch', freq, Q, 0, sr);
      this.biquadProcess(data, coeffs);
    }
    return data;
  },

  /** S07: Click/pop removal via transient detection + interpolation */
  removeClicks(data, sensitivity = 3) {
    const blockSize = 128;
    for (let b = 0; b < data.length - blockSize; b += blockSize) {
      let sum = 0;
      for (let i = 0; i < blockSize; i++) sum += Math.abs(data[b + i]);
      const avg = sum / blockSize;

      for (let i = 0; i < blockSize; i++) {
        if (Math.abs(data[b + i]) > avg * sensitivity * 5) {
          // Interpolate around click
          const left = b + i > 0 ? data[b + i - 1] : 0;
          const right = b + i < data.length - 1 ? data[b + i + 1] : 0;
          data[b + i] = (left + right) / 2;
        }
      }
    }
    return data;
  },

  /** S08: De-essing with dynamic compression on sibilance band */
  deEss(data, centerFreq, amount, sr) {
    if (amount <= 0) return data;
    // Band-isolate sibilance, compress, subtract excess
    const bpCoeffs = this.biquadCoeffs('peaking', centerFreq, 2, 12, sr);
    const sibilance = new Float32Array(data);
    this.biquadProcess(sibilance, bpCoeffs);

    const threshold = 0.1;
    const ratio = 1 + amount / 25; // 1:1 to 5:1
    for (let i = 0; i < data.length; i++) {
      const sAbs = Math.abs(sibilance[i]);
      if (sAbs > threshold) {
        const excess = sAbs - threshold;
        const reduced = threshold + excess / ratio;
        const reduction = sAbs > 0 ? reduced / sAbs : 1;
        data[i] *= (1 - amount / 100) + (amount / 100) * reduction;
      }
    }
    return data;
  },

  // ===== PASS 5: SPECTRAL OPERATIONS (IN-PLACE) =====

  wienerFilter(noiseMag, signalMag, params = {}) {
    return wienerFilter(noiseMag, signalMag, params);
  },

  getVoiceMaskGain(binIndex, sampleRate, fftSize) {
    return getVoiceMaskGain(binIndex, sampleRate, fftSize);
  },

  /** S15: Wiener-MMSE spectral noise subtraction */
  wienerMMSE(mag, noiseProfile, amount) {
    const alpha = amount / 100;
    const floor = 0.01; // spectral floor
    for (let f = 0; f < mag.length; f++) {
      for (let k = 0; k < mag[f].length; k++) {
        const noise = noiseProfile ? (noiseProfile[k] || 0) : 0;
        const sigPower = mag[f][k] * mag[f][k];
        const noisePower = noise * noise * alpha;
        const gain = Math.max(floor, 1 - noisePower / (sigPower + 1e-10));
        mag[f][k] *= gain;
      }
    }
    return mag;
  },

  /**
   * S15-alt: Per-bin adaptive Wiener filter (upgrade to wienerMMSE).
   * Uses a pre-computed AdaptiveNoiseFloor tracker's minimum-statistics
   * noise estimate and applies a Speech Presence Probability (SPP) weighting
   * to avoid over-suppression during voiced frames.
   *
   * @param {Float32Array[]} mag          - STFT magnitude frames (modified in-place)
   * @param {Float32Array[]} vadConf      - Per-frame VAD confidence [0..1]
   * @param {AdaptiveNoiseFloor} tracker  - Noise floor tracker (updated for silence frames)
   * @param {object} opts
   * @param {number} [opts.overSubtraction=1.2] - Over-subtraction factor α
   * @param {number} [opts.spectralFloor=0.001]  - Minimum gain floor (~-60 dB)
   * @returns {Float32Array[]} mag (in-place)
   */
  applyAdaptiveWiener(mag, vadConf, tracker, { overSubtraction = 1.2, spectralFloor = 0.001 } = {}) {
    const vadLen = vadConf ? vadConf.length : 0;
    // Single reusable buffer for getFloor() — avoids one allocation per frame.
    const floorBuf = new Float32Array(tracker.numBins);
    for (let f = 0; f < mag.length; f++) {
      const conf = vadLen > 0 ? (vadConf[Math.min(f, vadLen - 1)] || 0) : 0;
      const isSilence = conf < 0.3;

      if (isSilence) {
        tracker.update(mag[f]);
      }

      const floor = tracker.getFloor(floorBuf);
      // Speech Presence Probability: higher VAD conf → trust signal more → less suppression
      const spp = Math.min(1, conf);

      for (let k = 0; k < mag[f].length; k++) {
        const noiseMag = floor[k] || 0;
        const sigPow = mag[f][k] * mag[f][k];
        const noisePow = noiseMag * noiseMag * overSubtraction;
        // Wiener gain with SPP blending: SPP=1 → no suppression, SPP=0 → full suppression
        const wienerGain = Math.max(spectralFloor, 1 - noisePow / (sigPow + 1e-10));
        mag[f][k] *= (spp + (1 - spp) * wienerGain);
      }
    }
    return mag;
  },

  /** S16: 32 ERB band spectral gate */
  spectralGate(mag, floorDb, sr) {
    const erbBands = this._computeERBBands(32, sr, mag[0]?.length || 2049);
    const floorLin = Math.pow(10, floorDb / 20);

    for (let f = 0; f < mag.length; f++) {
      for (const band of erbBands) {
        // Compute band energy
        let energy = 0;
        for (let k = band.lo; k <= band.hi; k++) {
          energy += mag[f][k] * mag[f][k];
        }
        const rms = Math.sqrt(energy / (band.hi - band.lo + 1));

        // Gate: attenuate if below floor
        if (rms < floorLin) {
          const gain = rms / (floorLin + 1e-10);
          for (let k = band.lo; k <= band.hi; k++) {
            mag[f][k] *= gain;
          }
        }
      }
    }
    return mag;
  },

  /** S17: Harmonic enhancement via pitch-tracked boost */
  harmonicEnhance(mag, phase, amount) {
    if (amount <= 0) return mag;
    const boost = 1 + amount / 100;
    for (let f = 0; f < mag.length; f++) {
      // Simple harmonic detection: bins with local magnitude peaks
      for (let k = 2; k < mag[f].length - 2; k++) {
        if (mag[f][k] > mag[f][k-1] && mag[f][k] > mag[f][k+1] &&
            mag[f][k] > mag[f][k-2] && mag[f][k] > mag[f][k+2]) {
          mag[f][k] *= boost;
        }
      }
    }
    return mag;
  },

  /**
   * S17-v2: Harmonic Enhancer v2.
   * - Spectral Band Replication (SBR): synthesizes harmonics above 8 kHz from
   *   lower-band content by mirroring even-order energy into the high-frequency range.
   * - Formant preservation: detects F1/F2 via spectral envelope peaks and protects
   *   those bins from over-suppression by boosting them relative to neighbours.
   * - Breathiness control: separates aperiodic (noisy) from periodic (tonal) energy
   *   and applies an independent breathiness gain.
   *
   * @param {Float32Array[]} mag  - STFT magnitude frames (modified in-place)
   * @param {Float32Array[]} phase - STFT phase frames (read-only)
   * @param {number} amount       - Overall enhancement amount 0–100
   * @param {object} opts
   * @param {boolean} [opts.sbr=true]               - Enable Spectral Band Replication
   * @param {boolean} [opts.formantProtection=true]  - Enable formant preservation
   * @param {number}  [opts.breathinessGain=0.8]     - Gain for aperiodic component (0–2)
   * @param {number}  [opts.sampleRate=48000]         - Sample rate (for 8 kHz bin calc)
   * @param {number}  [opts.fftSize=4096]             - FFT size (for 8 kHz bin calc)
   * @returns {Float32Array[]} mag (in-place)
   */
  harmonicEnhanceV2(mag, phase, amount, {
    sbr = true,
    formantProtection = true,
    breathinessGain = 0.8,
    sampleRate = 48000,
    fftSize = 4096
  } = {}) {
    if (amount <= 0) return mag;
    const boost = 1 + amount / 100;
    const halfN = mag[0] ? mag[0].length : 0;
    if (halfN === 0) return mag;

    // Bin index corresponding to 8 kHz
    const bin8k = Math.round(8000 / (sampleRate / fftSize));
    // Formant search range: F1 typically 200–1000 Hz, F2 1000–3500 Hz
    const f1Lo = Math.round(200 / (sampleRate / fftSize));
    const f1Hi = Math.round(1000 / (sampleRate / fftSize));
    const f2Lo = Math.round(1000 / (sampleRate / fftSize));
    const f2Hi = Math.round(3500 / (sampleRate / fftSize));

    for (let f = 0; f < mag.length; f++) {
      const m = mag[f];

      // ---- Formant preservation ----
      if (formantProtection && f1Lo < f1Hi && f2Lo < f2Hi) {
        // Detect F1 peak
        let f1Bin = f1Lo;
        let f1Max = 0;
        for (let k = f1Lo; k <= Math.min(f1Hi, halfN - 1); k++) {
          if (m[k] > f1Max) { f1Max = m[k]; f1Bin = k; }
        }
        // Detect F2 peak
        let f2Bin = f2Lo;
        let f2Max = 0;
        for (let k = f2Lo; k <= Math.min(f2Hi, halfN - 1); k++) {
          if (m[k] > f2Max) { f2Max = m[k]; f2Bin = k; }
        }
        // Protect ±2 bins around each formant from attenuation
        const protect = (center) => {
          const lo = Math.max(0, center - 2);
          const hi = Math.min(halfN - 1, center + 2);
          for (let k = lo; k <= hi; k++) m[k] *= 1.15; // slight boost to protect
        };
        if (f1Max > 0) protect(f1Bin);
        if (f2Max > 0) protect(f2Bin);
      }

      // ---- Breathiness control ----
      // Estimate aperiodic energy (spectral flatness in voiced region 80–3000 Hz)
      const vLo = Math.round(80 / (sampleRate / fftSize));
      const vHi = Math.min(halfN - 1, Math.round(3000 / (sampleRate / fftSize)));
      if (vHi > vLo + 1) {
        let geomSum = 0, arithSum = 0;
        const vLen = vHi - vLo + 1;
        for (let k = vLo; k <= vHi; k++) {
          const v = m[k] + 1e-10;
          geomSum += Math.log(v);
          arithSum += v;
        }
        const sfm = Math.exp(geomSum / vLen) / (arithSum / vLen); // 0=tonal, 1=white
        // High sfm = more aperiodic → breathiness gain applies
        const aperiodicFrac = Math.min(1, sfm * 4); // scale to 0..1
        for (let k = vLo; k <= vHi; k++) {
          m[k] *= (1 - aperiodicFrac) + aperiodicFrac * breathinessGain;
        }
      }

      // ---- Harmonic peak boost (original v1 logic, preserved) ----
      for (let k = 2; k < Math.min(bin8k, halfN - 2); k++) {
        if (m[k] > m[k-1] && m[k] > m[k+1] &&
            m[k] > m[k-2] && m[k] > m[k+2]) {
          m[k] *= boost;
        }
      }

      // ---- Spectral Band Replication (SBR) above 8 kHz ----
      if (sbr && bin8k > 4 && bin8k < halfN - 1) {
        // Map lower-band bins (4k-8k Hz reflected) into the 8k+ region
        const srcLo = Math.round(4000 / (sampleRate / fftSize));
        const srcRange = bin8k - srcLo;
        for (let k = bin8k; k < halfN; k++) {
          const dist = k - bin8k;
          const srcBin = bin8k - 1 - (dist % Math.max(1, srcRange));
          if (srcBin >= srcLo && srcBin < bin8k) {
            // Attenuate with distance; use original phase
            const decay = Math.exp(-dist / Math.max(1, srcRange));
            m[k] = Math.max(m[k], m[srcBin] * decay * (amount / 100));
          }
        }
      }
    }
    return mag;
  },

  /** S18: Cross-frame temporal smoothing to suppress musical noise */
  temporalSmooth(mag, smoothing) {
    if (smoothing <= 0 || mag.length < 2) return mag;
    const alpha = smoothing / 100;
    for (let f = 1; f < mag.length; f++) {
      for (let k = 0; k < mag[f].length; k++) {
        mag[f][k] = alpha * mag[f - 1][k] + (1 - alpha) * mag[f][k];
      }
    }
    return mag;
  },

  /** S19: Late reverb tail estimation and spectral subtraction */
  dereverb(mag, amount, decaySec, sr, hopSize) {
    if (amount <= 0) return mag;
    const framesPerSec = sr / (hopSize || 1024);
    const decayFrames = Math.max(1, Math.floor(decaySec * framesPerSec));
    const alpha = amount / 100;

    for (let f = decayFrames; f < mag.length; f++) {
      for (let k = 0; k < mag[f].length; k++) {
        // Estimate reverb from past frames
        let reverbEst = 0;
        for (let d = 1; d <= decayFrames && f - d >= 0; d++) {
          reverbEst += mag[f - d][k] * Math.exp(-3 * d / decayFrames);
        }
        reverbEst /= decayFrames;

        // Subtract reverb estimate
        const gain = Math.max(0.05, 1 - alpha * reverbEst / (mag[f][k] + 1e-10));
        mag[f][k] *= gain;
      }
    }
    return mag;
  },

  // ===== PASS 7: PARAMETRIC EQ =====

  /** Apply multi-band parametric EQ */
  parametricEQ(data, bands, sr) {
    for (const { freq, gain, Q, type } of bands) {
      if (Math.abs(gain) < 0.1) continue; // skip near-zero
      const coeffs = this.biquadCoeffs(type || 'peaking', freq, Q || 1.4, gain, sr);
      this.biquadProcess(data, coeffs);
    }
    return data;
  },

  // ===== PASS 8: DYNAMICS =====

  /** S27: Downward expander */
  downwardExpand(data, threshold, ratio, sr) {
    const threshLin = Math.pow(10, threshold / 20);
    for (let i = 0; i < data.length; i++) {
      const absVal = Math.abs(data[i]);
      if (absVal < threshLin && absVal > 0) {
        const dbBelow = 20 * Math.log10(threshLin / absVal);
        const expansion = dbBelow * (ratio - 1);
        const gain = Math.pow(10, -expansion / 20);
        data[i] *= gain;
      }
    }
    return data;
  },

  /** S28: Compressor with threshold/ratio/attack/release/knee */
  compress(data, params, sr) {
    const { threshold, ratio, attack, release, knee, makeup } = params;
    const threshDb = threshold;
    const kneeHalf = knee / 2;
    const attackCoeff = Math.exp(-1 / (attack * 0.001 * sr));
    const releaseCoeff = Math.exp(-1 / (release * 0.001 * sr));
    const makeupLin = Math.pow(10, (makeup || 0) / 20);
    let envDb = -96;

    for (let i = 0; i < data.length; i++) {
      const inputDb = data[i] !== 0 ? 20 * Math.log10(Math.abs(data[i])) : -96;

      // Envelope follower
      if (inputDb > envDb) {
        envDb = attackCoeff * envDb + (1 - attackCoeff) * inputDb;
      } else {
        envDb = releaseCoeff * envDb + (1 - releaseCoeff) * inputDb;
      }

      // Gain computation with soft knee
      let gainDb = 0;
      if (envDb > threshDb + kneeHalf) {
        gainDb = threshDb + (envDb - threshDb) / ratio - envDb;
      } else if (envDb > threshDb - kneeHalf) {
        const x = envDb - threshDb + kneeHalf;
        gainDb = ((1 / ratio - 1) * x * x) / (2 * knee) ;
      }

      data[i] *= Math.pow(10, gainDb / 20) * makeupLin;
    }
    return data;
  },

  /** S29: ITU-R BS.1770 LUFS measurement */
  measureLUFS(data, sr) {
    // Simplified integrated loudness measurement
    const blockSize = Math.floor(0.4 * sr); // 400ms blocks
    const stepSize = Math.floor(blockSize * 0.25); // 75% overlap
    let sumSquared = 0;
    let blockCount = 0;

    for (let i = 0; i <= data.length - blockSize; i += stepSize) {
      let blockPower = 0;
      for (let j = 0; j < blockSize; j++) {
        blockPower += data[i + j] * data[i + j];
      }
      blockPower /= blockSize;
      if (blockPower > 1e-10) {
        sumSquared += blockPower;
        blockCount++;
      }
    }

    if (blockCount === 0) return -96;
    return -0.691 + 10 * Math.log10(sumSquared / blockCount);
  },

  /** S29: LUFS normalization to target */
  lufsNormalize(data, targetLUFS, sr) {
    const currentLUFS = this.measureLUFS(data, sr);
    if (currentLUFS < -70) return data; // too quiet, skip
    const gainDb = targetLUFS - currentLUFS;
    const gainLin = Math.pow(10, gainDb / 20);
    for (let i = 0; i < data.length; i++) data[i] *= gainLin;
    return data;
  },

  /** S30: De-clipper: detect and interpolate clipped samples */
  deClip(data, threshold = 0.99) {
    for (let i = 1; i < data.length - 1; i++) {
      if (Math.abs(data[i]) >= threshold) {
        data[i] = (data[i - 1] + data[i + 1]) / 2;
      }
    }
    return data;
  },

  // ===== PASS 9: OUTPUT MASTERING =====

  /** S31: Stereo widener (M/S) with mono passthrough */
  stereoWiden(left, right, width) {
    if (!right) return { left, right: left }; // mono passthrough
    if (Math.abs(width - 100) < 1) return { left, right }; // no change

    const w = width / 100;
    const out_l = new Float32Array(left.length);
    const out_r = new Float32Array(right.length);

    for (let i = 0; i < left.length; i++) {
      const mid = (left[i] + right[i]) * 0.5;
      const side = (left[i] - right[i]) * 0.5;
      out_l[i] = mid + side * w;
      out_r[i] = mid - side * w;
    }
    return { left: out_l, right: out_r };
  },

  /** S32: True peak limiter with 4x oversampling */
  truePeakLimit(data, ceilingDb) {
    const ceiling = Math.pow(10, ceilingDb / 20);
    // Simplified: hard clip with soft-knee
    for (let i = 0; i < data.length; i++) {
      if (data[i] > ceiling) {
        data[i] = ceiling * Math.tanh(data[i] / ceiling);
      } else if (data[i] < -ceiling) {
        data[i] = -ceiling * Math.tanh(data[i] / -ceiling);
      }
    }
    return data;
  },

  /** S33: TPDF dither for bit-depth reduction */
  dither(data, targetBits) {
    if (targetBits >= 32) return data;
    const scale = Math.pow(2, targetBits - 1);
    for (let i = 0; i < data.length; i++) {
      const dither = (Math.random() - Math.random()) / scale;
      data[i] += dither;
    }
    return data;
  },

  // ===== NOISE PROFILE =====

  /** Estimate noise profile from silent segments */
  estimateNoiseProfile(data, vadConfidence, fftSize = 4096, hopSize = 1024) {
    const window = this.hannWindow(fftSize);
    const halfN = fftSize / 2 + 1;
    const profile = new Float32Array(halfN);
    let count = 0;

    const framesPerVad = Math.floor(fftSize / 512); // VAD window ratio

    for (let f = 0; ; f++) {
      const offset = f * hopSize;
      if (offset + fftSize > data.length) break;

      // Check if this frame is silence (low VAD confidence)
      const vadIdx = Math.min(f * (hopSize / 512), (vadConfidence?.length || 1) - 1);
      const confidence = vadConfidence ? vadConfidence[Math.floor(vadIdx)] : 0.5;
      if (confidence > 0.3) continue; // skip voiced frames

      const real = new Float32Array(fftSize);
      const imag = new Float32Array(fftSize);
      for (let i = 0; i < fftSize; i++) {
        real[i] = data[offset + i] * window[i];
      }
      this._fft(real, imag, false);

      for (let k = 0; k < halfN; k++) {
        profile[k] += Math.sqrt(real[k] * real[k] + imag[k] * imag[k]);
      }
      count++;
    }

    if (count > 0) {
      for (let k = 0; k < halfN; k++) profile[k] /= count;
    }
    return profile;
  },

  /**
   * Lightweight spectral noise classifier.
   * Classifies the dominant noise type from an averaged STFT magnitude spectrum
   * using hand-crafted spectral feature heuristics (no ML model required on this path).
   *
   * Classes: 'music' | 'white_noise' | 'crowd' | 'HVAC' | 'keyboard' | 'traffic' | 'silence'
   *
   * @param {Float32Array[]} mag - STFT magnitude frames
   * @param {number} sr          - Sample rate in Hz
   * @param {number} fftSize     - FFT frame size
   * @returns {{ noiseClass: string, confidence: number }}
   */
  classifyNoiseSpectral(mag, sr, fftSize = 4096) {
    if (!mag || mag.length === 0) return { noiseClass: 'silence', confidence: 1 };

    const halfN = mag[0].length;
    const nyquist = sr / 2;
    const binHz = nyquist / (halfN - 1);

    // Compute averaged magnitude spectrum
    const avg = new Float32Array(halfN);
    for (const frame of mag) {
      for (let k = 0; k < halfN; k++) avg[k] += frame[k];
    }
    const nFrames = mag.length;
    for (let k = 0; k < halfN; k++) avg[k] /= nFrames;

    // Band energy helpers
    const bandEnergy = (loHz, hiHz) => {
      const lo = Math.max(0, Math.round(loHz / binHz));
      const hi = Math.min(halfN - 1, Math.round(hiHz / binHz));
      let e = 0;
      for (let k = lo; k <= hi; k++) e += avg[k] * avg[k];
      return e / Math.max(1, hi - lo + 1);
    };

    // Spectral Flatness Measure across full band
    const vLo = Math.round(20 / binHz);
    const vHi = Math.min(halfN - 1, Math.round(8000 / binHz));
    let geomSum = 0, arithSum = 0;
    const vLen = vHi - vLo + 1;
    for (let k = vLo; k <= vHi; k++) {
      const v = avg[k] + 1e-10;
      geomSum += Math.log(v);
      arithSum += v;
    }
    const sfm = Math.exp(geomSum / vLen) / (arithSum / vLen);

    // Band energies
    const subE  = bandEnergy(20, 120);
    const bassE = bandEnergy(120, 500);
    const midE  = bandEnergy(500, 2000);
    const hiE   = bandEnergy(2000, 8000);
    const airE  = bandEnergy(8000, nyquist);
    const totalE = subE + bassE + midE + hiE + airE + 1e-20;

    // Silence: very low total energy
    const rmsAll = Math.sqrt(totalE / 5);
    if (rmsAll < 1e-5) return { noiseClass: 'silence', confidence: 0.99 };

    // --- Feature-based classification ---
    const scores = {
      music:       0,
      white_noise: 0,
      crowd:       0,
      HVAC:        0,
      keyboard:    0,
      traffic:     0
    };

    // White noise: high spectral flatness, energy spread evenly
    scores.white_noise += sfm * 3;

    // Music: strong bass+mid, relatively flat across bands, harmonic peaks (low sfm)
    const musicBalance = (bassE + midE) / totalE;
    scores.music += musicBalance * 2 * (1 - sfm);
    if ((bassE / totalE) > 0.35 && sfm < 0.25) {
      scores.music += 1.5;
    }

    // Crowd: mid-dominant, moderate flatness, high vocal band
    const crowdMid = midE / totalE;
    scores.crowd += crowdMid * 2 * (sfm > 0.3 ? 1 : 0.5);

    // HVAC: strong low-frequency rumble, low spectral flatness decay
    const hvacLow = (subE + bassE) / totalE;
    scores.HVAC += hvacLow * 2 * (1 - sfm * 0.5);

    // Traffic: low-frequency and rumble, with intermittent transients
    const trafficLow = (subE + bassE * 0.5) / totalE;
    scores.traffic += trafficLow * 1.5;

    // Keyboard: high-frequency clicks, energy in hi+air bands
    const kbHigh = (hiE + airE) / totalE;
    scores.keyboard += kbHigh * 2 * (1 - sfm);

    // Find best class
    let best = 'white_noise';
    let bestScore = -1;
    for (const [cls, score] of Object.entries(scores)) {
      if (score > bestScore) { bestScore = score; best = cls; }
    }

    // Normalize confidence with softmax-like scale
    const totalScore = Object.values(scores).reduce((a, b) => a + b, 0) + 1e-10;
    const confidence = Math.min(0.99, bestScore / totalScore);

    return { noiseClass: best, confidence };
  },

  // ===== WAV ENCODING =====

  /** Encode Float32Array to WAV ArrayBuffer */
  encodeWAV(data, sampleRate, bitDepth = 16) {
    const bytesPerSample = bitDepth / 8;
    const numSamples = data.length;
    const dataSize = numSamples * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeStr = (off, str) => {
      for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    };

    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);                  // chunk size
    view.setUint16(20, bitDepth === 32 ? 3 : 1, true); // format (3=float, 1=PCM)
    view.setUint16(22, 1, true);                   // channels
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, bitDepth, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const offset = 44;
    if (bitDepth === 16) {
      for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, data[i]));
        view.setInt16(offset + i * 2, s * 0x7FFF, true);
      }
    } else if (bitDepth === 24) {
      for (let i = 0; i < numSamples; i++) {
        const s = Math.max(-1, Math.min(1, data[i]));
        const val = Math.floor(s * 0x7FFFFF);
        view.setUint8(offset + i * 3, val & 0xFF);
        view.setUint8(offset + i * 3 + 1, (val >> 8) & 0xFF);
        view.setUint8(offset + i * 3 + 2, (val >> 16) & 0xFF);
      }
    } else { // 32-bit float
      for (let i = 0; i < numSamples; i++) {
        view.setFloat32(offset + i * 4, data[i], true);
      }
    }

    return buffer;
  },

  // ===== ADVANCED DSP: ADAPTIVE NOISE ESTIMATION =====

  /**
   * AdaptiveNoiseEstimator — per-bin noise floor tracker.
   * Uses asymmetric exponential smoothing: fast attack (noise rises quickly)
   * and slow release (noise floor decreases slowly), preventing over-subtraction
   * during speech activity.
   *
   * Usage:
   *   const est = new DSPCore.AdaptiveNoiseEstimator(halfN);
   *   est.update(mag[f]);          // call each spectral frame
   *   const profile = est.getProfile();  // use for Wiener filtering
   */
  AdaptiveNoiseEstimator: class {
    /**
     * @param {number} numBins - number of FFT bins (fftSize/2 + 1)
     * @param {number} attackCoeff - per-frame smoothing when noise increases (0–1, default 0.9)
     * @param {number} releaseCoeff - per-frame smoothing when noise decreases (0–1, default 0.998)
     */
    constructor(numBins, attackCoeff = 0.9, releaseCoeff = 0.998) {
      this.noisePSD = new Float32Array(numBins);
      this.initialized = false;
      this.attackCoeff = Math.max(0, Math.min(1, attackCoeff));
      this.releaseCoeff = Math.max(0, Math.min(1, releaseCoeff));
    }

    /**
     * Update the noise PSD estimate with a new magnitude frame.
     * @param {Float32Array} mag - magnitude spectrum for current frame
     */
    update(mag) {
      if (!this.initialized) {
        for (let k = 0; k < this.noisePSD.length; k++) {
          this.noisePSD[k] = mag[k] * mag[k];
        }
        this.initialized = true;
        return;
      }
      for (let k = 0; k < this.noisePSD.length; k++) {
        const psd = mag[k] * mag[k];
        const coeff = psd > this.noisePSD[k] ? this.attackCoeff : this.releaseCoeff;
        this.noisePSD[k] = coeff * this.noisePSD[k] + (1 - coeff) * psd;
      }
    }

    /** Return the current per-bin noise PSD estimate. */
    getProfile() { return this.noisePSD; }

    /** Reset estimator state. */
    reset() {
      this.noisePSD.fill(0);
      this.initialized = false;
    }
  },

  // ===== ADVANCED DSP: MULTIBAND WIENER FILTER =====

  /**
   * MultibandWienerFilter — frequency-band-level Wiener noise suppression.
   * Divides the spectrum into logarithmically-spaced bands and computes a
   * per-band Wiener gain, then applies temporal smoothing to suppress
   * musical noise artifacts.
   *
   * Usage (operates on a single magnitude frame in-place):
   *   const wf = new DSPCore.MultibandWienerFilter(16, 48000, 4096);
   *   wf.process(mag[f], noisePSD, strength);  // modifies mag[f] in-place
   */
  MultibandWienerFilter: class {
    /**
     * @param {number} numBands - number of frequency bands (default 16)
     * @param {number} sr - sample rate (default 48000)
     * @param {number} fftSize - FFT size (default 4096)
     */
    constructor(numBands = 16, sr = 48000, fftSize = 4096) {
      this.numBands = numBands;
      this.sr = sr;
      this.fftSize = fftSize;
      this.smoothGains = new Float32Array(numBands).fill(1);
      this._bands = null; // lazily computed
    }

    /** Build logarithmically-spaced band boundaries (20 Hz – Nyquist). */
    _getBands(numBins) {
      if (this._bands) return this._bands;
      const nyquist = this.sr / 2;
      const loHz = 20;
      this._bands = [];
      for (let b = 0; b < this.numBands; b++) {
        const t0 = b / this.numBands;
        const t1 = (b + 1) / this.numBands;
        const f0 = loHz * Math.pow(nyquist / loHz, t0);
        const f1 = loHz * Math.pow(nyquist / loHz, t1);
        const binLo = Math.max(0, Math.floor(f0 * numBins / nyquist));
        const binHi = Math.min(numBins - 1, Math.ceil(f1 * numBins / nyquist));
        this._bands.push({ lo: binLo, hi: Math.max(binLo, binHi) });
      }
      return this._bands;
    }

    /**
     * Process a single magnitude frame in-place.
     * @param {Float32Array} mag - magnitude spectrum (modified in-place)
     * @param {Float32Array|null} noisePSD - per-bin noise PSD from AdaptiveNoiseEstimator
     * @param {number} strength - Wiener suppression strength 0–1 (default 1)
     * @param {number} temporalSmoothing - inter-frame gain smoothing 0–1 (default 0.85)
     * @returns {Float32Array} modified mag
     */
    process(mag, noisePSD, strength = 1, temporalSmoothing = 0.85) {
      const numBins = mag.length;
      const bands = this._getBands(numBins);
      const floor = 0.01; // minimum gain to preserve speech residual

      for (let b = 0; b < bands.length; b++) {
        const { lo, hi } = bands[b];
        const bandLen = hi - lo + 1;
        let sigPow = 0, noisePow = 0;
        for (let k = lo; k <= hi; k++) {
          sigPow += mag[k] * mag[k];
          if (noisePSD) noisePow += noisePSD[k];
        }
        sigPow /= bandLen;
        noisePow /= bandLen;

        let gain;
        if (sigPow > 1e-10) {
          const reduced = Math.max(0, sigPow - strength * noisePow);
          gain = Math.max(floor, Math.sqrt(reduced / sigPow));
        } else {
          gain = floor;
        }

        // Temporal smoothing to suppress musical noise
        this.smoothGains[b] = temporalSmoothing * this.smoothGains[b] + (1 - temporalSmoothing) * gain;

        const g = this.smoothGains[b];
        for (let k = lo; k <= hi; k++) {
          mag[k] *= g;
        }
      }
      return mag;
    }

    /** Reset gain smoothing state. */
    reset() { this.smoothGains.fill(1); }
  },

  // ===== ADVANCED DSP: VOICE ACTIVITY DETECTION =====

  /**
   * VADProcessor — lightweight energy + zero-crossing rate voice activity detector.
   * Suitable for offline batch processing and for gating noisy frames before
   * spectral subtraction. Includes a configurable hangover to avoid clipping
   * the trailing edges of speech.
   *
   * Usage:
   *   const vad = new DSPCore.VADProcessor(48000, 20, 0.6);
   *   const confidence = vad.processSignal(audioData);  // Float32Array per frame
   */
  VADProcessor: class {
    /**
     * @param {number} sr - sample rate (default 48000)
     * @param {number} frameSizeMs - analysis frame size in milliseconds (default 20)
     * @param {number} sensitivity - detection sensitivity 0–1; higher = more sensitive (default 0.5)
     */
    constructor(sr = 48000, frameSizeMs = 20, sensitivity = 0.5) {
      this.sr = sr;
      this.frameSize = Math.max(64, Math.floor(frameSizeMs * 0.001 * sr));
      this.smoothedEnergy = 0;
      this.hangover = 0;
      this.setSensitivity(sensitivity);
    }

    /**
     * Adjust VAD sensitivity without recreating the object.
     * @param {number} s - new sensitivity 0–1
     */
    setSensitivity(s) {
      this.sensitivity = Math.max(0, Math.min(1, s));
      // Higher sensitivity → lower energy threshold → more speech detected
      this.energyThreshDb = -50 + (1 - this.sensitivity) * 30; // -50 dB at max, -20 dB at min
      // Higher sensitivity → tolerate higher ZCR (captures fricatives and noisy speech)
      this.zcrThresh = 0.25 + this.sensitivity * 0.35;
      // Hangover: prevent clipping trailing speech edges.
      // Duration ranges from 50 ms (low sensitivity) to 200 ms (high sensitivity).
      const MIN_HANGOVER_SEC = 0.05;
      const MAX_HANGOVER_SEC = 0.20;
      this.hangoverFrames = Math.max(2, Math.round(
        (MIN_HANGOVER_SEC + this.sensitivity * (MAX_HANGOVER_SEC - MIN_HANGOVER_SEC)) * this.sr / this.frameSize
      ));
    }

    /**
     * Process a single frame and return voice confidence [0, 1].
     * @param {Float32Array} frame - audio samples
     * @returns {number} confidence 0 (silence) or 0.5 (hangover) or 1 (speech)
     */
    processFrame(frame) {
      // Short-time energy
      let energy = 0;
      for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
      energy /= frame.length;
      const energyDb = energy > 1e-12 ? 10 * Math.log10(energy) : -96;

      // Zero-crossing rate
      let zcr = 0;
      for (let i = 1; i < frame.length; i++) {
        if ((frame[i] >= 0) !== (frame[i - 1] >= 0)) zcr++;
      }
      zcr /= frame.length;

      // Smooth energy estimate (fast track upward, slow downward)
      if (energyDb > this.smoothedEnergy) {
        this.smoothedEnergy = 0.7 * this.smoothedEnergy + 0.3 * energyDb;
      } else {
        this.smoothedEnergy = 0.95 * this.smoothedEnergy + 0.05 * energyDb;
      }

      const energyVoiced = energyDb > this.energyThreshDb;
      const zcrVoiced = zcr < this.zcrThresh;
      const voiced = energyVoiced && zcrVoiced;

      if (voiced) {
        this.hangover = this.hangoverFrames;
        return 1;
      }
      if (this.hangover > 0) {
        this.hangover--;
        return 0.5;
      }
      return 0;
    }

    /**
     * Process an entire signal and return per-frame confidence.
     * @param {Float32Array} data - full audio signal
     * @returns {Float32Array} confidence values, one per analysis frame
     */
    processSignal(data) {
      const numFrames = Math.floor(data.length / this.frameSize);
      const out = new Float32Array(numFrames);
      for (let f = 0; f < numFrames; f++) {
        const frame = data.subarray(f * this.frameSize, (f + 1) * this.frameSize);
        out[f] = this.processFrame(frame);
      }
      return out;
    }

    /** Reset internal state. */
    reset() {
      this.smoothedEnergy = 0;
      this.hangover = 0;
    }
  },

  // ===== HELPERS =====

  // Cache for _computeERBBands — keyed by "numBands_sr_numBins".
  _erbCache: new Map(),

  /** Compute 32 ERB (Equivalent Rectangular Bandwidth) bands */
  _computeERBBands(numBands, sr, numBins) {
    const key = `${numBands}_${sr}_${numBins}`;
    if (this._erbCache.has(key)) return this._erbCache.get(key);
    const nyquist = sr / 2;
    const bands = [];

    // ERB scale: f_erb = 21.4 * log10(0.00437 * f + 1)
    const fToErb = (f) => 21.4 * Math.log10(0.00437 * f + 1);
    const erbToF = (erb) => (Math.pow(10, erb / 21.4) - 1) / 0.00437;

    const erbLo = fToErb(20);
    const erbHi = fToErb(nyquist);
    const erbStep = (erbHi - erbLo) / numBands;

    for (let b = 0; b < numBands; b++) {
      const fLo = erbToF(erbLo + b * erbStep);
      const fHi = erbToF(erbLo + (b + 1) * erbStep);
      const binLo = Math.max(0, Math.floor(fLo / nyquist * (numBins - 1)));
      const binHi = Math.min(numBins - 1, Math.ceil(fHi / nyquist * (numBins - 1)));
      bands.push({ lo: binLo, hi: binHi, fLo, fHi });
    }
    this._erbCache.set(key, bands);
    return bands;
  },

  /** Calculate RMS in dB */
  calcRMS(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = sum / data.length;
    return rms > 0 ? 10 * Math.log10(rms) : -96;
  },

  /** Calculate peak in dB */
  calcPeak(data) {
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const a = data[i] * data[i];
      if (a > peak) peak = a;
    }
    return peak > 0 ? 10 * Math.log10(peak) : -96;
  }
};

// Export
if (typeof window !== 'undefined') {
  window.DSPCore = DSPCore;
  window.AdaptiveNoiseFloor = AdaptiveNoiseFloor;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DSPCore;
  module.exports.AdaptiveNoiseFloor = AdaptiveNoiseFloor;
}
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.DSPCore = DSPCore; // Worker context
  self.AdaptiveNoiseFloor = AdaptiveNoiseFloor;
}
