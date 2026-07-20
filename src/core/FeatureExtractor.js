/**
 * VoiceIsolate Pro — Classical Feature Extractor (Layer 1: Core)
 *
 * Frame-level and global DSP features for full-audio analysis.
 * Pure module: no DOM, no Web Audio, no I/O.
 */
'use strict';

export const DEFAULT_FRAME_SEC = 0.025;
export const DEFAULT_HOP_SEC = 0.01;

/**
 * @param {Float32Array} samples mono
 * @returns {{ rms: number, peak: number, rmsDb: number, peakDb: number }}
 */
export function globalLevels(samples) {
  if (!samples || samples.length === 0) {
    return { rms: 0, peak: 0, rmsDb: -120, peakDb: -120 };
  }
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    sumSq += samples[i] * samples[i];
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sumSq / samples.length);
  return {
    rms,
    peak,
    rmsDb: 20 * Math.log10(rms + 1e-12),
    peakDb: 20 * Math.log10(peak + 1e-12),
  };
}

/**
 * Zero-crossing rate in [0, 0.5].
 * @param {Float32Array} frame
 */
export function zeroCrossingRate(frame) {
  if (!frame || frame.length < 2) return 0;
  let zc = 0;
  for (let i = 1; i < frame.length; i++) {
    if ((frame[i] >= 0) !== (frame[i - 1] >= 0)) zc++;
  }
  return zc / (2 * frame.length);
}

/**
 * Simple real FFT magnitude (radix-2 Cooley–Tukey, power-of-two n).
 * Returns length n/2+1 magnitudes.
 * @param {Float32Array} frame
 * @returns {Float32Array}
 */
export function magnitudeSpectrum(frame) {
  const n = nextPow2(frame.length);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < frame.length; i++) re[i] = frame[i];
  fftInPlace(re, im);
  const half = (n >> 1) + 1;
  const mag = new Float32Array(half);
  for (let k = 0; k < half; k++) {
    mag[k] = Math.hypot(re[k], im[k]);
  }
  return mag;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return Math.max(p, 32);
}

function fftInPlace(re, im) {
  const n = re.length;
  // bit reverse
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + half] * wRe - im[i + j + half] * wIm;
        const vIm = re[i + j + half] * wIm + im[i + j + half] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;
        const nwRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nwRe;
      }
    }
  }
}

/**
 * Spectral shape features from a magnitude spectrum.
 * @param {Float32Array} mag
 * @param {number} sampleRate
 */
export function spectralShape(mag, sampleRate) {
  const n = mag.length;
  if (!n) {
    return {
      centroid: 0, flatness: 0, rolloff: 0, bandwidth: 0, fluxPrev: null,
    };
  }
  let sum = 0;
  let weighted = 0;
  let logSum = 0;
  for (let k = 0; k < n; k++) {
    const m = mag[k] + 1e-12;
    sum += m;
    weighted += m * k;
    logSum += Math.log(m);
  }
  const centroidBin = sum > 0 ? weighted / sum : 0;
  const binHz = sampleRate / (2 * (n - 1 || 1));
  const centroid = centroidBin * binHz;

  const geo = Math.exp(logSum / n);
  const arith = sum / n;
  const flatness = arith > 0 ? Math.min(1, geo / arith) : 0;

  // 85% energy rolloff
  const target = sum * 0.85;
  let acc = 0;
  let rollBin = n - 1;
  for (let k = 0; k < n; k++) {
    acc += mag[k];
    if (acc >= target) { rollBin = k; break; }
  }
  const rolloff = rollBin * binHz;

  // Bandwidth around centroid
  let bw = 0;
  for (let k = 0; k < n; k++) {
    const d = k - centroidBin;
    bw += mag[k] * d * d;
  }
  const bandwidth = Math.sqrt(bw / (sum + 1e-12)) * binHz;

  return { centroid, flatness, rolloff, bandwidth, binHz };
}

/**
 * Spectral flux vs previous magnitude frame (L1 of positive diffs).
 * @param {Float32Array} mag
 * @param {Float32Array|null} prev
 */
export function spectralFlux(mag, prev) {
  if (!prev || prev.length !== mag.length) return 0;
  let f = 0;
  for (let k = 0; k < mag.length; k++) {
    const d = mag[k] - prev[k];
    if (d > 0) f += d;
  }
  return f / mag.length;
}

/**
 * Speech-band energy ratio (300–3400 Hz) vs total.
 * @param {Float32Array} mag
 * @param {number} sampleRate
 */
export function speechBandRatio(mag, sampleRate) {
  const n = mag.length;
  if (!n) return 0;
  const binHz = sampleRate / (2 * (n - 1 || 1));
  let speech = 0;
  let total = 0;
  for (let k = 0; k < n; k++) {
    const hz = k * binHz;
    const e = mag[k] * mag[k];
    total += e;
    if (hz >= 300 && hz <= 3400) speech += e;
  }
  return total > 0 ? speech / total : 0;
}

/**
 * Harmonicity heuristic: ratio of energy near integer multiples of a
 * dominant fundamental estimate in the pitch range.
 * @param {Float32Array} mag
 * @param {number} sampleRate
 */
export function harmonicityScore(mag, sampleRate) {
  const n = mag.length;
  if (n < 8) return 0;
  const binHz = sampleRate / (2 * (n - 1 || 1));
  // Find peak in 80–400 Hz as f0 candidate
  let bestK = 1;
  let bestM = 0;
  const kLo = Math.max(1, Math.floor(80 / binHz));
  const kHi = Math.min(n - 1, Math.ceil(400 / binHz));
  for (let k = kLo; k <= kHi; k++) {
    if (mag[k] > bestM) { bestM = mag[k]; bestK = k; }
  }
  if (bestM < 1e-9) return 0;
  const f0 = bestK * binHz;
  let harm = 0;
  let total = 0;
  for (let h = 1; h <= 6; h++) {
    const hz = f0 * h;
    const k = Math.round(hz / binHz);
    if (k < 1 || k >= n) continue;
    // ±1 bin
    for (let d = -1; d <= 1; d++) {
      const kk = k + d;
      if (kk > 0 && kk < n) harm += mag[kk];
    }
  }
  for (let k = 1; k < n; k++) total += mag[k];
  return total > 0 ? Math.min(1, harm / total) : 0;
}

/**
 * Hum detection: relative energy at 50/60 Hz and harmonics.
 * @param {Float32Array} mag
 * @param {number} sampleRate
 */
export function detectHum(mag, sampleRate) {
  const binHz = sampleRate / (2 * (mag.length - 1 || 1));
  const scoreAt = (base) => {
    let s = 0;
    for (let h = 1; h <= 5; h++) {
      const k = Math.round((base * h) / binHz);
      if (k > 0 && k < mag.length) s += mag[k];
    }
    return s;
  };
  let total = 0;
  for (let k = 1; k < mag.length; k++) total += mag[k];
  const s50 = scoreAt(50);
  const s60 = scoreAt(60);
  const best = Math.max(s50, s60);
  const strength = total > 0 ? best / total : 0;
  return {
    present: strength > 0.08,
    freq: s60 >= s50 ? 60 : 50,
    strength: Math.min(1, strength * 4),
  };
}

/**
 * Voiced / unvoiced heuristic from ZCR + harmonicity + speech ratio.
 */
export function voicedUnvoicedScore({ zcr, harmonicity, speechRatio }) {
  const voiced = Math.max(0, Math.min(1,
    0.45 * harmonicity + 0.35 * speechRatio + 0.2 * (1 - Math.min(1, zcr * 4)),
  ));
  return { voiced, unvoiced: 1 - voiced };
}

/**
 * Extract per-frame feature series from mono audio.
 * @param {Float32Array} mono
 * @param {number} sampleRate
 * @param {object} [opts]
 */
export function extractFrameFeatures(mono, sampleRate, opts = {}) {
  const frameSec = opts.frameSec ?? DEFAULT_FRAME_SEC;
  const hopSec = opts.hopSec ?? DEFAULT_HOP_SEC;
  const frameLen = Math.max(32, Math.round(frameSec * sampleRate));
  const hop = Math.max(16, Math.round(hopSec * sampleRate));
  const frames = [];
  let prevMag = null;
  let prevFlux = 0;

  for (let start = 0; start + frameLen <= mono.length; start += hop) {
    const frame = mono.subarray(start, start + frameLen);
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < frame.length; i++) {
      sumSq += frame[i] * frame[i];
      const a = Math.abs(frame[i]);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sumSq / frame.length);
    const zcr = zeroCrossingRate(frame);
    const mag = magnitudeSpectrum(frame);
    const shape = spectralShape(mag, sampleRate);
    const flux = spectralFlux(mag, prevMag);
    const speechRatio = speechBandRatio(mag, sampleRate);
    const harmonicity = harmonicityScore(mag, sampleRate);
    const hum = detectHum(mag, sampleRate);
    const vu = voicedUnvoicedScore({ zcr, harmonicity, speechRatio });

    frames.push({
      t: start / sampleRate,
      rms,
      peak,
      rmsDb: 20 * Math.log10(rms + 1e-12),
      zcr,
      centroid: shape.centroid,
      flatness: shape.flatness,
      rolloff: shape.rolloff,
      bandwidth: shape.bandwidth,
      flux,
      speechRatio,
      harmonicity,
      humStrength: hum.strength,
      humFreq: hum.freq,
      voiced: vu.voiced,
    });

    prevFlux = flux;
    prevMag = mag;
  }

  // Noise floor estimate: percentile of low-energy frames
  const rmsSorted = frames.map((f) => f.rms).sort((a, b) => a - b);
  const p10 = rmsSorted[Math.floor(rmsSorted.length * 0.1)] || 0;
  const noiseFloor = p10;
  const signalRms = globalLevels(mono).rms;
  const snrDb = 20 * Math.log10((signalRms + 1e-12) / (noiseFloor + 1e-12));

  // Reverb / decay estimate: average decay of RMS after high-flux onsets
  let decaySum = 0;
  let decayN = 0;
  for (let i = 1; i < frames.length - 5; i++) {
    if (frames[i].flux > prevFlux * 2 && frames[i].flux > 0.01) {
      const r0 = frames[i].rms + 1e-12;
      const r1 = frames[i + 4].rms + 1e-12;
      decaySum += Math.max(0, Math.log(r0 / r1));
      decayN++;
    }
  }
  const reverbEstimate = decayN > 0 ? Math.min(1, decaySum / decayN / 2) : 0;

  // Aggregate hum
  let humStrength = 0;
  let humFreqVotes = { 50: 0, 60: 0 };
  for (const f of frames) {
    humStrength = Math.max(humStrength, f.humStrength);
    if (f.humStrength > 0.05) humFreqVotes[f.humFreq] = (humFreqVotes[f.humFreq] || 0) + 1;
  }
  const humFreq = (humFreqVotes[60] || 0) >= (humFreqVotes[50] || 0) ? 60 : 50;

  return {
    frames,
    frameSec,
    hopSec,
    noiseFloor,
    snrDb,
    reverbEstimate,
    humProfile: {
      present: humStrength > 0.08,
      freq: humFreq,
      strength: Math.min(1, humStrength),
    },
    global: globalLevels(mono),
  };
}

/**
 * Downmix multi-channel to mono.
 * @param {Float32Array[]} channels
 */
export function downmixToMono(channels) {
  if (!channels || channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  const inv = 1 / channels.length;
  for (let ch = 0; ch < channels.length; ch++) {
    const c = channels[ch];
    for (let i = 0; i < n; i++) out[i] += c[i] * inv;
  }
  return out;
}

export default {
  globalLevels,
  zeroCrossingRate,
  magnitudeSpectrum,
  spectralShape,
  spectralFlux,
  speechBandRatio,
  harmonicityScore,
  detectHum,
  voicedUnvoicedScore,
  extractFrameFeatures,
  downmixToMono,
};
