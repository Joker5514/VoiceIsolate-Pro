/**
 * VoiceIsolate Pro v9.0 - Audio Utility Functions
 *
 * Pure-function utilities for audio decoding, format conversion,
 * resampling, metering, and content-type heuristics.
 *
 * All functions are individually exported as named exports.
 */

// ---------------------------------------------------------------------------
// Decoding & buffer conversion
// ---------------------------------------------------------------------------

/**
 * Decode an audio file (Blob / File) into an AudioBuffer.
 *
 * @param {File|Blob} file
 * @param {AudioContext} audioContext
 * @returns {Promise<AudioBuffer>}
 */
export async function decodeAudioFile(file, audioContext) {
  if (!file || !(file instanceof Blob)) {
    throw new TypeError('decodeAudioFile: first argument must be a File or Blob');
  }
  if (!audioContext || typeof audioContext.decodeAudioData !== 'function') {
    throw new TypeError('decodeAudioFile: second argument must be an AudioContext');
  }

  const arrayBuffer = await file.arrayBuffer();
  // decodeAudioData returns a Promise in modern browsers.
  return audioContext.decodeAudioData(arrayBuffer);
}

/**
 * Extract a mono Float32Array from an AudioBuffer.
 * If the buffer has multiple channels they are mixed to mono.
 *
 * @param {AudioBuffer} buffer
 * @returns {Float32Array}
 */
export function audioBufferToFloat32(buffer) {
  if (buffer.numberOfChannels === 1) {
    return new Float32Array(buffer.getChannelData(0));
  }

  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(buffer.getChannelData(c));
  }
  return mixToMono(channels);
}

/**
 * Create an AudioBuffer from a Float32Array.
 *
 * @param {Float32Array} data         Interleaved or mono sample data.
 * @param {number}       sampleRate
 * @param {number}       [channels=1] Number of channels (1 = mono, 2 = stereo, ...).
 * @param {AudioContext} audioContext
 * @returns {AudioBuffer}
 */
export function float32ToAudioBuffer(data, sampleRate, channels = 1, audioContext) {
  const frameCount = Math.floor(data.length / channels);
  const audioBuffer = audioContext.createBuffer(channels, frameCount, sampleRate);

  if (channels === 1) {
    audioBuffer.copyToChannel(data.length === frameCount ? data : data.subarray(0, frameCount), 0);
  } else {
    const separated = splitChannels(data, channels);
    for (let c = 0; c < channels; c++) {
      audioBuffer.copyToChannel(separated[c], c);
    }
  }

  return audioBuffer;
}

// ---------------------------------------------------------------------------
// Resampling
// ---------------------------------------------------------------------------

/**
 * Resample a Float32Array using linear interpolation.
 *
 * @param {Float32Array} data
 * @param {number}       fromRate  Original sample rate.
 * @param {number}       toRate    Target sample rate.
 * @returns {Float32Array}
 */
export function resample(data, fromRate, toRate) {
  if (fromRate === toRate) return new Float32Array(data);

  const ratio = fromRate / toRate;
  const outputLength = Math.round(data.length / ratio);
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const indexFloor = Math.floor(srcIndex);
    const indexCeil = Math.min(indexFloor + 1, data.length - 1);
    const frac = srcIndex - indexFloor;

    output[i] = data[indexFloor] * (1 - frac) + data[indexCeil] * frac;
  }

  return output;
}

// ---------------------------------------------------------------------------
// Channel manipulation
// ---------------------------------------------------------------------------

/**
 * Mix an array of channel Float32Arrays down to mono by averaging.
 *
 * @param {Float32Array[]} channels
 * @returns {Float32Array}
 */
export function mixToMono(channels) {
  if (!channels || channels.length === 0) {
    throw new Error('mixToMono: at least one channel required');
  }
  if (channels.length === 1) return new Float32Array(channels[0]);

  const length = channels[0].length;
  const mono = new Float32Array(length);
  const gain = 1 / channels.length;

  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < channels.length; c++) {
      sum += channels[c][i];
    }
    mono[i] = sum * gain;
  }

  return mono;
}

/**
 * Split an interleaved Float32Array into separate per-channel arrays.
 *
 * @param {Float32Array} interleaved
 * @param {number}       channelCount
 * @returns {Float32Array[]}
 */
export function splitChannels(interleaved, channelCount) {
  const frameCount = Math.floor(interleaved.length / channelCount);
  const channels = [];

  for (let c = 0; c < channelCount; c++) {
    channels.push(new Float32Array(frameCount));
  }

  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < channelCount; c++) {
      channels[c][i] = interleaved[i * channelCount + c];
    }
  }

  return channels;
}

/**
 * Interleave separate channel arrays into a single Float32Array.
 *
 * @param {Float32Array[]} channels
 * @returns {Float32Array}
 */
export function interleaveChannels(channels) {
  if (!channels || channels.length === 0) {
    throw new Error('interleaveChannels: at least one channel required');
  }

  const channelCount = channels.length;
  const frameCount = channels[0].length;
  const interleaved = new Float32Array(frameCount * channelCount);

  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < channelCount; c++) {
      interleaved[i * channelCount + c] = channels[c][i];
    }
  }

  return interleaved;
}

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

/**
 * Return the peak amplitude in dBFS.
 *
 * @param {Float32Array} data
 * @returns {number} Peak in dB (0 dB = full scale, negative values below).
 */
export function measurePeak(data) {
  if (!data || data.length === 0) return -Infinity;

  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    if (abs > peak) peak = abs;
  }

  return peak === 0 ? -Infinity : 20 * Math.log10(peak);
}

/**
 * Return the RMS level in dBFS.
 *
 * @param {Float32Array} data
 * @returns {number}
 */
export function measureRMS(data) {
  if (!data || data.length === 0) return -Infinity;

  let sumSq = 0;
  for (let i = 0; i < data.length; i++) {
    sumSq += data[i] * data[i];
  }
  const rms = Math.sqrt(sumSq / data.length);

  return rms === 0 ? -Infinity : 20 * Math.log10(rms);
}

/**
 * Simplified ITU-R BS.1770-4 integrated loudness measurement (LUFS).
 *
 * Applies a two-stage K-weighting filter (pre-filter + RLB weighting)
 * using biquad coefficients for 48 kHz, then gates and averages
 * per 400 ms blocks.
 *
 * This is a simplified single-channel implementation suitable for
 * real-time preview metering.  For broadcast-grade measurements use
 * a dedicated library.
 *
 * @param {Float32Array} data
 * @param {number}       sampleRate
 * @returns {number} Loudness in LUFS.
 */
export function measureLUFS(data, sampleRate) {
  if (!data || data.length === 0) return -Infinity;

  // -- K-weighting stage 1: high-shelf pre-filter (boost ~+4 dB above 1.5 kHz) --
  // Coefficients designed for 48 kHz; we resample mentally by accepting
  // the approximation for other rates.
  const preB = [1.53512485958697, -2.69169618940638, 1.19839281085285];
  const preA = [1.0, -1.69065929318241, 0.73248077421585];

  // -- K-weighting stage 2: RLB high-pass (revised low-frequency, ~60 Hz) --
  const rlbB = [1.0, -2.0, 1.0];
  const rlbA = [1.0, -1.99004745483398, 0.99007225036621];

  // Apply biquad filter (Direct Form I).
  const applyBiquad = (input, b, a) => {
    const out = new Float32Array(input.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;

    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const y = b[0] * x + b[1] * x1 + b[2] * x2
              - a[1] * y1 - a[2] * y2;
      out[i] = y;
      x2 = x1; x1 = x;
      y2 = y1; y1 = y;
    }
    return out;
  };

  const stage1 = applyBiquad(data, preB, preA);
  const kWeighted = applyBiquad(stage1, rlbB, rlbA);

  // -- Gated block measurement (400 ms blocks, 75 % overlap) --
  const blockSize = Math.round(0.4 * sampleRate);   // 400 ms
  const stepSize = Math.round(0.1 * sampleRate);     // 100 ms step (75 % overlap)

  if (kWeighted.length < blockSize) {
    // Too short for a full block -- just compute mean-square.
    let sumSq = 0;
    for (let i = 0; i < kWeighted.length; i++) {
      sumSq += kWeighted[i] * kWeighted[i];
    }
    const ms = sumSq / kWeighted.length;
    return ms === 0 ? -Infinity : -0.691 + 10 * Math.log10(ms);
  }

  // Compute mean-square for each block.
  const blockLoudnesses = [];
  for (let start = 0; start + blockSize <= kWeighted.length; start += stepSize) {
    let sumSq = 0;
    for (let j = start; j < start + blockSize; j++) {
      sumSq += kWeighted[j] * kWeighted[j];
    }
    blockLoudnesses.push(sumSq / blockSize);
  }

  // Absolute gate: -70 LUFS.
  const absGateThreshold = Math.pow(10, (-70 + 0.691) / 10);
  const gatedOnce = blockLoudnesses.filter((ms) => ms > absGateThreshold);

  if (gatedOnce.length === 0) return -Infinity;

  // Relative gate: -10 dB below ungated average.
  const avgOnce = gatedOnce.reduce((a, b) => a + b, 0) / gatedOnce.length;
  const relGateThreshold = avgOnce * Math.pow(10, -10 / 10); // -10 dB

  const gatedTwice = gatedOnce.filter((ms) => ms > relGateThreshold);
  if (gatedTwice.length === 0) return -Infinity;

  const avgFinal = gatedTwice.reduce((a, b) => a + b, 0) / gatedTwice.length;
  return -0.691 + 10 * Math.log10(avgFinal);
}

/**
 * Estimate the noise floor using the 10th percentile of absolute sample values.
 *
 * @param {Float32Array} data
 * @returns {number} Estimated noise floor in dBFS.
 */
export function estimateNoiseFloor(data) {
  if (!data || data.length === 0) return -Infinity;

  // To avoid sorting the entire array (expensive), we use a histogram approach.
  const BINS = 1000;
  const histogram = new Uint32Array(BINS);

  for (let i = 0; i < data.length; i++) {
    const abs = Math.abs(data[i]);
    const bin = Math.min(Math.floor(abs * BINS), BINS - 1);
    histogram[bin]++;
  }

  const target = Math.floor(data.length * 0.10);
  let cumulative = 0;

  for (let b = 0; b < BINS; b++) {
    cumulative += histogram[b];
    if (cumulative >= target) {
      const amplitude = (b + 0.5) / BINS;
      return amplitude === 0 ? -Infinity : 20 * Math.log10(amplitude);
    }
  }

  return -Infinity;
}

/**
 * Calculate signal-to-noise ratio in dB.
 *
 * Uses RMS as signal level and the estimated noise floor.
 *
 * @param {Float32Array} data
 * @returns {number} SNR in dB.
 */
export function calculateSNR(data) {
  const rms = measureRMS(data);
  const noise = estimateNoiseFloor(data);

  if (!isFinite(rms) || !isFinite(noise)) return Infinity;
  return rms - noise;
}

// ---------------------------------------------------------------------------
// Buffer generation
// ---------------------------------------------------------------------------

/**
 * Generate a silent Float32Array.
 *
 * @param {number} length     Number of samples.
 * @param {number} sampleRate Sample rate (kept for API symmetry / documentation).
 * @returns {Float32Array}
 */
export function generateSilence(length, sampleRate) {
  void sampleRate; // informational only
  return new Float32Array(length);
}

/**
 * Apply a linear fade-in and fade-out to avoid clicks.
 *
 * Modifies the array **in place** and also returns it.
 *
 * @param {Float32Array} data
 * @param {number}       fadeSamples Number of samples for each fade.
 * @returns {Float32Array}
 */
export function fadeInOut(data, fadeSamples) {
  if (!data || data.length === 0) return data;

  const len = data.length;
  const effectiveFade = Math.min(fadeSamples, Math.floor(len / 2));

  // Fade in.
  for (let i = 0; i < effectiveFade; i++) {
    data[i] *= i / effectiveFade;
  }

  // Fade out.
  for (let i = 0; i < effectiveFade; i++) {
    data[len - 1 - i] *= i / effectiveFade;
  }

  return data;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * Format seconds as "M:SS" or "H:MM:SS".
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';

  const totalSec = Math.round(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Format bytes as a human-readable size string.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  if (!isFinite(bytes) || bytes < 0) return '-- B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const value = bytes / Math.pow(k, i);

  return `${value < 10 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Content detection
// ---------------------------------------------------------------------------

/**
 * Heuristic content-type detection based on spectral characteristics.
 *
 * Analyses zero-crossing rate, spectral flatness, and crest factor
 * to classify the content as speech, music, mixed, or noise.
 *
 * @param {Float32Array} data
 * @param {number}       sampleRate
 * @returns {'speech'|'music'|'mixed'|'noise'}
 */
export function detectContentType(data, sampleRate) {
  if (!data || data.length === 0) return 'noise';

  const length = data.length;

  // -- Zero-crossing rate (ZCR) --
  let zeroCrossings = 0;
  for (let i = 1; i < length; i++) {
    if ((data[i] >= 0) !== (data[i - 1] >= 0)) {
      zeroCrossings++;
    }
  }
  const zcr = zeroCrossings / (length / sampleRate); // crossings per second

  // -- RMS and crest factor --
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < length; i++) {
    const abs = Math.abs(data[i]);
    sumSq += data[i] * data[i];
    if (abs > peak) peak = abs;
  }
  const rms = Math.sqrt(sumSq / length);
  const crestFactor = peak > 0 ? peak / rms : 0;

  // -- Spectral flatness approximation --
  // We compute the flatness over short frames using time-domain variance ratio.
  const frameSize = Math.min(2048, length);
  const numFrames = Math.floor(length / frameSize);
  let flatnessSum = 0;

  for (let f = 0; f < numFrames; f++) {
    const offset = f * frameSize;
    let frameSumSq = 0;
    let frameAbsSum = 0;

    for (let i = 0; i < frameSize; i++) {
      const v = Math.abs(data[offset + i]);
      frameSumSq += v * v;
      frameAbsSum += v;
    }

    const frameMean = frameAbsSum / frameSize;
    const frameRms = Math.sqrt(frameSumSq / frameSize);

    // Ratio approaching 1 = noise-like (flat spectrum), lower = tonal.
    const flatness = frameMean > 0 ? frameMean / frameRms : 0;
    flatnessSum += flatness;
  }

  const avgFlatness = numFrames > 0 ? flatnessSum / numFrames : 0;

  // -- Classification heuristics --
  // Noise: high spectral flatness, high ZCR, low crest factor.
  if (avgFlatness > 0.85 && crestFactor < 4) {
    return 'noise';
  }

  // Speech: moderate ZCR (1500-5000), moderate crest factor, lower flatness.
  // Music:  lower ZCR, higher crest factor or very low flatness (tonal).
  const isSpeechLikeZCR = zcr > 1000 && zcr < 6000;
  const isMusicLikeZCR = zcr < 2000;
  const isTonal = avgFlatness < 0.6;

  if (isSpeechLikeZCR && !isTonal && crestFactor > 3 && crestFactor < 15) {
    return 'speech';
  }

  if (isTonal && isMusicLikeZCR) {
    return 'music';
  }

  // Ambiguous cases.
  if (crestFactor > 5 && avgFlatness < 0.75) {
    return 'mixed';
  }

  // Default: if we cannot confidently classify, return 'mixed'.
  return 'mixed';
}
