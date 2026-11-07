/**
 * fft-bridge.js — VoiceIsolate Pro · Threads from Space v8
 * ==========================================================
 * Offline STFT / iSTFT utility for Creator and Forensic processing modes.
 *
 * AUDIT-FIX #15 (2026-05-26): makeHannWindow() now uses the PERIODIC form
 * (denominator N, not N-1). The symmetric form (N-1) breaks the Constant
 * Overlap-Add (COLA) identity at 75% overlap and causes amplitude ripple
 * between frames. The canonical dsp-processor.js worklet already uses the
 * periodic form — this fix makes fft-bridge consistent.
 *
 * Before fix:  w[i] = 0.5 * (1 - cos(2πi / (N-1)))  ← symmetric, breaks COLA
 * After fix:   w[i] = 0.5 * (1 - cos(2πi / N))       ← periodic, preserves COLA
 *
 * Reuses the IDENTICAL Cooley-Tukey FFT kernel from dsp-processor.js to
 * guarantee bit-for-bit consistent spectral representation between Live and
 * Creator/Forensic paths. Single-pass architecture is preserved:
 *
 *   computeSTFT()      → 1× Forward STFT  (magnitude + phase arrays)
 *   reconstructISTFT() → 1× Inverse STFT  (overlap-add → PCM Float32Array)
 *
 * Intended usage (import from any offline processing module):
 *
 *   import { computeSTFT, reconstructISTFT, makeHannWindow } from './fft-bridge.js';
 *
 *   const { magnitudes, phases, times } = computeSTFT(pcmFloat32, 4096, 1024, 44100);
 *   // ... apply ML masks to magnitudes[] here ...
 *   const processedPcm = reconstructISTFT(magnitudes, phases, 4096, 1024);
 *
 * Constraint: Only ONE Forward STFT and ONE iSTFT per processing chain.
 * Never call computeSTFT() twice on the same buffer or chain.
 *
 * Note: reconstructISTFT uses per-sample OLA normalisation, so any hopSize
 * producing complete frame coverage is supported.
 */

// ─── Cooley-Tukey FFT (identical to dsp-processor.js) ────────────────────────
/**
 * In-place Radix-2 Decimation-In-Time Cooley-Tukey FFT.
 * Operates on split re/im Float32Arrays of length N (must be power-of-two).
 * @param {Float32Array} re - Real part (modified in place)
 * @param {Float32Array} im - Imaginary part (modified in place)
 * @param {boolean} inverse - true = IFFT, false = FFT
 */
export function fftInPlace(re, im, inverse = false) {
  const N = re.length;
  // Bit-reversal permutation
  let j = 0;
  for (let i = 1; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Butterfly passes
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const ang  = (inverse ? 2 : -2) * Math.PI / len;
    const wRe  = Math.cos(ang);
    const wIm  = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let cRe = 1, cIm = 0;
      for (let k = 0; k < half; k++) {
        const uRe = re[i+k];
        const uIm = im[i+k];
        const vRe = re[i+k+half] * cRe - im[i+k+half] * cIm;
        const vIm = re[i+k+half] * cIm + im[i+k+half] * cRe;
        re[i+k]       = uRe + vRe;  im[i+k]       = uIm + vIm;
        re[i+k+half]  = uRe - vRe;  im[i+k+half]  = uIm - vIm;
        const nr = cRe * wRe - cIm * wIm;
        cIm      = cRe * wIm + cIm * wRe;
        cRe      = nr;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  }
}

/**
 * AUDIT-FIX #15: Generate a PERIODIC Hann window of length N.
 * Periodic form (denominator N) is required for COLA at 75% overlap.
 * Symmetric form (denominator N-1) was incorrect and caused amplitude ripple.
 * @param {number} N
 * @returns {Float32Array}
 */
export function makeHannWindow(N) {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // PERIODIC form: denominator is N (not N-1)
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / N));
  }
  return w;
}

/**
 * Compute the Short-Time Fourier Transform of a mono PCM buffer.
 * Returns one magnitude frame and one phase frame per hop.
 *
 * ⚠ SINGLE-PASS CONTRACT: Call this function exactly ONCE per processing chain.
 *
 * @param {Float32Array} pcm        - Mono PCM samples (any length >= 1)
 * @param {number}       fftSize    - FFT window size (power-of-two; default 4096)
 * @param {number}       hopSize    - Hop between windows (default 1024 = 75% overlap)
 * @param {number}       sampleRate - Sample rate for populating times[] (default 44100)
 * @returns {{
 *   magnitudes: Float32Array[],  // one Float32Array(halfBins) per frame
 *   phases:     Float32Array[],  // one Float32Array(halfBins) per frame
 *   times:      number[],        // center time of each frame in seconds
 *   fftSize:    number,
 *   hopSize:    number,
 *   halfBins:   number,
 *   sampleRate: number
 * }}
 */
export function computeSTFT(pcm, fftSize = 4096, hopSize = 1024, sampleRate = 44100) {
  if (!(pcm instanceof Float32Array)) {
    throw new TypeError('fft-bridge: pcm must be a Float32Array');
  }
  if ((fftSize & (fftSize - 1)) !== 0) {
    throw new RangeError('fft-bridge: fftSize must be a power of two');
  }
  if (!Number.isInteger(hopSize) || hopSize <= 0 || hopSize > fftSize) {
    throw new RangeError('fft-bridge: hopSize must be an integer in [1, fftSize]');
  }

  const halfBins = (fftSize >> 1) + 1;
  const win      = makeHannWindow(fftSize); // AUDIT-FIX #15: now periodic
  const re       = new Float32Array(fftSize);
  const im       = new Float32Array(fftSize);

  const magnitudes = [];
  const phases     = [];
  const times      = [];

  // Synthesis frames match stft-math paddedFrameCount: reflect by N−hop on
  // both sides so the inverse covers sample 0 and the last sample. Empty
  // input keeps one silent frame. hop === fftSize stays one window per hop
  // (analysis-only; a periodic Hann cannot rebuild those boundaries).
  const pad = (pcm.length > 0 && hopSize < fftSize) ? (fftSize - hopSize) : 0;
  const numFrames = pcm.length === 0
    ? 1
    : (pad > 0
      ? Math.floor((pcm.length - 1 + pad) / hopSize) + 1
      : (pcm.length >= fftSize ? Math.floor((pcm.length - fftSize) / hopSize) + 1 : 1));

  for (let frame = 0; frame < numFrames; frame++) {
    const pos = frame * hopSize - pad;
    for (let i = 0; i < fftSize; i++) {
      re[i] = _reflectSample(pcm, pos + i) * win[i];
      im[i] = 0;
    }

    // ── SINGLE FORWARD STFT ──────────────────────────────────────────────────
    fftInPlace(re, im, false);

    const mag = new Float32Array(halfBins);
    const pha = new Float32Array(halfBins);
    for (let k = 0; k < halfBins; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      pha[k] = Math.atan2(im[k], re[k]);
    }

    magnitudes.push(mag);
    phases.push(pha);
    times.push((pos + fftSize / 2) / sampleRate);
  }

  magnitudes.inputLength = pcm.length;
  magnitudes.pad = pad;
  return { magnitudes, phases, times, fftSize, hopSize, halfBins, sampleRate, inputLength: pcm.length, pad };
}

/** Odd reflection. Same formula as src/core/stft-math.js paddedSample. */
function _reflectSample(x, idx) {
  const len = x.length;
  if (idx >= 0 && idx < len) return x[idx];
  if (len <= 1) return len ? x[0] : 0;
  const period = 2 * (len - 1);
  let m = idx % period;
  if (m < 0) m += period;
  const mirrored = x[m < len ? m : period - m];
  return 2 * x[idx < 0 ? 0 : len - 1] - mirrored;
}

/**
 * Reconstruct PCM from magnitude and phase frames via overlap-add iSTFT.
 * Applies the same Hann window as the analysis stage to satisfy COLA.
 *
 * ⚠ SINGLE-PASS CONTRACT: Call this function exactly ONCE per processing chain.
 *
 * @param {Float32Array[]} magnitudes - Modified magnitude frames from computeSTFT()
 * @param {Float32Array[]} phases     - Phase frames from computeSTFT() (unmodified)
 * @param {number}         fftSize    - Must match the value used in computeSTFT()
 * @param {number}         hopSize    - Must match the value used in computeSTFT()
 * @returns {Float32Array} Reconstructed mono PCM
 */
export function reconstructISTFT(magnitudes, phases, fftSize = 4096, hopSize = 1024) {
  if (!magnitudes.length) return new Float32Array(0);

  const halfBins   = (fftSize >> 1) + 1;
  const numFrames  = magnitudes.length;
  const pad        = Number.isFinite(magnitudes.pad)
    ? magnitudes.pad
    : (hopSize < fftSize ? fftSize - hopSize : 0);
  const outputLen  = Number.isFinite(magnitudes.inputLength) && magnitudes.inputLength >= 0
    ? magnitudes.inputLength
    : Math.max(0, (numFrames - 1) * hopSize + fftSize - pad);
  const output     = new Float32Array(outputLen);
  const norm       = new Float32Array(outputLen);
  const win        = makeHannWindow(fftSize); // AUDIT-FIX #15: now periodic
  const re         = new Float32Array(fftSize);
  const im         = new Float32Array(fftSize);

  for (let f = 0; f < numFrames; f++) {
    const mag = magnitudes[f];
    const pha = phases[f];

    for (let k = 0; k < halfBins; k++) {
      re[k] = mag[k] * Math.cos(pha[k]);
      im[k] = mag[k] * Math.sin(pha[k]);
    }
    for (let k = halfBins; k < fftSize; k++) {
      const mirrorK = fftSize - k;
      re[k] =  re[mirrorK];
      im[k] = -im[mirrorK];
    }

    // ── SINGLE INVERSE STFT ──────────────────────────────────────────────────
    fftInPlace(re, im, true);

    const frameStart = f * hopSize - pad;
    const i0 = frameStart < 0 ? -frameStart : 0;
    const i1 = Math.min(fftSize, outputLen - frameStart);
    for (let i = i0; i < i1; i++) {
      const w = win[i];
      output[frameStart + i] += re[i] * w;
      norm[frameStart + i] += w * w;
    }
  }

  // The pad puts every sample at its steady-state window² sum. Divide by
  // that sum; a half-peak floor would push the file edges toward 0.
  for (let i = 0; i < outputLen; i++) {
    output[i] /= Math.max(norm[i], 1e-12);
  }

  return output;
}

/**
 * Convenience: encode a mono Float32Array to a WAV ArrayBuffer.
 * @param {Float32Array} pcm        - Mono PCM samples normalised to [-1, 1]
 * @param {number}       sampleRate - Output sample rate (default 44100)
 * @returns {ArrayBuffer}
 */
export function encodeWAV(pcm, sampleRate = 44100) {
  const api = typeof globalThis !== 'undefined' ? globalThis.VIPWavEncoder : null;
  if (!api) throw new Error('[VIP] WAV encoder module was not loaded');
  return api.encodeWavArrayBuffer([pcm], sampleRate, { bitDepth: 16, ditherAmt: 0 }).buffer;
}
