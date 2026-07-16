/**
 * WhisperHunterAI — listen→process spectral separation engine
 * 100% local · no cloud · single-pass STFT compatible
 */
'use strict';

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

/** Map UI 0–100 to sigmoid DSP param centered at 50 */
export function mapWhisperUi(uiValue) {
  const ui = Math.max(0, Math.min(100, Number(uiValue) || 0));
  return sigmoid((ui - 50) / 15);
}

/** Detect runtime shell: desktop Electron, native Android, or browser */
export function detectWhisperPlatform() {
  if (typeof globalThis !== 'undefined' && globalThis.vipDesktop?.openFile) return 'desktop';
  const cap = typeof window !== 'undefined' ? window.Capacitor : null;
  if (cap?.isNativePlatform?.()) {
    const p = cap.getPlatform?.() || 'web';
    if (p === 'android') return 'android';
    if (p === 'ios') return 'ios';
  }
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '';
  if (/Android/i.test(ua)) return 'android';
  return 'browser';
}

/** Platform-tuned WhisperHunter limits (desktop / browser / Android WebView) */
export function getWhisperPlatformProfile(platform = detectWhisperPlatform()) {
  switch (platform) {
    case 'android':
      return {
        platform: 'android',
        maxChunks: 10,
        timeoutMs: 8000,
        chunkYieldMs: 4,
        mlEnabled: true,
        forensicCap: 3,
        minPasses: 1,
      };
    case 'ios':
      return {
        platform: 'ios',
        maxChunks: 10,
        timeoutMs: 8000,
        chunkYieldMs: 2,
        mlEnabled: true,
        forensicCap: 3,
        minPasses: 1,
      };
    case 'desktop':
      return {
        platform: 'desktop',
        maxChunks: 24,
        timeoutMs: 5000,
        chunkYieldMs: 0,
        mlEnabled: true,
        forensicCap: 4,
        minPasses: 1,
      };
    default:
      return {
        platform: 'browser',
        maxChunks: 18,
        timeoutMs: 4500,
        chunkYieldMs: 0,
        mlEnabled: true,
        forensicCap: 4,
        minPasses: 1,
      };
  }
}

/** Create or resync the global WhisperHunter instance for the active sample rate */
export function ensureWhisperHunterInstance(fftSize = 4096, sampleRate = 48000) {
  const sr = Math.max(8000, Math.min(192000, Number(sampleRate) || 48000));
  const bins = Math.max(64, Number(fftSize) || 4096);
  if (typeof window === 'undefined') {
    return new WhisperHunterAI(bins, sr);
  }
  const existing = window._vipWhisperHunter;
  if (existing && existing.sampleRate === sr && existing.fftSize === bins) {
    return existing;
  }
  const hunter = new WhisperHunterAI(bins, sr);
  window._vipWhisperHunter = hunter;
  return hunter;
}

/** Heuristic voice mask when ML worker is unavailable (offline-safe fallback) */
export function buildHeuristicMask(envProfile, halfBins = 2049) {
  const env = envProfile || {};
  const speech = Math.max(0, Math.min(1, env.speechPresence ?? env.voiceRatio ?? 0.3));
  const music = Math.max(0, Math.min(1, env.musicRatio ?? 0.2));
  // Stronger mid-band (formants) when speech dominates; suppress bass when music-heavy.
  const base = 0.32 + speech * 0.42;
  const voiceStart = Math.floor(halfBins * 0.06);
  const voiceEnd = Math.floor(halfBins * 0.48);
  const formantCore = Math.floor(halfBins * 0.12);
  const formantHi = Math.floor(halfBins * 0.32);
  const masks = new Array(halfBins);
  for (let i = 0; i < halfBins; i++) {
    let voiceWeight = 0.55;
    if (i >= voiceStart && i <= voiceEnd) voiceWeight = 1.05;
    if (i >= formantCore && i <= formantHi) voiceWeight = 1.28;
    // Soft-kill sub-bass when club/music dominates.
    if (i < Math.floor(halfBins * 0.04)) voiceWeight *= (1 - music * 0.55);
    // Soften extreme highs (hiss) slightly.
    if (i > Math.floor(halfBins * 0.55)) voiceWeight *= 0.82;
    masks[i] = Math.min(0.96, Math.max(0.04, base * voiceWeight));
  }
  return masks;
}

function _goertzelPower(data, offset, len, sampleRate, targetHz) {
  const k = Math.round(0.5 + (len * targetHz) / sampleRate);
  const w = (2 * Math.PI * k) / len;
  const cosine = Math.cos(w);
  const coeff = 2 * cosine;
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < len; i++) {
    const s = data[offset + i] || 0;
    q0 = coeff * q1 - q2 + s;
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * cosine;
  const imag = q2 * Math.sin(w);
  return (real * real + imag * imag) / Math.max(1, len);
}

/** Hann-windowed radix-2 FFT magnitude spectrum (worklet/test safe, no imports) */
function _frameMagnitude(data, offset, fftSize, halfN, _sampleRate = 48000) {
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / fftSize));
    re[i] = (data[offset + i] || 0) * w;
  }

  let j = 0;
  for (let i = 0; i < fftSize; i++) {
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
    let m = fftSize >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }

  for (let size = 2; size <= fftSize; size <<= 1) {
    const half = size >> 1;
    const step = (2 * Math.PI) / size;
    for (let i = 0; i < fftSize; i += size) {
      for (let k = 0; k < half; k++) {
        const angle = step * k;
        const wr = Math.cos(angle);
        const wi = -Math.sin(angle);
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }

  const mag = new Float32Array(halfN);
  for (let k = 0; k < halfN; k++) {
    mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k] + 1e-18);
  }
  return mag;
}

function _bandEnergyGoertzel(data, offset, len, sampleRate, freqs) {
  let sum = 0;
  for (let fi = 0; fi < freqs.length; fi++) {
    sum += _goertzelPower(data, offset, len, sampleRate, freqs[fi]);
  }
  return sum / freqs.length;
}

/** Multi-frame spectral analysis for WhisperHunter environment profiling */
export function analyzeAcousticEnvironment(buffer) {
  if (!buffer || !buffer.getChannelData) {
    return { rt60: 400, dominantNoise: 'crowd', noiseFloor: -40, speechPresence: 0.5, voiceRatio: 0.3, musicRatio: 0.2 };
  }
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);
  const analyzeLen = Math.min(data.length, Math.floor(sr * 1.5));
  const FFT = 2048;
  const hop = FFT / 2;
  const maxFrames = 8;
  const bassFreqs = [60, 90, 120];
  const midFreqs = [400, 800, 1500, 2200];
  const highFreqs = [3500, 5000, 7000];
  const voiceFreqs = [300, 500, 800, 1200, 1800, 2600, 3200];

  let bass = 0;
  let mid = 0;
  let high = 0;
  let voice = 0;
  let frames = 0;
  for (let off = 0; off + FFT <= analyzeLen && frames < maxFrames; off += hop * 2) {
    bass += _bandEnergyGoertzel(data, off, FFT, sr, bassFreqs);
    mid += _bandEnergyGoertzel(data, off, FFT, sr, midFreqs);
    high += _bandEnergyGoertzel(data, off, FFT, sr, highFreqs);
    voice += _bandEnergyGoertzel(data, off, FFT, sr, voiceFreqs);
    frames++;
  }
  if (frames > 0) {
    bass /= frames;
    mid /= frames;
    high /= frames;
    voice /= frames;
  }
  const total = bass + mid + high + voice + 1e-12;

  let rms = 0;
  for (let i = 0; i < analyzeLen; i++) rms += data[i] * data[i];
  rms = Math.sqrt(rms / Math.max(1, analyzeLen));
  const noiseFloor = 20 * Math.log10(rms + 1e-12);

  let rt60 = 400;
  let peak = 0;
  let peakIdx = 0;
  for (let i = 0; i < analyzeLen; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) { peak = a; peakIdx = i; }
  }
  const thresh = peak * 0.01;
  for (let i = peakIdx; i < analyzeLen; i++) {
    if (Math.abs(data[i]) < thresh) {
      rt60 = ((i - peakIdx) / sr) * 1000;
      break;
    }
  }

  const voiceRatio = voice / (total + 1e-12);
  const musicRatio = bass / (mid + bass + 1e-12);
  const speechPresence = Math.min(1, voiceRatio * 2.2);

  let dominantNoise = 'crowd';
  if (musicRatio > 0.55 && bass > mid * 0.9) dominantNoise = 'music';
  else if (mid > bass * 1.15) dominantNoise = 'crowd';
  else if (rt60 < 200) dominantNoise = 'hum';
  else if (high > mid * 0.45) dominantNoise = 'traffic';

  return {
    rt60: Math.round(rt60),
    dominantNoise,
    noiseFloor,
    speechPresence,
    voiceRatio,
    musicRatio,
  };
}

/** Aggregate ML mask confidence from per-bin mask values */
export function maskConfidence(masks) {
  if (!masks || !masks.length) return 0.35;
  let sum = 0;
  let voiceSum = 0;
  let voiceCount = 0;
  const voiceStart = Math.floor(masks.length * 0.08);
  const voiceEnd = Math.floor(masks.length * 0.45);
  for (let i = 0; i < masks.length; i++) {
    const v = Math.max(0, Math.min(1, Number(masks[i]) || 0));
    sum += v;
    if (i >= voiceStart && i <= voiceEnd) {
      voiceSum += v;
      voiceCount++;
    }
  }
  const globalAvg = sum / masks.length;
  const voiceAvg = voiceCount > 0 ? voiceSum / voiceCount : globalAvg;
  return voiceAvg * 0.7 + globalAvg * 0.3;
}

/** Chunked BSRNN mask inference across the file (local worker) */
export async function chunkedMaskInference(audioBuffer, worker, options = {}) {
  const masks = [];
  if (!audioBuffer || !worker || options.mlEnabled === false) return masks;
  if (typeof audioBuffer.getChannelData !== 'function') return masks;

  const data = audioBuffer.getChannelData(0);
  if (!data || !data.length) return masks;

  const sr = Math.max(8000, audioBuffer.sampleRate || 48000);
  const FFT = options.fftSize || 4096;
  const halfN = FFT / 2 + 1;
  const hop = options.hop || Math.floor(FFT / 2);
  const maxChunks = Math.max(1, options.maxChunks || 12);
  const timeoutMs = Math.max(500, options.timeoutMs || 6000);
  const chunkYieldMs = Math.max(0, options.chunkYieldMs || 0);
  const callIdBase = options.callIdBase || 0;

  const positions = [];
  for (let off = 0; off + FFT <= data.length && positions.length < maxChunks; off += hop * 4) {
    positions.push(off);
  }
  if (!positions.length && data.length >= FFT / 4) positions.push(0);

  for (let ci = 0; ci < positions.length; ci++) {
    if (chunkYieldMs > 0 && ci > 0) {
      await new Promise((resolve) => setTimeout(resolve, chunkYieldMs));
    }
    const off = positions[ci];
    const mag = _frameMagnitude(data, off, FFT, halfN, sr);
    const id = callIdBase + ci + 1;
    try {
      const result = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          worker.removeEventListener('message', handler);
          clearTimeout(timer);
          resolve(value);
        };
        const handler = (ev) => {
          if (ev.data && ev.data.type === 'maskResult' && ev.data.id === id) {
            finish(ev.data.mask || mag);
          }
        };
        worker.addEventListener('message', handler);
        const magClone = mag.slice();
        try {
          worker.postMessage(
            { type: 'infer', model: 'bsrnn', mag: magClone.buffer, id },
            [magClone.buffer]
          );
        } catch (_postErr) {
          finish(mag);
          return;
        }
        const timer = setTimeout(() => finish(mag), timeoutMs);
      });
      if (result instanceof Float32Array) masks.push(...result);
      else if (Array.isArray(result)) masks.push(...result);
    } catch (_) {
      let peak = 0;
      for (let i = 0; i < halfN; i++) if (mag[i] > peak) peak = mag[i];
      for (let i = 0; i < halfN; i++) masks.push(mag[i] / (peak + 1e-9));
    }
  }
  return masks;
}

export class WhisperHunterAI {
  constructor(fftSize = 4096, sampleRate = 48000) {
    this.fftSize = fftSize;
    this.sampleRate = sampleRate;
    this.halfBins = fftSize / 2 + 1;
    this.noiseFloor = 0;
    this.noisePsd = new Float32Array(this.halfBins);
    this._alpha = 0.90;
    this._speechAlpha = 0.985;
    this._f0Est = 180;
    this._binHz = sampleRate / fftSize;
    // Broader band catches whispered fricatives (~200–5.5 kHz).
    this._voiceLo = Math.round(200 / this._binHz);
    this._voiceHi = Math.round(5500 / this._binHz);
    this._formantLo = Math.round(400 / this._binHz);
    this._formantHi = Math.round(3200 / this._binHz);
    this._epsilon = 1e-10;
    this._prevVad = 0;
    this._hangover = 0;
  }

  reset() {
    this.noiseFloor = 0;
    this.noisePsd.fill(0);
    this._f0Est = 180;
    this._prevVad = 0;
    this._hangover = 0;
  }

  /** Seed noise PSD from quiet frames at the start of a buffer (between forensic passes) */
  seedNoiseFromAudio(data, sampleRate = this.sampleRate) {
    if (!data || !data.length) return 0;
    const sr = Math.max(8000, Number(sampleRate) || this.sampleRate);
    if (sr !== this.sampleRate) {
      this.sampleRate = sr;
      this._binHz = sr / this.fftSize;
      this._voiceLo = Math.round(200 / this._binHz);
      this._voiceHi = Math.round(5500 / this._binHz);
      this._formantLo = Math.round(400 / this._binHz);
      this._formantHi = Math.round(3200 / this._binHz);
    }
    const FFT = this.fftSize;
    const halfN = this.halfBins;
    const hop = FFT / 2;
    const analyzeLen = Math.min(data.length, Math.floor(sr * 1.5));
    let seeded = 0;
    for (let off = 0; off + FFT <= analyzeLen; off += hop) {
      const mags = _frameMagnitude(data, off, FFT, halfN, sr);
      let energy = 0;
      for (let k = 0; k < halfN; k++) energy += mags[k] * mags[k];
      energy /= halfN;
      if (energy < this.noiseFloor * 2.5 || this.noiseFloor === 0) {
        this.noiseFloor = this._alpha * this.noiseFloor + (1 - this._alpha) * energy;
        for (let k = 0; k < halfN; k++) {
          this.noisePsd[k] = this._alpha * this.noisePsd[k] + (1 - this._alpha) * mags[k] * mags[k];
        }
        seeded++;
      }
    }
    return seeded;
  }

  _trackF0(mags) {
    const binHz = this._binHz;
    const f0Lo = Math.max(1, Math.round(80 / binHz));
    const f0Hi = Math.min(this.halfBins - 1, Math.round(420 / binHz));
    let peak = 0;
    let peakBin = 0;
    for (let k = f0Lo; k <= f0Hi; k++) {
      if (mags[k] > peak) { peak = mags[k]; peakBin = k; }
    }
    if (peak > 1e-8) {
      const f0 = peakBin * binHz;
      this._f0Est = 0.82 * this._f0Est + 0.18 * f0;
    }
  }

  /**
   * Process one STFT frame in-place on complex spectrum.
   * @returns {number} vad flag 0|1
   */
  processFrame(re, im, params = {}) {
    const halfN = this.halfBins;
    const pClarity = params.clarity ?? 0.5;
    const pSensitive = params.sensitivity ?? 0.5;
    const pThreshold = params.threshold ?? 0.5;
    const pHarmonic = params.harmonic ?? 0;

    let energy = 0;
    let voiceEnergy = 0;
    let formantEnergy = 0;
    let geoSum = 0;
    let arithSum = 0;
    const mags = new Float32Array(halfN);

    for (let k = 0; k < halfN; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      mags[k] = mag;
      const pow = mag * mag;
      energy += pow;
      if (k >= this._voiceLo && k <= this._voiceHi) {
        voiceEnergy += pow;
        arithSum += mag;
        geoSum += Math.log(mag + 1e-12);
      }
      if (k >= this._formantLo && k <= this._formantHi) formantEnergy += pow;
    }
    energy /= halfN;
    const voiceRatio = voiceEnergy / (energy * halfN + this._epsilon);
    const formantRatio = formantEnergy / (voiceEnergy + this._epsilon);
    const voiceBins = Math.max(1, this._voiceHi - this._voiceLo);
    const flatness = arithSum > 1e-12
      ? Math.exp(geoSum / voiceBins) / (arithSum / voiceBins + 1e-12)
      : 1;

    // Adaptive VAD: lower energy gate for whispers, hangover to keep phrase tails.
    const thetaE = Math.max(this.noiseFloor * (0.35 + 0.45 * pSensitive), 1e-13);
    const voiceGate = 0.08 + 0.18 * (1 - pSensitive);
    const flatGate = 0.48 + 0.16 * pSensitive;
    const formantGate = 0.18 + 0.12 * pSensitive;
    let vad = (energy > thetaE * 0.04)
      && (voiceRatio > voiceGate)
      && (flatness < flatGate || formantRatio > formantGate) ? 1 : 0;

    // Hangover: keep gate open ~3 frames after speech to avoid chopping whispers.
    if (vad) {
      this._hangover = 3;
    } else if (this._hangover > 0) {
      this._hangover -= 1;
      vad = 1;
    }
    this._prevVad = vad;

    const alpha = vad ? this._speechAlpha : this._alpha;
    if (vad === 0) {
      this.noiseFloor = alpha * this.noiseFloor + (1 - alpha) * energy;
      for (let k = 0; k < halfN; k++) {
        this.noisePsd[k] = alpha * this.noisePsd[k] + (1 - alpha) * mags[k] * mags[k];
      }
      return 0;
    }

    this._trackF0(mags);

    // Soft Wiener + formant emphasis — clearer whispers without musical noise.
    const wStr = 0.85 + 1.9 * pThreshold;
    const oversub = 1.05 + 2.4 * pThreshold;
    const minGain = Math.max(0.06, pClarity * 0.42);
    const binHz = this._binHz;

    for (let k = 0; k < halfN; k++) {
      const sigPow = mags[k] * mags[k];
      const noisePow = this.noisePsd[k] + this._epsilon;
      const snrNum = Math.max(0, sigPow - oversub * noisePow);
      const wiener = snrNum / (sigPow + 0.015 * noisePow);
      let gain = Math.pow(Math.max(0, wiener), wStr);

      const inVoice = k >= this._voiceLo && k <= this._voiceHi;
      const inFormant = k >= this._formantLo && k <= this._formantHi;
      const outBandWeight = inVoice ? 1 : 0.22 + 0.28 * (1 - pThreshold);
      gain = Math.max(minGain * outBandWeight, gain);

      if (inFormant && voiceRatio > 0.12) {
        gain = Math.min(2.1, gain * (1 + 0.28 * pClarity));
      } else if (inVoice && voiceRatio > 0.18) {
        gain = Math.min(1.85, gain * (1 + 0.18 * pClarity));
      }

      // Spectral floor tilt: protect low formants for whispered vowels.
      if (k < this._formantLo && k > 0) {
        gain = Math.max(gain, minGain * 0.55);
      }

      re[k] *= gain;
      im[k] *= gain;
    }

    if (pHarmonic > 0.06) {
      const maxH = pHarmonic > 0.4 ? 8 : 6;
      for (let h = 1; h <= maxH; h++) {
        const kh = Math.round((h * this._f0Est) / binHz);
        for (let dk = -1; dk <= 1; dk++) {
          const k = kh + dk;
          if (k > 0 && k < halfN) {
            const boost = 1 + (pHarmonic * 0.48) / h;
            re[k] *= boost;
            im[k] *= boost;
          }
        }
      }
    }

    return 1;
  }

  processMagnitudes(mag, pha, params) {
    const halfN = mag.length;
    const re = new Float32Array(halfN);
    const im = new Float32Array(halfN);
    for (let k = 0; k < halfN; k++) {
      re[k] = mag[k] * Math.cos(pha[k]);
      im[k] = mag[k] * Math.sin(pha[k]);
    }
    const vad = this.processFrame(re, im, params);
    for (let k = 0; k < halfN; k++) {
      mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    return vad;
  }
}

if (typeof window !== 'undefined') {
  window.WhisperHunterAI = WhisperHunterAI;
  window.mapWhisperUi = mapWhisperUi;
  window.analyzeAcousticEnvironment = analyzeAcousticEnvironment;
  window.chunkedMaskInference = chunkedMaskInference;
  window.maskConfidence = maskConfidence;
  window.detectWhisperPlatform = detectWhisperPlatform;
  window.getWhisperPlatformProfile = getWhisperPlatformProfile;
  window.ensureWhisperHunterInstance = ensureWhisperHunterInstance;
  window.buildHeuristicMask = buildHeuristicMask;
}