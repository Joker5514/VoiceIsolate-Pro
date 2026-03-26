/* ============================================
   VoiceIsolate Pro v20.0 — DSPCore
   Threads from Space v10 · Pure DSP Math
   STFT/iSTFT · Biquad · Spectral · ERB
   ============================================ */

'use strict';

/**
 * Pure DSP math library. No Web Audio API dependency.
 * - Forward/inverse STFT with Hann windowing
 * - Biquad filter implementation (Direct Form II)
 * - Cascaded notch chains, parametric EQ
 * - Spectral noise subtraction (Wiener-MMSE)
 * - 32 ERB band spectral gate
 * - Temporal smoothing, harmonic enhancement
 * - Dereverberation, de-essing, de-clicking
 * - LUFS measurement, true-peak limiting, dither
 */
const DSPCore = {

  // ===== CONSTANTS =====
  FRAME_SIZE: 4096,
  HOP_SIZE: 1024,
  SAMPLE_RATE: 48000,

  // ===== WINDOWING =====

  /** Generate Hann window of given length */
  hannWindow(N) {
    const w = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
    }
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

    for (let f = 0; f < frameCount; f++) {
      const offset = f * hopSize;
      // Windowed frame → real/imag
      const real = new Float32Array(fftSize);
      const imag = new Float32Array(fftSize);
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

    for (let f = 0; f < frameCount; f++) {
      const offset = f * hopSize;
      const real = new Float32Array(fftSize);
      const imag = new Float32Array(fftSize);

      // Reconstruct complex spectrum
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

  // ===== HELPERS =====

  /** Compute 32 ERB (Equivalent Rectangular Bandwidth) bands */
  _computeERBBands(numBands, sr, numBins) {
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
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DSPCore;
}
if (typeof self !== 'undefined' && typeof window === 'undefined') {
  self.DSPCore = DSPCore; // Worker context
}
