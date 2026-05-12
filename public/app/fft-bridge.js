/**
 * fft-bridge.js — VoiceIsolate Pro · Threads from Space v8
 * ==========================================================
 * Offline STFT / iSTFT utility for Creator and Forensic processing modes.
 *
 * Reuses the IDENTICAL Cooley-Tukey FFT kernel from dsp-processor.js to
 * guarantee bit-for-bit consistent spectral representation between Live and
 * Creator/Forensic paths. Single-pass architecture is preserved:
 *
 *   computeSTFT()      → 1× Forward STFT  (magnitude + phase arrays)
 *   reconstructISTFT() → 1× Inverse STFT  (overlap-add → PCM Float32Array)
 *
 * Intended usage (import from any offline processing module):
 *   computeSTFT()   → 1× Forward STFT  (magnitude + phase arrays)
 *   reconstructISTFT() → 1× Inverse STFT (overlap-add → PCM Float32Array)
 *
 * Usage:
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
 * COLA requirement: reconstructISTFT requires hopSize = fftSize / 4 (75% overlap)
 * to ensure correct Hann window Constant Overlap-Add normalisation.
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
 * Generate a periodic Hann window of length N.
 * Identical to dsp-processor.js makeHannWindow().
 * @param {number} N
 * @returns {Float32Array}
 */
export function makeHannWindow(N) {
  const w = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
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
 * @returns {{\
 * @param {Float32Array} pcm        - Mono PCM samples (any length)
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
  const win      = makeHannWindow(fftSize);
  const re       = new Float32Array(fftSize);
  const im       = new Float32Array(fftSize);

  const magnitudes = [];
  const phases     = [];
  const times      = [];

  // Iterate over all frames starting positions within the signal.
  // Zero-padding handles the tail so at least one frame is produced.
  for (let pos = 0; pos < pcm.length; pos += hopSize) {
  // Zero-pad so we always emit at least one frame (even for empty/short clips)
  const totalSamples = Math.max(1, pcm.length) + fftSize - hopSize;
  const numFrames = Math.max(1, Math.ceil(totalSamples / hopSize));

  for (let frame = 0; frame < numFrames; frame++) {
    const pos = frame * hopSize;
    // Fill windowed frame (zero-pad beyond signal end)
    for (let i = 0; i < fftSize; i++) {
      const srcIdx = pos + i;
      re[i] = srcIdx < pcm.length ? pcm[srcIdx] * win[i] : 0;
      im[i] = 0;
    }

    // ── SINGLE FORWARD STFT ──────────────────────────────────────────────────
    fftInPlace(re, im, false);

    // Extract magnitude and phase for positive frequencies only
    const mag = new Float32Array(halfBins);
    const pha = new Float32Array(halfBins);
    for (let k = 0; k < halfBins; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      pha[k] = Math.atan2(im[k], re[k]);
    }

    magnitudes.push(mag);
    phases.push(pha);
    times.push((pos + fftSize / 2) / sampleRate); // center of window
  }

  return { magnitudes, phases, times, fftSize, hopSize, halfBins, sampleRate };
}

/**
 * Reconstruct PCM from magnitude and phase frames via overlap-add iSTFT.
 * Applies the same Hann window as the analysis stage to satisfy COLA
 * (Constant Overlap-Add) reconstruction.
 *
 * ⚠ SINGLE-PASS CONTRACT: Call this function exactly ONCE per processing chain.
 * ⚠ COLA CONTRACT: hopSize must equal fftSize / 4 (75% overlap) for correct
 *   Hann window COLA normalisation.
 *
 * @param {Float32Array[]} magnitudes - Modified magnitude frames from computeSTFT()
 * @param {Float32Array[]} phases     - Phase frames from computeSTFT() (unmodified)
 * @param {number}         fftSize    - Must match the value used in computeSTFT()
 * @param {number}         hopSize    - Must match the value used in computeSTFT()
 * @returns {Float32Array} Reconstructed mono PCM
 */
export function reconstructISTFT(magnitudes, phases, fftSize = 4096, hopSize = 1024) {
  if (!magnitudes.length) return new Float32Array(0);
  if (hopSize !== (fftSize >> 2)) {
    throw new RangeError(
      'fft-bridge: reconstructISTFT requires hopSize = fftSize/4 for Hann COLA normalisation'
    );
  }

  const halfBins   = (fftSize >> 1) + 1;
  const numFrames  = magnitudes.length;
  const outputLen  = (numFrames - 1) * hopSize + fftSize;
  const output     = new Float32Array(outputLen);
  const norm       = new Float32Array(outputLen);
  const win        = makeHannWindow(fftSize);
  const re         = new Float32Array(fftSize);
  const im         = new Float32Array(fftSize);

  for (let f = 0; f < numFrames; f++) {
    const mag = magnitudes[f];
    const pha = phases[f];

    // Rebuild full-spectrum from magnitude + phase
    for (let k = 0; k < halfBins; k++) {
      re[k] = mag[k] * Math.cos(pha[k]);
      im[k] = mag[k] * Math.sin(pha[k]);
    }
    // Conjugate symmetry for k = N/2+1 .. N-1
    for (let k = halfBins; k < fftSize; k++) {
      const mirrorK = fftSize - k;
      re[k] =  re[mirrorK];
      im[k] = -im[mirrorK];
    }

    // ── SINGLE INVERSE STFT ──────────────────────────────────────────────────
    fftInPlace(re, im, true);

    // Overlap-add with synthesis window
    const frameStart = f * hopSize;
    for (let i = 0; i < fftSize; i++) {
      output[frameStart + i] += re[i] * win[i];
    }
  }

  // COLA normalisation factor for Hann + 75% overlap (hopSize = fftSize/4)
  const overlap = fftSize / hopSize;
  const colaNorm = overlap / 2;
  for (let i = 0; i < outputLen; i++) output[i] /= colaNorm;
      const idx = frameStart + i;
      const w = win[i];
      output[idx] += re[i] * w;
      norm[idx] += w * w;
    }
  }

  // Per-sample OLA normalisation (matches offline processor behavior)
  for (let i = 0; i < outputLen; i++) {
    if (norm[i] > 1e-12) output[i] /= norm[i];
  }

  return output;
}

/**
 * Convenience: encode a mono Float32Array to a WAV ArrayBuffer
 * with a standard 44-byte RIFF/PCM header (16-bit, little-endian).
 * Used by offline-processor.js for the WAV export button.
 *
 * @param {Float32Array} pcm        - Mono PCM samples normalised to [-1, 1]
 * @param {number}       sampleRate - Output sample rate (default 44100)
 * @returns {ArrayBuffer}
 */
export function encodeWAV(pcm, sampleRate = 44100) {
  const numSamples = pcm.length;
  const byteRate   = sampleRate * 2;    // 16-bit mono
  const blockAlign = 2;
  const dataBytes  = numSamples * 2;
  const buf        = new ArrayBuffer(44 + dataBytes);
  const view       = new DataView(buf);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  writeStr(0, 'RIFF');
  view.setUint32(4,  36 + dataBytes,       true); // ChunkSize
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16,          true);  // Subchunk1Size (PCM)
  view.setUint16(20, 1,           true);  // AudioFormat = PCM
  view.setUint16(22, 1,           true);  // NumChannels = 1
  view.setUint32(24, sampleRate,  true);
  view.setUint32(28, byteRate,    true);
  view.setUint16(32, blockAlign,  true);
  view.setUint16(34, 16,          true);  // BitsPerSample
  writeStr(36, 'data');
  view.setUint32(40, dataBytes,   true);

  // Convert Float32 → Int16 with clipping
  const int16Offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(int16Offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return buf;
}
