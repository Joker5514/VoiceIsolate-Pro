/**
 * VoiceIsolate Pro v9.0 — DSP Worker
 * "Threads from Space" Concurrency Architecture
 *
 * Standalone Web Worker that executes the full 18-stage DSP pipeline
 * on audio data. Every algorithm is implemented inline with no imports.
 *
 * Message protocol (inbound):
 *   { type: 'process', id, data: Float32Array, config: {...}, stages: [...] }
 *
 * Response protocol (outbound):
 *   { type: 'progress', id, stage, stageName, stageCount, percent }
 *   { type: 'complete', id, data: Float32Array }
 *   { type: 'error',    id, code, message }
 */

'use strict';

/* ================================================================
 * Constants
 * ================================================================ */
const TWO_PI   = 2.0 * Math.PI;
const EPSILON  = 1e-10;
const LOG10_20 = 20.0 / Math.LN10;

/* ================================================================
 * Stage Definitions
 * ================================================================ */
const STAGE_NAMES = [
  /* 0  */ 'Input Validation & Preparation',
  /* 1  */ 'Peak Normalization',
  /* 2  */ 'High-Pass Filter',
  /* 3  */ 'Noise Profiling',
  /* 4  */ 'FFT Analysis',
  /* 5  */ 'Spectral Subtraction',
  /* 6  */ 'Noise Gate',
  /* 7  */ 'Hum Removal (50/60Hz)',
  /* 8  */ 'Wiener Filter',
  /* 9  */ 'Dereverberation',
  /* 10 */ 'Harmonic Reconstruction',
  /* 11 */ 'Formant Enhancement',
  /* 12 */ 'Voice Presence Enhancement',
  /* 13 */ 'De-esser',
  /* 14 */ 'Dynamic Range Compression',
  /* 15 */ 'EQ Shaping',
  /* 16 */ 'LUFS Normalization',
  /* 17 */ 'True Peak Limiter'
];

const TOTAL_STAGES = STAGE_NAMES.length;

/* ================================================================
 * Utility Functions
 * ================================================================ */

function clamp(val, lo, hi) {
  return val < lo ? lo : (val > hi ? hi : val);
}

function dbToLinear(db) {
  return Math.pow(10.0, db / 20.0);
}

function linearToDb(lin) {
  return 20.0 * Math.log10(Math.max(lin, EPSILON));
}

/**
 * Compute RMS of a Float32Array section
 */
function rms(buffer, start, length) {
  let sum = 0.0;
  const end = Math.min(start + length, buffer.length);
  for (let i = start; i < end; i++) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / (end - start));
}

/**
 * Find peak absolute value
 */
function peakAbs(buffer) {
  let peak = 0.0;
  for (let i = 0; i < buffer.length; i++) {
    const a = Math.abs(buffer[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Copy Float32Array
 */
function copyFloat32(src) {
  const dst = new Float32Array(src.length);
  dst.set(src);
  return dst;
}

/* ================================================================
 * FFT Implementation (Cooley-Tukey Radix-2 DIT)
 * ================================================================ */

/**
 * In-place FFT. real and imag are same-length arrays, length must be power of 2.
 * @param {Float32Array} real
 * @param {Float32Array} imag
 * @param {boolean} inverse - true for IFFT
 */
function fft(real, imag, inverse) {
  const n = real.length;
  if (n === 0) return;

  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (i < j) {
      const tr = real[i]; real[i] = real[j]; real[j] = tr;
      const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
    let m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  // Butterfly stages
  const sign = inverse ? 1.0 : -1.0;
  for (let size = 2; size <= n; size *= 2) {
    const halfSize = size >> 1;
    const angle = sign * TWO_PI / size;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let curReal = 1.0;
      let curImag = 0.0;
      for (let k = 0; k < halfSize; k++) {
        const evenIdx = start + k;
        const oddIdx  = start + k + halfSize;
        const tReal = curReal * real[oddIdx] - curImag * imag[oddIdx];
        const tImag = curReal * imag[oddIdx] + curImag * real[oddIdx];
        real[oddIdx] = real[evenIdx] - tReal;
        imag[oddIdx] = imag[evenIdx] - tImag;
        real[evenIdx] += tReal;
        imag[evenIdx] += tImag;
        const newCurReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = newCurReal;
      }
    }
  }

  // Scale for inverse
  if (inverse) {
    for (let i2 = 0; i2 < n; i2++) {
      real[i2] /= n;
      imag[i2] /= n;
    }
  }
}

/**
 * Next power of 2 >= n
 */
function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Hann window
 */
function hannWindow(size) {
  const win = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 * (1.0 - Math.cos(TWO_PI * i / (size - 1)));
  }
  return win;
}

/* ================================================================
 * STFT / ISTFT helpers
 * ================================================================ */

// Global buffer cache for STFT/iSTFT optimization
const bufferCache = {
  stftReal: null,
  stftImag: null,
  istftReal: null,
  istftImag: null,
  istftOutput: null,
  istftWinSum: null,
  lastFramesCount: 0,
  lastOutputLength: 0
};

/**
 * Short-Time Fourier Transform.
 * Returns array of frames, each frame is { real: Float32Array, imag: Float32Array }.
 */
function stft(buffer, fftSize, hopSize) {
  const win = hannWindow(fftSize);
  const numFrames = Math.floor((buffer.length - fftSize) / hopSize) + 1;
  const totalElements = numFrames * fftSize;

  // Lazily initialize or resize buffer >20%
  if (!bufferCache.stftReal || Math.abs(totalElements - bufferCache.stftReal.length) / (bufferCache.stftReal.length || 1) > 0.2 || bufferCache.stftReal.length < totalElements) {
    bufferCache.stftReal = new Float32Array(totalElements);
    bufferCache.stftImag = new Float32Array(totalElements);
    bufferCache.lastFramesCount = numFrames;
  } else {
    // Clear the portion we will use
    bufferCache.stftReal.fill(0, 0, totalElements);
    bufferCache.stftImag.fill(0, 0, totalElements);
  }

  const frames = [];
  const realMega = bufferCache.stftReal;
  const imagMega = bufferCache.stftImag;

  let f = 0;
  for (let pos = 0; pos + fftSize <= buffer.length; pos += hopSize) {
    const offset = f * fftSize;
    // Subarray references exactly the portion needed
    const real = realMega.subarray(offset, offset + fftSize);
    const imag = imagMega.subarray(offset, offset + fftSize);

    for (let i = 0; i < fftSize; i++) {
      real[i] = buffer[pos + i] * win[i];
    }
    fft(real, imag, false);
    frames.push({ real, imag, pos });
    f++;
  }
  return frames;
}

/**
 * Inverse STFT via overlap-add.
 */
function istft(frames, fftSize, hopSize, outputLength) {
  const win = hannWindow(fftSize);

  // Resize istft buffers if needed
  if (!bufferCache.istftOutput || Math.abs(outputLength - bufferCache.istftOutput.length) / (bufferCache.istftOutput.length || 1) > 0.2 || bufferCache.istftOutput.length < outputLength) {
    bufferCache.istftOutput = new Float32Array(outputLength);
    bufferCache.istftWinSum = new Float32Array(outputLength);
    bufferCache.lastOutputLength = outputLength;
  } else {
    bufferCache.istftOutput.fill(0, 0, outputLength);
    bufferCache.istftWinSum.fill(0, 0, outputLength);
  }

  // Temporary buffers for IFFT so we don't mutate the cached stft buffers
  if (!bufferCache.istftReal || bufferCache.istftReal.length < fftSize) {
    bufferCache.istftReal = new Float32Array(fftSize);
    bufferCache.istftImag = new Float32Array(fftSize);
  }

  const output = bufferCache.istftOutput.subarray(0, outputLength);
  const winSum = bufferCache.istftWinSum.subarray(0, outputLength);
  const tempReal = bufferCache.istftReal;
  const tempImag = bufferCache.istftImag;

  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f];
    // Copy into temp arrays for in-place IFFT mutation safety
    tempReal.set(frame.real);
    tempImag.set(frame.imag);

    fft(tempReal, tempImag, true);  // IFFT

    const pos = frame.pos;
    for (let i = 0; i < fftSize && (pos + i) < outputLength; i++) {
      output[pos + i] += tempReal[i] * win[i];
      winSum[pos + i] += win[i] * win[i];
    }
  }

  // Normalize by window sum
  // We MUST copy output into a NEW array to return, because returning the
  // subarray would give the caller a reference to our cached array that might be overwritten
  // on the next call to istft.
  const finalOutput = new Float32Array(outputLength);
  for (let j = 0; j < outputLength; j++) {
    if (winSum[j] > EPSILON) {
      finalOutput[j] = output[j] / winSum[j];
    } else {
      finalOutput[j] = output[j];
    }
  }

  return finalOutput;
}

/**
 * Compute magnitude spectrum from complex frame
 */
function magnitude(real, imag) {
  const mag = new Float32Array(real.length);
  for (let i = 0; i < real.length; i++) {
    mag[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
  }
  return mag;
}

/**
 * Compute phase from complex frame
 */
function phase(real, imag) {
  const ph = new Float32Array(real.length);
  for (let i = 0; i < real.length; i++) {
    ph[i] = Math.atan2(imag[i], real[i]);
  }
  return ph;
}

/**
 * Reconstruct complex from magnitude and phase
 */
function polarToComplex(mag, ph, outReal, outImag) {
  for (let i = 0; i < mag.length; i++) {
    outReal[i] = mag[i] * Math.cos(ph[i]);
    outImag[i] = mag[i] * Math.sin(ph[i]);
  }
}

/* ================================================================
 * IIR Biquad Filter Implementation
 * ================================================================ */

/**
 * Second-order IIR biquad filter (Direct Form I).
 * Applies in-place.
 */
function biquadFilter(buffer, b0, b1, b2, a1, a2) {
  let x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;
  for (let i = 0; i < buffer.length; i++) {
    const x0 = buffer[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
    buffer[i] = y0;
  }
}

/**
 * Compute biquad coefficients for high-pass filter.
 */
function highPassCoeffs(fc, sampleRate, Q) {
  const w0 = TWO_PI * fc / sampleRate;
  const alpha = Math.sin(w0) / (2.0 * Q);
  const cosw0 = Math.cos(w0);
  const a0 = 1.0 + alpha;
  return {
    b0: ((1.0 + cosw0) / 2.0) / a0,
    b1: (-(1.0 + cosw0)) / a0,
    b2: ((1.0 + cosw0) / 2.0) / a0,
    a1: (-2.0 * cosw0) / a0,
    a2: (1.0 - alpha) / a0
  };
}

/**
 * Compute biquad coefficients for notch (band-reject) filter.
 */
function notchCoeffs(fc, sampleRate, Q) {
  const w0 = TWO_PI * fc / sampleRate;
  const alpha = Math.sin(w0) / (2.0 * Q);
  const cosw0 = Math.cos(w0);
  const a0 = 1.0 + alpha;
  return {
    b0: 1.0 / a0,
    b1: (-2.0 * cosw0) / a0,
    b2: 1.0 / a0,
    a1: (-2.0 * cosw0) / a0,
    a2: (1.0 - alpha) / a0
  };
}

/**
 * Compute biquad coefficients for peaking EQ.
 */
function peakingEQCoeffs(fc, sampleRate, Q, gainDb) {
  const A = Math.pow(10.0, gainDb / 40.0);
  const w0 = TWO_PI * fc / sampleRate;
  const alpha = Math.sin(w0) / (2.0 * Q);
  const cosw0 = Math.cos(w0);
  const a0 = 1.0 + alpha / A;
  return {
    b0: (1.0 + alpha * A) / a0,
    b1: (-2.0 * cosw0) / a0,
    b2: (1.0 - alpha * A) / a0,
    a1: (-2.0 * cosw0) / a0,
    a2: (1.0 - alpha / A) / a0
  };
}

/**
 * Low-shelf biquad
 */
function lowShelfCoeffs(fc, sampleRate, gainDb) {
  const A = Math.pow(10.0, gainDb / 40.0);
  const w0 = TWO_PI * fc / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / 2.0 * Math.sqrt((A + 1.0 / A) * 2.0);
  const sqrtA2alpha = 2.0 * Math.sqrt(A) * alpha;

  const a0 = (A + 1.0) + (A - 1.0) * cosw0 + sqrtA2alpha;
  return {
    b0: (A * ((A + 1.0) - (A - 1.0) * cosw0 + sqrtA2alpha)) / a0,
    b1: (2.0 * A * ((A - 1.0) - (A + 1.0) * cosw0)) / a0,
    b2: (A * ((A + 1.0) - (A - 1.0) * cosw0 - sqrtA2alpha)) / a0,
    a1: (-2.0 * ((A - 1.0) + (A + 1.0) * cosw0)) / a0,
    a2: ((A + 1.0) + (A - 1.0) * cosw0 - sqrtA2alpha) / a0
  };
}

/**
 * High-shelf biquad
 */
function highShelfCoeffs(fc, sampleRate, gainDb) {
  const A = Math.pow(10.0, gainDb / 40.0);
  const w0 = TWO_PI * fc / sampleRate;
  const cosw0 = Math.cos(w0);
  const sinw0 = Math.sin(w0);
  const alpha = sinw0 / 2.0 * Math.sqrt((A + 1.0 / A) * 2.0);
  const sqrtA2alpha = 2.0 * Math.sqrt(A) * alpha;

  const a0 = (A + 1.0) - (A - 1.0) * cosw0 + sqrtA2alpha;
  return {
    b0: (A * ((A + 1.0) + (A - 1.0) * cosw0 + sqrtA2alpha)) / a0,
    b1: (-2.0 * A * ((A - 1.0) + (A + 1.0) * cosw0)) / a0,
    b2: (A * ((A + 1.0) + (A - 1.0) * cosw0 - sqrtA2alpha)) / a0,
    a1: (2.0 * ((A - 1.0) - (A + 1.0) * cosw0)) / a0,
    a2: ((A + 1.0) - (A - 1.0) * cosw0 - sqrtA2alpha) / a0
  };
}

/* ================================================================
 * Progress Reporting
 * ================================================================ */

let currentJobId = null;

function reportProgress(stage, percent) {
  self.postMessage({
    type:       'progress',
    id:         currentJobId,
    stage:      stage,
    stageName:  STAGE_NAMES[stage] || 'Unknown',
    stageCount: TOTAL_STAGES,
    percent:    Math.round(percent * 100) / 100
  });
}

function reportComplete(outputData) {
  const msg = {
    type: 'complete',
    id:   currentJobId,
    data: outputData
  };
  const transfer = [];
  if (outputData instanceof Float32Array &&
      !(outputData.buffer instanceof SharedArrayBuffer)) {
    transfer.push(outputData.buffer);
  }
  self.postMessage(msg, transfer);
}

function reportError(code, message) {
  self.postMessage({
    type:    'error',
    id:      currentJobId,
    code:    code,
    message: message
  });
}

/* ================================================================
 * Stage 0: Input Validation & Preparation
 * ================================================================ */

function stage0_validate(data, config) {
  reportProgress(0, 0);

  if (!data || data.length === 0) {
    throw new Error('Empty audio data');
  }

  // Ensure Float32Array
  let buffer;
  if (data instanceof Float32Array) {
    buffer = copyFloat32(data);
  } else {
    buffer = new Float32Array(data);
  }

  // Strip any DC offset
  let sum = 0.0;
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i];
  }
  const dcOffset = sum / buffer.length;
  if (Math.abs(dcOffset) > 0.001) {
    for (let j = 0; j < buffer.length; j++) {
      buffer[j] -= dcOffset;
    }
  }

  reportProgress(0, 100);
  return buffer;
}

/* ================================================================
 * Stage 1: Peak Normalization
 * ================================================================ */

function stage1_normalize(buffer, config) {
  reportProgress(1, 0);

  const targetPeak = config.normTarget || 0.95;
  const peak = peakAbs(buffer);

  if (peak > EPSILON && peak !== targetPeak) {
    const gain = targetPeak / peak;
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] *= gain;
    }
  }

  reportProgress(1, 100);
  return buffer;
}

/* ================================================================
 * Stage 2: High-Pass Filter
 * ================================================================ */

function stage2_highpass(buffer, config) {
  reportProgress(2, 0);

  const sampleRate = config.sampleRate || 44100;
  const hpfFreq    = config.hpfFreq || 80; // Hz
  const Q          = config.hpfQ || 0.707;

  const c = highPassCoeffs(hpfFreq, sampleRate, Q);
  biquadFilter(buffer, c.b0, c.b1, c.b2, c.a1, c.a2);

  // Apply second pass for steeper slope (4th order / 24 dB/oct)
  biquadFilter(buffer, c.b0, c.b1, c.b2, c.a1, c.a2);

  reportProgress(2, 100);
  return buffer;
}

/* ================================================================
 * Stage 3: Noise Profiling
 * ================================================================ */

function stage3_noiseProfile(buffer, config) {
  reportProgress(3, 0);

  const sampleRate = config.sampleRate || 44100;
  const fftSize    = config.fftSize || 2048;
  const hopSize    = fftSize >> 2; // 75% overlap

  // Find quietest segment for noise profile (analyze first 2s or full buffer)
  const profileLength = Math.min(buffer.length, Math.floor(sampleRate * 2));
  const blockSize     = Math.floor(sampleRate * 0.05); // 50ms blocks
  let minRmsVal     = Infinity;
  let minRmsStart   = 0;

  for (let pos = 0; pos + blockSize <= profileLength; pos += Math.floor(blockSize / 2)) {
    const blockRms = rms(buffer, pos, blockSize);
    if (blockRms < minRmsVal && blockRms > EPSILON) {
      minRmsVal   = blockRms;
      minRmsStart = pos;
    }
    reportProgress(3, (pos / profileLength) * 50);
  }

  // Build noise magnitude spectrum from quietest section
  const noiseSpectrum = new Float32Array(fftSize);
  let noiseFrameCount = 0;
  const noiseEnd = Math.min(minRmsStart + blockSize * 4, buffer.length);

  for (let nPos = minRmsStart; nPos + fftSize <= noiseEnd; nPos += hopSize) {
    const nReal = new Float32Array(fftSize);
    const nImag = new Float32Array(fftSize);
    const win   = hannWindow(fftSize);
    for (let i = 0; i < fftSize; i++) {
      nReal[i] = buffer[nPos + i] * win[i];
    }
    fft(nReal, nImag, false);
    const mag = magnitude(nReal, nImag);
    for (let k = 0; k < fftSize; k++) {
      noiseSpectrum[k] += mag[k];
    }
    noiseFrameCount++;
  }

  if (noiseFrameCount > 0) {
    for (let m = 0; m < fftSize; m++) {
      noiseSpectrum[m] /= noiseFrameCount;
    }
  }

  reportProgress(3, 100);
  return { buffer: buffer, noiseSpectrum: noiseSpectrum };
}

/* ================================================================
 * Stage 4: FFT Analysis (frame decomposition)
 * ================================================================ */

function stage4_fftAnalysis(buffer, config) {
  reportProgress(4, 0);

  const fftSize = config.fftSize || 2048;
  const hopSize = fftSize >> 2;
  const frames  = stft(buffer, fftSize, hopSize);

  reportProgress(4, 100);
  return frames;
}

/* ================================================================
 * Stage 5: Spectral Subtraction
 * ================================================================ */

function stage5_spectralSubtraction(frames, noiseSpectrum, config) {
  reportProgress(5, 0);

  const overSubFactor = config.noiseReduction || 2.0;     // over-subtraction factor
  const floorDb       = config.spectralFloor || -60;        // spectral floor in dB
  const floor         = dbToLinear(floorDb);

  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f];
    const mag = magnitude(frame.real, frame.imag);
    const ph  = phase(frame.real, frame.imag);

    // Subtract noise estimate from magnitude
    for (let i = 0; i < mag.length; i++) {
      const cleaned = mag[i] - overSubFactor * noiseSpectrum[i];
      // Spectral flooring to avoid musical noise
      mag[i] = Math.max(cleaned, floor * mag[i]);
    }

    // Reconstruct complex from cleaned magnitude and original phase
    polarToComplex(mag, ph, frame.real, frame.imag);

    if (f % 50 === 0) {
      reportProgress(5, (f / frames.length) * 100);
    }
  }

  reportProgress(5, 100);
  return frames;
}

/* ================================================================
 * Stage 6: Noise Gate
 * ================================================================ */

function stage6_noiseGate(buffer, config) {
  reportProgress(6, 0);

  const sampleRate = config.sampleRate || 44100;
  const threshDb   = config.gateThreshold || -40;  // dB
  const thresh     = dbToLinear(threshDb);
  const attackMs   = config.gateAttack || 1;     // ms
  const releaseMs  = config.gateRelease || 50;   // ms
  const holdMs     = config.gateHold || 20;      // ms
  const range      = config.gateRange || 0.01;   // minimum gain (not full silence)

  const attackSamples  = Math.max(1, Math.floor(sampleRate * attackMs / 1000));
  const releaseSamples = Math.max(1, Math.floor(sampleRate * releaseMs / 1000));
  const holdSamples    = Math.max(1, Math.floor(sampleRate * holdMs / 1000));

  const envelopeCoeff = Math.exp(-1.0 / (sampleRate * 0.01)); // 10ms envelope
  let envelope = 0.0;
  let gain     = 0.0;
  let holdCounter = 0;

  for (let i = 0; i < buffer.length; i++) {
    // Envelope follower
    const absVal = Math.abs(buffer[i]);
    if (absVal > envelope) {
      envelope = absVal;
    } else {
      envelope = envelope * envelopeCoeff + absVal * (1.0 - envelopeCoeff);
    }

    // Gate logic
    if (envelope > thresh) {
      holdCounter = holdSamples;
      // Attack
      gain += (1.0 - gain) / attackSamples;
      if (gain > 1.0) gain = 1.0;
    } else if (holdCounter > 0) {
      holdCounter--;
      // Keep gate open during hold
    } else {
      // Release
      gain -= (gain - range) / releaseSamples;
      if (gain < range) gain = range;
    }

    buffer[i] *= gain;

    if (i % 10000 === 0) {
      reportProgress(6, (i / buffer.length) * 100);
    }
  }

  reportProgress(6, 100);
  return buffer;
}

/* ================================================================
 * Stage 7: Hum Removal (50/60 Hz + harmonics)
 * ================================================================ */

function stage7_humRemoval(buffer, config) {
  reportProgress(7, 0);

  const sampleRate = config.sampleRate || 44100;
  const humFreqs   = config.humFreqs || [50, 60]; // both EU & US
  const harmonics  = config.humHarmonics || 4;
  const Q          = config.humQ || 30;

  for (let h = 0; h < humFreqs.length; h++) {
    const baseFreq = humFreqs[h];
    for (let n = 1; n <= harmonics; n++) {
      const freq = baseFreq * n;
      if (freq >= sampleRate / 2) break;

      const c = notchCoeffs(freq, sampleRate, Q);
      biquadFilter(buffer, c.b0, c.b1, c.b2, c.a1, c.a2);
    }
    reportProgress(7, ((h + 1) / humFreqs.length) * 100);
  }

  reportProgress(7, 100);
  return buffer;
}

/* ================================================================
 * Stage 8: Wiener Filter
 * ================================================================ */

function stage8_wienerFilter(frames, noiseSpectrum, config) {
  reportProgress(8, 0);

  const beta = config.wienerBeta || 0.98; // noise overestimation factor

  for (let f = 0; f < frames.length; f++) {
    const frame = frames[f];
    const mag = magnitude(frame.real, frame.imag);
    const ph  = phase(frame.real, frame.imag);

    for (let i = 0; i < mag.length; i++) {
      const sigPow   = mag[i] * mag[i];
      const noisePow = beta * noiseSpectrum[i] * noiseSpectrum[i];
      // Wiener gain: H(f) = max(1 - noise/signal, floor)
      const gain = sigPow > EPSILON ? Math.max(1.0 - noisePow / sigPow, 0.05) : 0.05;
      mag[i] *= gain;
    }

    polarToComplex(mag, ph, frame.real, frame.imag);

    if (f % 50 === 0) {
      reportProgress(8, (f / frames.length) * 100);
    }
  }

  reportProgress(8, 100);
  return frames;
}

/* ================================================================
 * Stage 9: Dereverberation (spectral decay suppression)
 * ================================================================ */

function stage9_dereverb(frames, config) {
  reportProgress(9, 0);

  const reverbDecay  = config.reverbDecay || 0.6;  // suppression strength 0..1
  const reverbFrames = config.reverbFrames || 3;    // look-back frame count

  if (frames.length <= reverbFrames) {
    reportProgress(9, 100);
    return frames;
  }

  // For each frame, subtract a weighted average of past frames' magnitude
  for (let f = reverbFrames; f < frames.length; f++) {
    const mag = magnitude(frames[f].real, frames[f].imag);
    const ph  = phase(frames[f].real, frames[f].imag);

    // Estimate late reverb energy from previous frames
    const reverbEst = new Float32Array(mag.length);
    for (let back = 1; back <= reverbFrames; back++) {
      const pastMag = magnitude(frames[f - back].real, frames[f - back].imag);
      const weight  = reverbDecay * Math.pow(0.7, back - 1); // exponential decay
      for (let i = 0; i < mag.length; i++) {
        reverbEst[i] += pastMag[i] * weight;
      }
    }

    // Subtract reverb estimate
    for (let j = 0; j < mag.length; j++) {
      reverbEst[j] /= reverbFrames;
      mag[j] = Math.max(mag[j] - reverbEst[j], mag[j] * 0.1);
    }

    polarToComplex(mag, ph, frames[f].real, frames[f].imag);

    if (f % 50 === 0) {
      reportProgress(9, (f / frames.length) * 100);
    }
  }

  reportProgress(9, 100);
  return frames;
}

/* ================================================================
 * Stage 10: Harmonic Reconstruction
 * ================================================================ */

function stage10_harmonicReconstruct(frames, config) {
  reportProgress(10, 0);

  const sampleRate = config.sampleRate || 44100;
  const fftSize    = config.fftSize || 2048;
  const strength   = config.harmonicStrength || 0.3;

  // Fundamental frequency range for human voice: ~80 Hz to ~500 Hz
  const minBin = Math.floor(80 * fftSize / sampleRate);
  const maxBin = Math.ceil(500 * fftSize / sampleRate);

  for (let f = 0; f < frames.length; f++) {
    const mag = magnitude(frames[f].real, frames[f].imag);
    const ph  = phase(frames[f].real, frames[f].imag);

    // Find fundamental: strongest bin in voice range
    let fundBin = minBin;
    let fundMag = 0.0;
    for (let b = minBin; b <= maxBin && b < mag.length; b++) {
      if (mag[b] > fundMag) {
        fundMag = mag[b];
        fundBin = b;
      }
    }

    if (fundMag > EPSILON) {
      // Reinforce harmonics (2nd through 8th)
      for (let h = 2; h <= 8; h++) {
        const hBin = fundBin * h;
        if (hBin >= mag.length) break;

        // Only boost if harmonic is weak relative to expected level
        const expected = fundMag / h; // harmonics naturally decay
        if (mag[hBin] < expected * 0.5) {
          const boost = (expected * 0.5 - mag[hBin]) * strength;
          mag[hBin] += boost;
        }
      }
    }

    polarToComplex(mag, ph, frames[f].real, frames[f].imag);

    if (f % 100 === 0) {
      reportProgress(10, (f / frames.length) * 100);
    }
  }

  reportProgress(10, 100);
  return frames;
}

/* ================================================================
 * Stage 11: Formant Enhancement
 * ================================================================ */

function stage11_formantEnhance(frames, config) {
  reportProgress(11, 0);

  const sampleRate = config.sampleRate || 44100;
  const fftSize    = config.fftSize || 2048;
  const strength   = config.formantStrength || 0.4;

  // Typical voice formant regions (Hz): F1 300-900, F2 1000-2500, F3 2400-3500
  const formantRegions = [
    { lo: 300,  hi: 900,  boost: 1.0 },
    { lo: 1000, hi: 2500, boost: 0.8 },
    { lo: 2400, hi: 3500, boost: 0.5 }
  ];

  for (let f = 0; f < frames.length; f++) {
    const mag = magnitude(frames[f].real, frames[f].imag);
    const ph  = phase(frames[f].real, frames[f].imag);

    // Compute spectral envelope via cepstral smoothing (simple moving average)
    const envelope = new Float32Array(mag.length);
    const smoothWidth = Math.max(3, Math.floor(fftSize / 256));
    for (let i = 0; i < mag.length; i++) {
      let sum = 0.0;
      let count = 0;
      for (let w = -smoothWidth; w <= smoothWidth; w++) {
        const idx = i + w;
        if (idx >= 0 && idx < mag.length) {
          sum += mag[idx];
          count++;
        }
      }
      envelope[i] = sum / count;
    }

    // Boost bins in formant regions where there is spectral energy
    for (let r = 0; r < formantRegions.length; r++) {
      const region = formantRegions[r];
      const loBin = Math.floor(region.lo * fftSize / sampleRate);
      const hiBin = Math.ceil(region.hi * fftSize / sampleRate);
      for (let b = loBin; b <= hiBin && b < mag.length; b++) {
        if (envelope[b] > EPSILON) {
          // Enhance formant peaks, not valleys
          const peakRatio = mag[b] / envelope[b];
          if (peakRatio > 1.0) {
            mag[b] *= (1.0 + strength * region.boost * (peakRatio - 1.0));
          }
        }
      }
    }

    polarToComplex(mag, ph, frames[f].real, frames[f].imag);

    if (f % 100 === 0) {
      reportProgress(11, (f / frames.length) * 100);
    }
  }

  reportProgress(11, 100);
  return frames;
}

/* ================================================================
 * Stage 12: Voice Presence Enhancement
 * ================================================================ */

function stage12_voicePresence(buffer, config) {
  reportProgress(12, 0);

  const sampleRate = config.sampleRate || 44100;

  // Broad presence boost: 2kHz-5kHz shelf
  const c = peakingEQCoeffs(3500, sampleRate, 1.2, config.presenceGainDb || 3.0);
  biquadFilter(buffer, c.b0, c.b1, c.b2, c.a1, c.a2);

  // Air/brilliance: gentle high-shelf above 8kHz
  const airGain = config.airGainDb || 1.5;
  const hs = highShelfCoeffs(8000, sampleRate, airGain);
  biquadFilter(buffer, hs.b0, hs.b1, hs.b2, hs.a1, hs.a2);

  reportProgress(12, 100);
  return buffer;
}

/* ================================================================
 * Stage 13: De-esser
 * ================================================================ */

function stage13_deesser(buffer, config) {
  reportProgress(13, 0);

  const sampleRate = config.sampleRate || 44100;
  const fftSize    = config.fftSize || 2048;
  const hopSize    = fftSize >> 2;
  const threshold  = config.deesserThreshold || -20; // dB
  const ratio      = config.deesserRatio || 4.0;
  const threshLin  = dbToLinear(threshold);

  // Sibilance band: 4kHz - 9kHz
  const loBin = Math.floor(4000 * fftSize / sampleRate);
  const hiBin = Math.ceil(9000 * fftSize / sampleRate);

  const frames = stft(buffer, fftSize, hopSize);

  for (let f = 0; f < frames.length; f++) {
    const mag = magnitude(frames[f].real, frames[f].imag);
    const ph  = phase(frames[f].real, frames[f].imag);

    // Measure sibilance energy
    let sibEnergy = 0.0;
    let totalEnergy = 0.0;
    for (let i = 0; i < mag.length; i++) {
      totalEnergy += mag[i] * mag[i];
      if (i >= loBin && i <= hiBin) {
        sibEnergy += mag[i] * mag[i];
      }
    }

    const sibRatio = totalEnergy > EPSILON ? Math.sqrt(sibEnergy / totalEnergy) : 0;

    // Apply gain reduction to sibilance band if above threshold
    if (sibRatio > threshLin) {
      const overDb = linearToDb(sibRatio) - threshold;
      const reductionDb = overDb * (1.0 - 1.0 / ratio);
      const gain = dbToLinear(-reductionDb);

      for (let j = loBin; j <= hiBin && j < mag.length; j++) {
        mag[j] *= gain;
      }
    }

    polarToComplex(mag, ph, frames[f].real, frames[f].imag);

    if (f % 100 === 0) {
      reportProgress(13, (f / frames.length) * 100);
    }
  }

  const result = istft(frames, fftSize, hopSize, buffer.length);
  reportProgress(13, 100);
  return result;
}

/* ================================================================
 * Stage 14: Dynamic Range Compression
 * ================================================================ */

function stage14_compression(buffer, config) {
  reportProgress(14, 0);

  const sampleRate = config.sampleRate || 44100;
  const threshDb   = config.compThreshold || -18;  // dB
  const ratio      = config.compRatio || 3.0;
  const attackMs   = config.compAttack || 10;       // ms
  const releaseMs  = config.compRelease || 100;     // ms
  const kneeDb     = config.compKnee || 6;          // dB
  let makeupDb   = config.compMakeup || 0;        // auto if 0

  const attackCoeff  = Math.exp(-1.0 / (sampleRate * attackMs / 1000));
  const releaseCoeff = Math.exp(-1.0 / (sampleRate * releaseMs / 1000));

  let envelope = 0.0;
  let gainDb   = 0.0;

  // Pass 1: Compute gain curve
  const gains = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const absVal = Math.abs(buffer[i]);
    // Smooth envelope
    if (absVal > envelope) {
      envelope = attackCoeff * envelope + (1.0 - attackCoeff) * absVal;
    } else {
      envelope = releaseCoeff * envelope + (1.0 - releaseCoeff) * absVal;
    }

    const envDb = linearToDb(envelope);

    // Soft-knee compression
    let overDb;
    if (envDb < threshDb - kneeDb / 2) {
      overDb = 0.0;
    } else if (envDb > threshDb + kneeDb / 2) {
      overDb = envDb - threshDb;
    } else {
      // Quadratic knee
      const x = envDb - threshDb + kneeDb / 2;
      overDb = (x * x) / (2.0 * kneeDb);
    }

    gainDb = -overDb * (1.0 - 1.0 / ratio);
    gains[i] = dbToLinear(gainDb);

    if (i % 10000 === 0) {
      reportProgress(14, (i / buffer.length) * 80);
    }
  }

  // Calculate auto makeup gain
  if (makeupDb === 0) {
    // Estimate average gain reduction
    let sumGainDb = 0.0;
    let sampleCount = 0;
    for (let j = 0; j < gains.length; j += 100) {
      sumGainDb += linearToDb(gains[j]);
      sampleCount++;
    }
    makeupDb = -sumGainDb / sampleCount * 0.5; // compensate 50%
    makeupDb = clamp(makeupDb, 0, 24);
  }
  const makeupLin = dbToLinear(makeupDb);

  // Pass 2: Apply gain with makeup
  for (let k = 0; k < buffer.length; k++) {
    buffer[k] *= gains[k] * makeupLin;
  }

  reportProgress(14, 100);
  return buffer;
}

/* ================================================================
 * Stage 15: EQ Shaping (voice-optimized 4-band)
 * ================================================================ */

function stage15_eqShaping(buffer, config) {
  reportProgress(15, 0);

  const sampleRate = config.sampleRate || 44100;

  // Low cut / body (150 Hz)
  const bodyGain = config.eqBody || 0; // dB
  if (Math.abs(bodyGain) > 0.1) {
    const ls = lowShelfCoeffs(150, sampleRate, bodyGain);
    biquadFilter(buffer, ls.b0, ls.b1, ls.b2, ls.a1, ls.a2);
  }
  reportProgress(15, 25);

  // Low-mid clarity (400 Hz, cut mud)
  const mudCut = config.eqMudCut || -2; // dB
  if (Math.abs(mudCut) > 0.1) {
    const mc = peakingEQCoeffs(400, sampleRate, 1.0, mudCut);
    biquadFilter(buffer, mc.b0, mc.b1, mc.b2, mc.a1, mc.a2);
  }
  reportProgress(15, 50);

  // Presence (3 kHz)
  const presGain = config.eqPresence || 2; // dB
  if (Math.abs(presGain) > 0.1) {
    const pr = peakingEQCoeffs(3000, sampleRate, 1.5, presGain);
    biquadFilter(buffer, pr.b0, pr.b1, pr.b2, pr.a1, pr.a2);
  }
  reportProgress(15, 75);

  // Air (10 kHz)
  const airGain = config.eqAir || 1; // dB
  if (Math.abs(airGain) > 0.1) {
    const air = highShelfCoeffs(10000, sampleRate, airGain);
    biquadFilter(buffer, air.b0, air.b1, air.b2, air.a1, air.a2);
  }

  reportProgress(15, 100);
  return buffer;
}

/* ================================================================
 * Stage 16: LUFS Normalization (ITU-R BS.1770)
 * ================================================================ */

function stage16_lufsNormalize(buffer, config) {
  reportProgress(16, 0);

  const sampleRate = config.sampleRate || 44100;
  const targetLUFS = config.targetLUFS || -16;   // target loudness

  // Step 1: K-weighting pre-filter (two stages)
  // Stage 1: High-shelf boost (~+4dB at high frequencies)
  const kShelf = highShelfCoeffs(1500, sampleRate, 4.0);
  const kBuffer = copyFloat32(buffer);
  biquadFilter(kBuffer, kShelf.b0, kShelf.b1, kShelf.b2, kShelf.a1, kShelf.a2);

  reportProgress(16, 20);

  // Stage 2: High-pass (RLB weighting) at ~38Hz
  const kHP = highPassCoeffs(38, sampleRate, 0.5);
  biquadFilter(kBuffer, kHP.b0, kHP.b1, kHP.b2, kHP.a1, kHP.a2);

  reportProgress(16, 40);

  // Step 2: Gated loudness measurement (simplified single-channel)
  const blockSize    = Math.floor(sampleRate * 0.4); // 400ms blocks
  const stepSize     = Math.floor(blockSize * 0.75);  // 75% overlap
  const blockLoudness = [];

  for (let pos = 0; pos + blockSize <= kBuffer.length; pos += stepSize) {
    let sumSq = 0.0;
    for (let i = 0; i < blockSize; i++) {
      sumSq += kBuffer[pos + i] * kBuffer[pos + i];
    }
    const meanSq = sumSq / blockSize;
    const lufs = -0.691 + 10.0 * Math.log10(Math.max(meanSq, EPSILON));
    blockLoudness.push(lufs);
  }

  reportProgress(16, 60);

  // Absolute gate at -70 LUFS
  const absGateBlocks = blockLoudness.filter(function (l) { return l > -70; });
  if (absGateBlocks.length === 0) {
    reportProgress(16, 100);
    return buffer;
  }

  const absGateMean = absGateBlocks.reduce(function (a, b) { return a + b; }, 0) / absGateBlocks.length;

  // Relative gate at mean - 10
  const relGateThreshold = absGateMean - 10;
  const relGateBlocks = absGateBlocks.filter(function (l) { return l > relGateThreshold; });

  if (relGateBlocks.length === 0) {
    reportProgress(16, 100);
    return buffer;
  }

  const integratedLUFS = relGateBlocks.reduce(function (a, b) { return a + b; }, 0) / relGateBlocks.length;

  reportProgress(16, 80);

  // Step 3: Apply gain to reach target LUFS
  let gainDb = targetLUFS - integratedLUFS;
  gainDb = clamp(gainDb, -20, 20); // safety limit
  const gainLin = dbToLinear(gainDb);

  for (let j = 0; j < buffer.length; j++) {
    buffer[j] *= gainLin;
  }

  reportProgress(16, 100);
  return buffer;
}

/* ================================================================
 * Stage 17: True Peak Limiter (ITU-R BS.1770 compliant)
 * ================================================================ */

function stage17_truePeakLimiter(buffer, config) {
  reportProgress(17, 0);

  const sampleRate  = config.sampleRate || 44100;
  const ceiling     = config.limiterCeiling || -1.0;  // dBTP
  const release     = config.limiterRelease || 50;     // ms
  const lookahead   = config.limiterLookahead || 5;    // ms
  const ceilingLin  = dbToLinear(ceiling);

  const lookaheadSamples = Math.max(1, Math.floor(sampleRate * lookahead / 1000));
  const releaseSamples   = Math.max(1, Math.floor(sampleRate * release / 1000));
  const releaseCoeff     = Math.exp(-1.0 / releaseSamples);

  // True peak detection via 4x oversampling (linear interpolation for efficiency)
  // This finds inter-sample peaks that exceed the ceiling
  function truePeakScan(buf, start, len) {
    let peak = 0.0;
    for (let i = start; i < start + len && i < buf.length - 1; i++) {
      const s0 = Math.abs(buf[i]);
      if (s0 > peak) peak = s0;
      // 4x oversampled check via cubic Hermite interpolation estimate
      const s1 = Math.abs(buf[i + 1]);
      // Mid-point estimate
      const mid = Math.abs((buf[i] + buf[i + 1]) * 0.5);
      if (mid > peak) peak = mid;
      // Quarter-point estimates
      const q1 = Math.abs(buf[i] * 0.75 + buf[i + 1] * 0.25);
      if (q1 > peak) peak = q1;
      const q3 = Math.abs(buf[i] * 0.25 + buf[i + 1] * 0.75);
      if (q3 > peak) peak = q3;
    }
    return peak;
  }

  // Compute gain envelope with lookahead
  const gainEnv = new Float32Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    gainEnv[i] = 1.0;
  }

  let currentGain = 1.0;

  for (let i2 = 0; i2 < buffer.length; i2++) {
    // Look ahead for peaks
    const peakInWindow = truePeakScan(buffer, i2, lookaheadSamples);
    let targetGain = 1.0;

    if (peakInWindow > ceilingLin) {
      targetGain = ceilingLin / peakInWindow;
    }

    // Smooth gain: instant attack, slow release
    if (targetGain < currentGain) {
      currentGain = targetGain;  // instant attack
    } else {
      currentGain = releaseCoeff * currentGain + (1.0 - releaseCoeff) * targetGain;
    }

    gainEnv[i2] = currentGain;

    if (i2 % 10000 === 0) {
      reportProgress(17, (i2 / buffer.length) * 70);
    }
  }

  // Apply gain envelope
  for (let j = 0; j < buffer.length; j++) {
    buffer[j] *= gainEnv[j];
    // Hard clip as final safety
    buffer[j] = clamp(buffer[j], -ceilingLin, ceilingLin);
  }

  reportProgress(17, 100);
  return buffer;
}

/* ================================================================
 * Main Pipeline Executor
 * ================================================================ */

function runPipeline(audioData, config) {
  const startTime = performance.now();

  // Determine which stages to run
  const stages = config.stages || null; // null = all stages
  const sampleRate = config.sampleRate || 44100;
  const fftSize    = config.fftSize || 2048;
  const hopSize    = fftSize >> 2;

  // Merge defaults into config
  config.sampleRate = sampleRate;
  config.fftSize    = fftSize;

  // ---- Stage 0: Validate ----
  let buffer = stage0_validate(audioData, config);

  // ---- Stage 1: Normalize ----
  if (!stages || stages.indexOf(1) !== -1) {
    buffer = stage1_normalize(buffer, config);
  }

  // ---- Stage 2: High-Pass ----
  if (!stages || stages.indexOf(2) !== -1) {
    buffer = stage2_highpass(buffer, config);
  }

  // ---- Stage 3: Noise Profile ----
  let noiseSpectrum = null;
  if (!stages || stages.indexOf(3) !== -1) {
    const profileResult = stage3_noiseProfile(buffer, config);
    buffer        = profileResult.buffer;
    noiseSpectrum = profileResult.noiseSpectrum;
  }

  // ---- Stage 4: FFT Analysis ----
  let frames = null;
  const needsSTFT = !stages || [4, 5, 8, 9, 10, 11].some(function (s) {
    return !stages || stages.indexOf(s) !== -1;
  });

  if (needsSTFT) {
    frames = stage4_fftAnalysis(buffer, config);
  }

  // ---- Stage 5: Spectral Subtraction ----
  if (frames && noiseSpectrum && (!stages || stages.indexOf(5) !== -1)) {
    frames = stage5_spectralSubtraction(frames, noiseSpectrum, config);
  }

  // Synthesize back to time domain for time-domain stages
  if (frames) {
    buffer = istft(frames, fftSize, hopSize, buffer.length);
  }

  // ---- Stage 6: Noise Gate ----
  if (!stages || stages.indexOf(6) !== -1) {
    buffer = stage6_noiseGate(buffer, config);
  }

  // ---- Stage 7: Hum Removal ----
  if (!stages || stages.indexOf(7) !== -1) {
    buffer = stage7_humRemoval(buffer, config);
  }

  // ---- Stages 8-11: Need STFT domain again ----
  const needsSecondSTFT = !stages || [8, 9, 10, 11].some(function (s) {
    return !stages || stages.indexOf(s) !== -1;
  });

  if (needsSecondSTFT) {
    frames = stft(buffer, fftSize, hopSize);

    // ---- Stage 8: Wiener Filter ----
    if (noiseSpectrum && (!stages || stages.indexOf(8) !== -1)) {
      frames = stage8_wienerFilter(frames, noiseSpectrum, config);
    }

    // ---- Stage 9: Dereverberation ----
    if (!stages || stages.indexOf(9) !== -1) {
      frames = stage9_dereverb(frames, config);
    }

    // ---- Stage 10: Harmonic Reconstruction ----
    if (!stages || stages.indexOf(10) !== -1) {
      frames = stage10_harmonicReconstruct(frames, config);
    }

    // ---- Stage 11: Formant Enhancement ----
    if (!stages || stages.indexOf(11) !== -1) {
      frames = stage11_formantEnhance(frames, config);
    }

    // Synthesize back
    buffer = istft(frames, fftSize, hopSize, buffer.length);
  }

  // ---- Stage 12: Voice Presence ----
  if (!stages || stages.indexOf(12) !== -1) {
    buffer = stage12_voicePresence(buffer, config);
  }

  // ---- Stage 13: De-esser ----
  if (!stages || stages.indexOf(13) !== -1) {
    buffer = stage13_deesser(buffer, config);
  }

  // ---- Stage 14: Compression ----
  if (!stages || stages.indexOf(14) !== -1) {
    buffer = stage14_compression(buffer, config);
  }

  // ---- Stage 15: EQ Shaping ----
  if (!stages || stages.indexOf(15) !== -1) {
    buffer = stage15_eqShaping(buffer, config);
  }

  // ---- Stage 16: LUFS Normalization ----
  if (!stages || stages.indexOf(16) !== -1) {
    buffer = stage16_lufsNormalize(buffer, config);
  }

  // ---- Stage 17: True Peak Limiter ----
  if (!stages || stages.indexOf(17) !== -1) {
    buffer = stage17_truePeakLimiter(buffer, config);
  }

  return buffer;
}

/* ================================================================
 * Message Handler
 * ================================================================ */

self.onmessage = function (event) {
  const msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'process') {
    currentJobId = msg.id || null;

    try {
      const config = msg.config || {};
      const stages = msg.stages || null;
      if (stages) {
        config.stages = stages;
      }

      const audioData = msg.data;
      if (!audioData) {
        reportError('MISSING_DATA', 'No audio data provided');
        return;
      }

      // Accept SharedArrayBuffer or ArrayBuffer-backed Float32Array
      let input;
      if (audioData instanceof Float32Array) {
        input = audioData;
      } else if (audioData instanceof ArrayBuffer || audioData instanceof SharedArrayBuffer) {
        input = new Float32Array(audioData);
      } else {
        reportError('INVALID_DATA', 'Audio data must be Float32Array or ArrayBuffer');
        return;
      }

      const output = runPipeline(input, config);
      reportComplete(output);
    } catch (e) {
      reportError('PIPELINE_ERROR', e.message || String(e));
    }
  }
};

// Signal readiness
self.postMessage({ type: 'ready' });
