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
  var sum = 0.0;
  var end = Math.min(start + length, buffer.length);
  for (var i = start; i < end; i++) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / (end - start));
}

/**
 * Find peak absolute value
 */
function peakAbs(buffer) {
  var peak = 0.0;
  for (var i = 0; i < buffer.length; i++) {
    var a = Math.abs(buffer[i]);
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * Copy Float32Array
 */
function copyFloat32(src) {
  var dst = new Float32Array(src.length);
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
  var n = real.length;
  if (n === 0) return;

  // Bit-reversal permutation
  var j = 0;
  for (var i = 0; i < n - 1; i++) {
    if (i < j) {
      var tr = real[i]; real[i] = real[j]; real[j] = tr;
      var ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
    }
    var m = n >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  // Butterfly stages
  var sign = inverse ? 1.0 : -1.0;
  for (var size = 2; size <= n; size *= 2) {
    var halfSize = size >> 1;
    var angle = sign * TWO_PI / size;
    var wReal = Math.cos(angle);
    var wImag = Math.sin(angle);
    for (var start = 0; start < n; start += size) {
      var curReal = 1.0;
      var curImag = 0.0;
      for (var k = 0; k < halfSize; k++) {
        var evenIdx = start + k;
        var oddIdx  = start + k + halfSize;
        var tReal = curReal * real[oddIdx] - curImag * imag[oddIdx];
        var tImag = curReal * imag[oddIdx] + curImag * real[oddIdx];
        real[oddIdx] = real[evenIdx] - tReal;
        imag[oddIdx] = imag[evenIdx] - tImag;
        real[evenIdx] += tReal;
        imag[evenIdx] += tImag;
        var newCurReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = newCurReal;
      }
    }
  }

  // Scale for inverse
  if (inverse) {
    for (var i2 = 0; i2 < n; i2++) {
      real[i2] /= n;
      imag[i2] /= n;
    }
  }
}

/**
 * Next power of 2 >= n
 */
function nextPow2(n) {
  var p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * Hann window
 */
function hannWindow(size) {
  var win = new Float32Array(size);
  for (var i = 0; i < size; i++) {
    win[i] = 0.5 * (1.0 - Math.cos(TWO_PI * i / (size - 1)));
  }
  return win;
}

/* ================================================================
 * STFT / ISTFT helpers
 * ================================================================ */

/**
 * Short-Time Fourier Transform.
 * Returns array of frames, each frame is { real: Float32Array, imag: Float32Array }.
 */
function stft(buffer, fftSize, hopSize) {
  var win = hannWindow(fftSize);
  var frames = [];
  for (var pos = 0; pos + fftSize <= buffer.length; pos += hopSize) {
    var real = new Float32Array(fftSize);
    var imag = new Float32Array(fftSize);
    for (var i = 0; i < fftSize; i++) {
      real[i] = buffer[pos + i] * win[i];
    }
    fft(real, imag, false);
    frames.push({ real: real, imag: imag, pos: pos });
  }
  return frames;
}

/**
 * Inverse STFT via overlap-add.
 */
function istft(frames, fftSize, hopSize, outputLength) {
  var win = hannWindow(fftSize);
  var output  = new Float32Array(outputLength);
  var winSum  = new Float32Array(outputLength);

  for (var f = 0; f < frames.length; f++) {
    var frame = frames[f];
    var real = copyFloat32(frame.real);
    var imag = copyFloat32(frame.imag);
    fft(real, imag, true);  // IFFT

    var pos = frame.pos;
    for (var i = 0; i < fftSize && (pos + i) < outputLength; i++) {
      output[pos + i] += real[i] * win[i];
      winSum[pos + i] += win[i] * win[i];
    }
  }

  // Normalize by window sum
  for (var j = 0; j < outputLength; j++) {
    if (winSum[j] > EPSILON) {
      output[j] /= winSum[j];
    }
  }

  return output;
}

/**
 * Compute magnitude spectrum from complex frame
 */
function magnitude(real, imag) {
  var mag = new Float32Array(real.length);
  for (var i = 0; i < real.length; i++) {
    mag[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
  }
  return mag;
}

/**
 * Compute phase from complex frame
 */
function phase(real, imag) {
  var ph = new Float32Array(real.length);
  for (var i = 0; i < real.length; i++) {
    ph[i] = Math.atan2(imag[i], real[i]);
  }
  return ph;
}

/**
 * Reconstruct complex from magnitude and phase
 */
function polarToComplex(mag, ph, outReal, outImag) {
  for (var i = 0; i < mag.length; i++) {
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
  var x1 = 0.0, x2 = 0.0, y1 = 0.0, y2 = 0.0;
  for (var i = 0; i < buffer.length; i++) {
    var x0 = buffer[i];
    var y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
    buffer[i] = y0;
  }
}

/**
 * Compute biquad coefficients for high-pass filter.
 */
function highPassCoeffs(fc, sampleRate, Q) {
  var w0 = TWO_PI * fc / sampleRate;
  var alpha = Math.sin(w0) / (2.0 * Q);
  var cosw0 = Math.cos(w0);
  var a0 = 1.0 + alpha;
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
  var w0 = TWO_PI * fc / sampleRate;
  var alpha = Math.sin(w0) / (2.0 * Q);
  var cosw0 = Math.cos(w0);
  var a0 = 1.0 + alpha;
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
  var A = Math.pow(10.0, gainDb / 40.0);
  var w0 = TWO_PI * fc / sampleRate;
  var alpha = Math.sin(w0) / (2.0 * Q);
  var cosw0 = Math.cos(w0);
  var a0 = 1.0 + alpha / A;
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
  var A = Math.pow(10.0, gainDb / 40.0);
  var w0 = TWO_PI * fc / sampleRate;
  var cosw0 = Math.cos(w0);
  var sinw0 = Math.sin(w0);
  var alpha = sinw0 / 2.0 * Math.sqrt((A + 1.0 / A) * 2.0);
  var sqrtA2alpha = 2.0 * Math.sqrt(A) * alpha;

  var a0 = (A + 1.0) + (A - 1.0) * cosw0 + sqrtA2alpha;
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
  var A = Math.pow(10.0, gainDb / 40.0);
  var w0 = TWO_PI * fc / sampleRate;
  var cosw0 = Math.cos(w0);
  var sinw0 = Math.sin(w0);
  var alpha = sinw0 / 2.0 * Math.sqrt((A + 1.0 / A) * 2.0);
  var sqrtA2alpha = 2.0 * Math.sqrt(A) * alpha;

  var a0 = (A + 1.0) - (A - 1.0) * cosw0 + sqrtA2alpha;
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

var currentJobId = null;

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
  var msg = {
    type: 'complete',
    id:   currentJobId,
    data: outputData
  };
  var transfer = [];
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
  var buffer;
  if (data instanceof Float32Array) {
    buffer = copyFloat32(data);
  } else {
    buffer = new Float32Array(data);
  }

  // Strip any DC offset
  var sum = 0.0;
  for (var i = 0; i < buffer.length; i++) {
    sum += buffer[i];
  }
  var dcOffset = sum / buffer.length;
  if (Math.abs(dcOffset) > 0.001) {
    for (var j = 0; j < buffer.length; j++) {
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

  var targetPeak = config.normTarget || 0.95;
  var peak = peakAbs(buffer);

  if (peak > EPSILON && peak !== targetPeak) {
    var gain = targetPeak / peak;
    for (var i = 0; i < buffer.length; i++) {
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

  var sampleRate = config.sampleRate || 44100;
  var hpfFreq    = config.hpfFreq || 80; // Hz
  var Q          = config.hpfQ || 0.707;

  var c = highPassCoeffs(hpfFreq, sampleRate, Q);
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

  var sampleRate = config.sampleRate || 44100;
  var fftSize    = config.fftSize || 2048;
  var hopSize    = fftSize >> 2; // 75% overlap

  // Find quietest segment for noise profile (analyze first 2s or full buffer)
  var profileLength = Math.min(buffer.length, Math.floor(sampleRate * 2));
  var blockSize     = Math.floor(sampleRate * 0.05); // 50ms blocks
  var minRmsVal     = Infinity;
  var minRmsStart   = 0;

  for (var pos = 0; pos + blockSize <= profileLength; pos += Math.floor(blockSize / 2)) {
    var blockRms = rms(buffer, pos, blockSize);
    if (blockRms < minRmsVal && blockRms > EPSILON) {
      minRmsVal   = blockRms;
      minRmsStart = pos;
    }
    reportProgress(3, (pos / profileLength) * 50);
  }

  // Build noise magnitude spectrum from quietest section
  var noiseSpectrum = new Float32Array(fftSize);
  var noiseFrameCount = 0;
  var noiseEnd = Math.min(minRmsStart + blockSize * 4, buffer.length);

  for (var nPos = minRmsStart; nPos + fftSize <= noiseEnd; nPos += hopSize) {
    var nReal = new Float32Array(fftSize);
    var nImag = new Float32Array(fftSize);
    var win   = hannWindow(fftSize);
    for (var i = 0; i < fftSize; i++) {
      nReal[i] = buffer[nPos + i] * win[i];
    }
    fft(nReal, nImag, false);
    var mag = magnitude(nReal, nImag);
    for (var k = 0; k < fftSize; k++) {
      noiseSpectrum[k] += mag[k];
    }
    noiseFrameCount++;
  }

  if (noiseFrameCount > 0) {
    for (var m = 0; m < fftSize; m++) {
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

  var fftSize = config.fftSize || 2048;
  var hopSize = fftSize >> 2;
  var frames  = stft(buffer, fftSize, hopSize);

  reportProgress(4, 100);
  return frames;
}

/* ================================================================
 * Stage 5: Spectral Subtraction
 * ================================================================ */

function stage5_spectralSubtraction(frames, noiseSpectrum, config) {
  reportProgress(5, 0);

  var overSubFactor = config.noiseReduction || 2.0;     // over-subtraction factor
  var floorDb       = config.spectralFloor || -60;        // spectral floor in dB
  var floor         = dbToLinear(floorDb);

  for (var f = 0; f < frames.length; f++) {
    var frame = frames[f];
    var mag = magnitude(frame.real, frame.imag);
    var ph  = phase(frame.real, frame.imag);

    // Subtract noise estimate from magnitude
    for (var i = 0; i < mag.length; i++) {
      var cleaned = mag[i] - overSubFactor * noiseSpectrum[i];
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

  var sampleRate = config.sampleRate || 44100;
  var threshDb   = config.gateThreshold || -40;  // dB
  var thresh     = dbToLinear(threshDb);
  var attackMs   = config.gateAttack || 1;     // ms
  var releaseMs  = config.gateRelease || 50;   // ms
  var holdMs     = config.gateHold || 20;      // ms
  var range      = config.gateRange || 0.01;   // minimum gain (not full silence)

  var attackSamples  = Math.max(1, Math.floor(sampleRate * attackMs / 1000));
  var releaseSamples = Math.max(1, Math.floor(sampleRate * releaseMs / 1000));
  var holdSamples    = Math.max(1, Math.floor(sampleRate * holdMs / 1000));

  var envelopeCoeff = Math.exp(-1.0 / (sampleRate * 0.01)); // 10ms envelope
  var envelope = 0.0;
  var gain     = 0.0;
  var holdCounter = 0;

  for (var i = 0; i < buffer.length; i++) {
    // Envelope follower
    var absVal = Math.abs(buffer[i]);
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

  var sampleRate = config.sampleRate || 44100;
  var humFreqs   = config.humFreqs || [50, 60]; // both EU & US
  var harmonics  = config.humHarmonics || 4;
  var Q          = config.humQ || 30;

  for (var h = 0; h < humFreqs.length; h++) {
    var baseFreq = humFreqs[h];
    for (var n = 1; n <= harmonics; n++) {
      var freq = baseFreq * n;
      if (freq >= sampleRate / 2) break;

      var c = notchCoeffs(freq, sampleRate, Q);
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

  var beta = config.wienerBeta || 0.98; // noise overestimation factor

  for (var f = 0; f < frames.length; f++) {
    var frame = frames[f];
    var mag = magnitude(frame.real, frame.imag);
    var ph  = phase(frame.real, frame.imag);

    for (var i = 0; i < mag.length; i++) {
      var sigPow   = mag[i] * mag[i];
      var noisePow = beta * noiseSpectrum[i] * noiseSpectrum[i];
      // Wiener gain: H(f) = max(1 - noise/signal, floor)
      var gain = sigPow > EPSILON ? Math.max(1.0 - noisePow / sigPow, 0.05) : 0.05;
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

  var reverbDecay  = config.reverbDecay || 0.6;  // suppression strength 0..1
  var reverbFrames = config.reverbFrames || 3;    // look-back frame count

  if (frames.length <= reverbFrames) {
    reportProgress(9, 100);
    return frames;
  }

  // For each frame, subtract a weighted average of past frames' magnitude
  for (var f = reverbFrames; f < frames.length; f++) {
    var mag = magnitude(frames[f].real, frames[f].imag);
    var ph  = phase(frames[f].real, frames[f].imag);

    // Estimate late reverb energy from previous frames
    var reverbEst = new Float32Array(mag.length);
    for (var back = 1; back <= reverbFrames; back++) {
      var pastMag = magnitude(frames[f - back].real, frames[f - back].imag);
      var weight  = reverbDecay * Math.pow(0.7, back - 1); // exponential decay
      for (var i = 0; i < mag.length; i++) {
        reverbEst[i] += pastMag[i] * weight;
      }
    }

    // Subtract reverb estimate
    for (var j = 0; j < mag.length; j++) {
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

  var sampleRate = config.sampleRate || 44100;
  var fftSize    = config.fftSize || 2048;
  var strength   = config.harmonicStrength || 0.3;

  // Fundamental frequency range for human voice: ~80 Hz to ~500 Hz
  var minBin = Math.floor(80 * fftSize / sampleRate);
  var maxBin = Math.ceil(500 * fftSize / sampleRate);

  for (var f = 0; f < frames.length; f++) {
    var mag = magnitude(frames[f].real, frames[f].imag);
    var ph  = phase(frames[f].real, frames[f].imag);

    // Find fundamental: strongest bin in voice range
    var fundBin = minBin;
    var fundMag = 0.0;
    for (var b = minBin; b <= maxBin && b < mag.length; b++) {
      if (mag[b] > fundMag) {
        fundMag = mag[b];
        fundBin = b;
      }
    }

    if (fundMag > EPSILON) {
      // Reinforce harmonics (2nd through 8th)
      for (var h = 2; h <= 8; h++) {
        var hBin = fundBin * h;
        if (hBin >= mag.length) break;

        // Only boost if harmonic is weak relative to expected level
        var expected = fundMag / h; // harmonics naturally decay
        if (mag[hBin] < expected * 0.5) {
          var boost = (expected * 0.5 - mag[hBin]) * strength;
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

  var sampleRate = config.sampleRate || 44100;
  var fftSize    = config.fftSize || 2048;
  var strength   = config.formantStrength || 0.4;

  // Typical voice formant regions (Hz): F1 300-900, F2 1000-2500, F3 2400-3500
  var formantRegions = [
    { lo: 300,  hi: 900,  boost: 1.0 },
    { lo: 1000, hi: 2500, boost: 0.8 },
    { lo: 2400, hi: 3500, boost: 0.5 }
  ];

  for (var f = 0; f < frames.length; f++) {
    var mag = magnitude(frames[f].real, frames[f].imag);
    var ph  = phase(frames[f].real, frames[f].imag);

    // Compute spectral envelope via cepstral smoothing (simple moving average)
    var envelope = new Float32Array(mag.length);
    var smoothWidth = Math.max(3, Math.floor(fftSize / 256));
    for (var i = 0; i < mag.length; i++) {
      var sum = 0.0;
      var count = 0;
      for (var w = -smoothWidth; w <= smoothWidth; w++) {
        var idx = i + w;
        if (idx >= 0 && idx < mag.length) {
          sum += mag[idx];
          count++;
        }
      }
      envelope[i] = sum / count;
    }

    // Boost bins in formant regions where there is spectral energy
    for (var r = 0; r < formantRegions.length; r++) {
      var region = formantRegions[r];
      var loBin = Math.floor(region.lo * fftSize / sampleRate);
      var hiBin = Math.ceil(region.hi * fftSize / sampleRate);
      for (var b = loBin; b <= hiBin && b < mag.length; b++) {
        if (envelope[b] > EPSILON) {
          // Enhance formant peaks, not valleys
          var peakRatio = mag[b] / envelope[b];
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

  var sampleRate = config.sampleRate || 44100;

  // Broad presence boost: 2kHz-5kHz shelf
  var c = peakingEQCoeffs(3500, sampleRate, 1.2, config.presenceGainDb || 3.0);
  biquadFilter(buffer, c.b0, c.b1, c.b2, c.a1, c.a2);

  // Air/brilliance: gentle high-shelf above 8kHz
  var airGain = config.airGainDb || 1.5;
  var hs = highShelfCoeffs(8000, sampleRate, airGain);
  biquadFilter(buffer, hs.b0, hs.b1, hs.b2, hs.a1, hs.a2);

  reportProgress(12, 100);
  return buffer;
}

/* ================================================================
 * Stage 13: De-esser
 * ================================================================ */

function stage13_deesser(buffer, config) {
  reportProgress(13, 0);

  var sampleRate = config.sampleRate || 44100;
  var fftSize    = config.fftSize || 2048;
  var hopSize    = fftSize >> 2;
  var threshold  = config.deesserThreshold || -20; // dB
  var ratio      = config.deesserRatio || 4.0;
  var threshLin  = dbToLinear(threshold);

  // Sibilance band: 4kHz - 9kHz
  var loBin = Math.floor(4000 * fftSize / sampleRate);
  var hiBin = Math.ceil(9000 * fftSize / sampleRate);

  var frames = stft(buffer, fftSize, hopSize);

  for (var f = 0; f < frames.length; f++) {
    var mag = magnitude(frames[f].real, frames[f].imag);
    var ph  = phase(frames[f].real, frames[f].imag);

    // Measure sibilance energy
    var sibEnergy = 0.0;
    var totalEnergy = 0.0;
    for (var i = 0; i < mag.length; i++) {
      totalEnergy += mag[i] * mag[i];
      if (i >= loBin && i <= hiBin) {
        sibEnergy += mag[i] * mag[i];
      }
    }

    var sibRatio = totalEnergy > EPSILON ? Math.sqrt(sibEnergy / totalEnergy) : 0;

    // Apply gain reduction to sibilance band if above threshold
    if (sibRatio > threshLin) {
      var overDb = linearToDb(sibRatio) - threshold;
      var reductionDb = overDb * (1.0 - 1.0 / ratio);
      var gain = dbToLinear(-reductionDb);

      for (var j = loBin; j <= hiBin && j < mag.length; j++) {
        mag[j] *= gain;
      }
    }

    polarToComplex(mag, ph, frames[f].real, frames[f].imag);

    if (f % 100 === 0) {
      reportProgress(13, (f / frames.length) * 100);
    }
  }

  var result = istft(frames, fftSize, hopSize, buffer.length);
  reportProgress(13, 100);
  return result;
}

/* ================================================================
 * Stage 14: Dynamic Range Compression
 * ================================================================ */

function stage14_compression(buffer, config) {
  reportProgress(14, 0);

  var sampleRate = config.sampleRate || 44100;
  var threshDb   = config.compThreshold || -18;  // dB
  var ratio      = config.compRatio || 3.0;
  var attackMs   = config.compAttack || 10;       // ms
  var releaseMs  = config.compRelease || 100;     // ms
  var kneeDb     = config.compKnee || 6;          // dB
  var makeupDb   = config.compMakeup || 0;        // auto if 0

  var attackCoeff  = Math.exp(-1.0 / (sampleRate * attackMs / 1000));
  var releaseCoeff = Math.exp(-1.0 / (sampleRate * releaseMs / 1000));

  var envelope = 0.0;
  var gainDb   = 0.0;

  // Pass 1: Compute gain curve
  var gains = new Float32Array(buffer.length);
  for (var i = 0; i < buffer.length; i++) {
    var absVal = Math.abs(buffer[i]);
    // Smooth envelope
    if (absVal > envelope) {
      envelope = attackCoeff * envelope + (1.0 - attackCoeff) * absVal;
    } else {
      envelope = releaseCoeff * envelope + (1.0 - releaseCoeff) * absVal;
    }

    var envDb = linearToDb(envelope);

    // Soft-knee compression
    var overDb;
    if (envDb < threshDb - kneeDb / 2) {
      overDb = 0.0;
    } else if (envDb > threshDb + kneeDb / 2) {
      overDb = envDb - threshDb;
    } else {
      // Quadratic knee
      var x = envDb - threshDb + kneeDb / 2;
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
    var sumGainDb = 0.0;
    var sampleCount = 0;
    for (var j = 0; j < gains.length; j += 100) {
      sumGainDb += linearToDb(gains[j]);
      sampleCount++;
    }
    makeupDb = -sumGainDb / sampleCount * 0.5; // compensate 50%
    makeupDb = clamp(makeupDb, 0, 24);
  }
  var makeupLin = dbToLinear(makeupDb);

  // Pass 2: Apply gain with makeup
  for (var k = 0; k < buffer.length; k++) {
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

  var sampleRate = config.sampleRate || 44100;

  // Low cut / body (150 Hz)
  var bodyGain = config.eqBody || 0; // dB
  if (Math.abs(bodyGain) > 0.1) {
    var ls = lowShelfCoeffs(150, sampleRate, bodyGain);
    biquadFilter(buffer, ls.b0, ls.b1, ls.b2, ls.a1, ls.a2);
  }
  reportProgress(15, 25);

  // Low-mid clarity (400 Hz, cut mud)
  var mudCut = config.eqMudCut || -2; // dB
  if (Math.abs(mudCut) > 0.1) {
    var mc = peakingEQCoeffs(400, sampleRate, 1.0, mudCut);
    biquadFilter(buffer, mc.b0, mc.b1, mc.b2, mc.a1, mc.a2);
  }
  reportProgress(15, 50);

  // Presence (3 kHz)
  var presGain = config.eqPresence || 2; // dB
  if (Math.abs(presGain) > 0.1) {
    var pr = peakingEQCoeffs(3000, sampleRate, 1.5, presGain);
    biquadFilter(buffer, pr.b0, pr.b1, pr.b2, pr.a1, pr.a2);
  }
  reportProgress(15, 75);

  // Air (10 kHz)
  var airGain = config.eqAir || 1; // dB
  if (Math.abs(airGain) > 0.1) {
    var air = highShelfCoeffs(10000, sampleRate, airGain);
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

  var sampleRate = config.sampleRate || 44100;
  var targetLUFS = config.targetLUFS || -16;   // target loudness

  // Step 1: K-weighting pre-filter (two stages)
  // Stage 1: High-shelf boost (~+4dB at high frequencies)
  var kShelf = highShelfCoeffs(1500, sampleRate, 4.0);
  var kBuffer = copyFloat32(buffer);
  biquadFilter(kBuffer, kShelf.b0, kShelf.b1, kShelf.b2, kShelf.a1, kShelf.a2);

  reportProgress(16, 20);

  // Stage 2: High-pass (RLB weighting) at ~38Hz
  var kHP = highPassCoeffs(38, sampleRate, 0.5);
  biquadFilter(kBuffer, kHP.b0, kHP.b1, kHP.b2, kHP.a1, kHP.a2);

  reportProgress(16, 40);

  // Step 2: Gated loudness measurement (simplified single-channel)
  var blockSize    = Math.floor(sampleRate * 0.4); // 400ms blocks
  var stepSize     = Math.floor(blockSize * 0.75);  // 75% overlap
  var blockLoudness = [];

  for (var pos = 0; pos + blockSize <= kBuffer.length; pos += stepSize) {
    var sumSq = 0.0;
    for (var i = 0; i < blockSize; i++) {
      sumSq += kBuffer[pos + i] * kBuffer[pos + i];
    }
    var meanSq = sumSq / blockSize;
    var lufs = -0.691 + 10.0 * Math.log10(Math.max(meanSq, EPSILON));
    blockLoudness.push(lufs);
  }

  reportProgress(16, 60);

  // Absolute gate at -70 LUFS
  var absGateBlocks = blockLoudness.filter(function (l) { return l > -70; });
  if (absGateBlocks.length === 0) {
    reportProgress(16, 100);
    return buffer;
  }

  var absGateMean = absGateBlocks.reduce(function (a, b) { return a + b; }, 0) / absGateBlocks.length;

  // Relative gate at mean - 10
  var relGateThreshold = absGateMean - 10;
  var relGateBlocks = absGateBlocks.filter(function (l) { return l > relGateThreshold; });

  if (relGateBlocks.length === 0) {
    reportProgress(16, 100);
    return buffer;
  }

  var integratedLUFS = relGateBlocks.reduce(function (a, b) { return a + b; }, 0) / relGateBlocks.length;

  reportProgress(16, 80);

  // Step 3: Apply gain to reach target LUFS
  var gainDb = targetLUFS - integratedLUFS;
  gainDb = clamp(gainDb, -20, 20); // safety limit
  var gainLin = dbToLinear(gainDb);

  for (var j = 0; j < buffer.length; j++) {
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

  var sampleRate  = config.sampleRate || 44100;
  var ceiling     = config.limiterCeiling || -1.0;  // dBTP
  var release     = config.limiterRelease || 50;     // ms
  var lookahead   = config.limiterLookahead || 5;    // ms
  var ceilingLin  = dbToLinear(ceiling);

  var lookaheadSamples = Math.max(1, Math.floor(sampleRate * lookahead / 1000));
  var releaseSamples   = Math.max(1, Math.floor(sampleRate * release / 1000));
  var releaseCoeff     = Math.exp(-1.0 / releaseSamples);

  // True peak detection via 4x oversampling (linear interpolation for efficiency)
  // This finds inter-sample peaks that exceed the ceiling
  function truePeakScan(buf, start, len) {
    var peak = 0.0;
    for (var i = start; i < start + len && i < buf.length - 1; i++) {
      var s0 = Math.abs(buf[i]);
      if (s0 > peak) peak = s0;
      // 4x oversampled check via cubic Hermite interpolation estimate
      var s1 = Math.abs(buf[i + 1]);
      // Mid-point estimate
      var mid = Math.abs((buf[i] + buf[i + 1]) * 0.5);
      if (mid > peak) peak = mid;
      // Quarter-point estimates
      var q1 = Math.abs(buf[i] * 0.75 + buf[i + 1] * 0.25);
      if (q1 > peak) peak = q1;
      var q3 = Math.abs(buf[i] * 0.25 + buf[i + 1] * 0.75);
      if (q3 > peak) peak = q3;
    }
    return peak;
  }

  // Compute gain envelope with lookahead
  var gainEnv = new Float32Array(buffer.length);
  for (var i = 0; i < buffer.length; i++) {
    gainEnv[i] = 1.0;
  }

  var currentGain = 1.0;

  for (var i2 = 0; i2 < buffer.length; i2++) {
    // Look ahead for peaks
    var peakInWindow = truePeakScan(buffer, i2, lookaheadSamples);
    var targetGain = 1.0;

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
  for (var j = 0; j < buffer.length; j++) {
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
  var startTime = performance.now();

  // Determine which stages to run
  var stages = config.stages || null; // null = all stages
  var sampleRate = config.sampleRate || 44100;
  var fftSize    = config.fftSize || 2048;
  var hopSize    = fftSize >> 2;

  // Merge defaults into config
  config.sampleRate = sampleRate;
  config.fftSize    = fftSize;

  // ---- Stage 0: Validate ----
  var buffer = stage0_validate(audioData, config);

  // ---- Stage 1: Normalize ----
  if (!stages || stages.indexOf(1) !== -1) {
    buffer = stage1_normalize(buffer, config);
  }

  // ---- Stage 2: High-Pass ----
  if (!stages || stages.indexOf(2) !== -1) {
    buffer = stage2_highpass(buffer, config);
  }

  // ---- Stage 3: Noise Profile ----
  var noiseSpectrum = null;
  if (!stages || stages.indexOf(3) !== -1) {
    var profileResult = stage3_noiseProfile(buffer, config);
    buffer        = profileResult.buffer;
    noiseSpectrum = profileResult.noiseSpectrum;
  }

  // ---- Stage 4: FFT Analysis ----
  var frames = null;
  var needsSTFT = !stages || [4, 5, 8, 9, 10, 11].some(function (s) {
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
  var needsSecondSTFT = !stages || [8, 9, 10, 11].some(function (s) {
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
  var msg = event.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'process') {
    currentJobId = msg.id || null;

    try {
      var config = msg.config || {};
      var stages = msg.stages || null;
      if (stages) {
        config.stages = stages;
      }

      var audioData = msg.data;
      if (!audioData) {
        reportError('MISSING_DATA', 'No audio data provided');
        return;
      }

      // Accept SharedArrayBuffer or ArrayBuffer-backed Float32Array
      var input;
      if (audioData instanceof Float32Array) {
        input = audioData;
      } else if (audioData instanceof ArrayBuffer || audioData instanceof SharedArrayBuffer) {
        input = new Float32Array(audioData);
      } else {
        reportError('INVALID_DATA', 'Audio data must be Float32Array or ArrayBuffer');
        return;
      }

      var output = runPipeline(input, config);
      reportComplete(output);
    } catch (e) {
      reportError('PIPELINE_ERROR', e.message || String(e));
    }
  }
};

// Signal readiness
self.postMessage({ type: 'ready' });
