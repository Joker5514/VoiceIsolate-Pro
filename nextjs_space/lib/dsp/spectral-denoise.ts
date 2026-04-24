// Spectral subtraction noise reduction.
// Classic STFT-based noise floor estimation (minimum statistics) followed by
// over-subtraction and a spectral floor. Uses a Hann window + 50% overlap.
// All logic is CPU-only (no WebAssembly) and runs in the main thread with yields.

export type DenoiseProgress = (percent: number) => void;

const FFT_SIZE = 2048;
const HOP = FFT_SIZE / 2; // 50% overlap

/** Simple radix-2 FFT (iterative, in-place) for Float64 real/imag arrays. */
function fft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  // Bit-reverse
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let tmp = real[i];
      real[i] = real[j];
      real[j] = tmp;
      tmp = imag[i];
      imag[i] = imag[j];
      imag[j] = tmp;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = -2 * Math.PI / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = step * k;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const reT = cos * real[i + k + half] - sin * imag[i + k + half];
        const imT = sin * real[i + k + half] + cos * imag[i + k + half];
        real[i + k + half] = real[i + k] - reT;
        imag[i + k + half] = imag[i + k] - imT;
        real[i + k] += reT;
        imag[i + k] += imT;
      }
    }
  }
}

/** Inverse FFT by conjugate trick. */
function ifft(real: Float64Array, imag: Float64Array): void {
  const n = real.length;
  for (let i = 0; i < n; i++) imag[i] = -imag[i];
  fft(real, imag);
  const inv = 1 / n;
  for (let i = 0; i < n; i++) {
    real[i] *= inv;
    imag[i] = -imag[i] * inv;
  }
}

/** Pre-compute Hann window */
function makeHann(len: number): Float64Array {
  const w = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
  }
  return w;
}

/**
 * Denoise a single channel using spectral subtraction.
 * @param input  Float32Array mono samples
 * @param strength 0..1 — higher = more aggressive subtraction
 */
async function denoiseChannel(
  input: Float32Array,
  strength: number,
  onProgress?: DenoiseProgress
): Promise<Float32Array> {
  const len = input.length;
  const nFrames = Math.ceil(len / HOP);
  const output = new Float32Array(len + FFT_SIZE);
  const hann = makeHann(FFT_SIZE);

  // First pass — profile the noise floor using minimum statistics on first ~20 frames
  // and the running minimum across the whole signal (robust against sparse speech).
  const halfBins = FFT_SIZE / 2 + 1;
  const noiseProfile = new Float64Array(halfBins);
  for (let i = 0; i < halfBins; i++) noiseProfile[i] = Infinity;

  const profileFrames = Math.min(nFrames, 40);
  // We also scan the whole signal to track minimums per bin.
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);

  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = start + i;
      re[i] = (idx < len ? (input[idx] ?? 0) : 0) * hann[i];
    }
    fft(re, im);
    for (let k = 0; k < halfBins; k++) {
      const mag2 = re[k] * re[k] + im[k] * im[k];
      if (mag2 < noiseProfile[k]) noiseProfile[k] = mag2;
    }
    // Early profile weighting — use lowest from the first 40 frames
    if (f === profileFrames - 1) {
      // Don't reset; continue tracking minimums
    }
    // Yield occasionally so UI stays responsive
    if (f % 200 === 199) {
      onProgress?.((f / nFrames) * 0.3);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  for (let k = 0; k < halfBins; k++) {
    if (!isFinite(noiseProfile[k])) noiseProfile[k] = 1e-12;
  }

  // Over-subtraction factor (alpha) and spectral floor (beta) controlled by strength
  const alpha = 1.5 + strength * 4.5; // 1.5 - 6.0
  const beta = Math.max(0.02, 0.15 * (1 - strength * 0.9)); // 0.015 - 0.15

  // Second pass — subtract and inverse FFT with overlap-add
  for (let f = 0; f < nFrames; f++) {
    const start = f * HOP;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < FFT_SIZE; i++) {
      const idx = start + i;
      re[i] = (idx < len ? (input[idx] ?? 0) : 0) * hann[i];
    }
    fft(re, im);

    for (let k = 0; k < halfBins; k++) {
      const reK = re[k];
      const imK = im[k];
      const mag2 = reK * reK + imK * imK;
      const noise2 = noiseProfile[k];
      let gain = 1 - (alpha * noise2) / (mag2 + 1e-20);
      if (gain < beta) gain = beta;
      if (gain > 1) gain = 1;
      re[k] = reK * gain;
      im[k] = imK * gain;
      // Symmetric bin (conjugate)
      if (k > 0 && k < halfBins - 1) {
        const sym = FFT_SIZE - k;
        re[sym] = re[k];
        im[sym] = -im[k];
      }
    }

    ifft(re, im);

    // Overlap-add with Hann synthesis window
    for (let i = 0; i < FFT_SIZE; i++) {
      output[start + i] += re[i] * hann[i];
    }

    if (f % 200 === 199) {
      onProgress?.(0.3 + (f / nFrames) * 0.7);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // Normalize by sum of squared window (constant-Q for 50% overlap of Hann ≈ 0.5)
  // Strictly: sum hann^2 at hop 50% ≈ N * 3/8. For each sample we applied hann twice.
  // Scale to preserve peak roughly.
  const result = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    result[i] = output[i] * (4 / 3); // compensate for Hann^2 sum (0.75 average at 50% overlap)
  }
  return result;
}

/** Denoise an entire AudioBuffer */
export async function spectralDenoise(
  buf: AudioBuffer,
  strength: number,
  onProgress?: DenoiseProgress
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(buf.numberOfChannels, buf.length, buf.sampleRate);
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);

  for (let c = 0; c < buf.numberOfChannels; c++) {
    const input = buf.getChannelData(c);
    const denoised = await denoiseChannel(input, strength, (p) => {
      const channelFraction = (c + p) / buf.numberOfChannels;
      onProgress?.(channelFraction);
    });
    out.getChannelData(c).set(denoised);
  }
  return out;
}
