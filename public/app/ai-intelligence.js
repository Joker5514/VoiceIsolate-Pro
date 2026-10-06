/* ============================================
   VoiceIsolate Pro v24.0 — AI Intelligence Module
   Threads from Space v13 · Smart Audio Analysis
   Adaptive noise floor · Auto-preset selection
   Voice activity confidence · Scene detection
   ============================================ */
'use strict';

/**
 * AI Intelligence Module — v21.0
 *
 * Provides smart analysis capabilities on top of the core DSP pipeline:
 * - Adaptive noise floor estimation (MCRA algorithm)
 * - Automatic preset recommendation based on audio content
 * - Voice activity confidence scoring
 * - Audio scene classification (podcast, interview, music, etc.)
 * - Real-time SNR tracking and quality metrics
 * - Intelligent parameter auto-tuning
 */
const AIIntelligence = {

  // ── MCRA Noise Floor Estimator ─────────────────────────────────────────
  /**
   * Minimum Controlled Recursive Averaging (MCRA) noise floor estimation.
   * More accurate than simple min-tracking; adapts to non-stationary noise.
   *
   * Reference: Cohen & Berdugo (2002) "Noise estimation by minima controlled
   * recursive averaging for robust speech enhancement"
   *
   * @param {Float32Array[]} magFrames - STFT magnitude frames
   * @param {Object} opts - { alpha: 0.92, alphaS: 0.9, delta: 5, L: 125 }
   * @returns {Float32Array} estimated noise magnitude per frequency bin
   */
  estimateNoiseFloorMCRA(magFrames, opts = {}) {
    const alpha  = opts.alpha  ?? 0.92;   // smoothing factor for noise estimate
    const alphaS = opts.alphaS ?? 0.9;    // smoothing for speech presence prob
    const delta  = opts.delta  ?? 5;      // speech presence threshold (linear)
    const L      = opts.L      ?? 125;    // min-tracking window (frames)

    if (!magFrames || magFrames.length === 0) return new Float32Array(0);
    const bins = magFrames[0].length;
    const nFrames = magFrames.length;

    // Initialize
    const noiseEst  = new Float32Array(bins);
    const smoothPow = new Float32Array(bins);
    const minBuf    = [];  // circular buffer for minimum tracking
    const speechProb = new Float32Array(bins);

    // Seed with first frame
    for (let k = 0; k < bins; k++) {
      noiseEst[k]  = magFrames[0][k] * magFrames[0][k];
      smoothPow[k] = noiseEst[k];
    }

    for (let f = 0; f < nFrames; f++) {
      const frame = magFrames[f];

      // Update smoothed power spectrum
      for (let k = 0; k < bins; k++) {
        const pow = frame[k] * frame[k];
        smoothPow[k] = alphaS * smoothPow[k] + (1 - alphaS) * pow;
      }

      // Store for minimum tracking
      minBuf.push(new Float32Array(smoothPow));
      if (minBuf.length > L) minBuf.shift();

      // Find minimum over L frames
      const minPow = new Float32Array(bins).fill(Infinity);
      for (const buf of minBuf) {
        for (let k = 0; k < bins; k++) {
          if (buf[k] < minPow[k]) minPow[k] = buf[k];
        }
      }

      // Update speech presence probability
      for (let k = 0; k < bins; k++) {
        const ratio = smoothPow[k] / (minPow[k] + 1e-10);
        const indicator = ratio > delta ? 1 : 0;
        speechProb[k] = alphaS * speechProb[k] + (1 - alphaS) * indicator;
      }

      // Update noise estimate
      for (let k = 0; k < bins; k++) {
        const alphaD = alpha + (1 - alpha) * speechProb[k];
        const pow = frame[k] * frame[k];
        noiseEst[k] = alphaD * noiseEst[k] + (1 - alphaD) * pow;
      }
    }

    // Return RMS of noise estimate
    const result = new Float32Array(bins);
    for (let k = 0; k < bins; k++) result[k] = Math.sqrt(Math.max(noiseEst[k], 0));
    return result;
  },

  // ── Audio Scene Classifier ─────────────────────────────────────────────
  /**
   * Classify audio scene from spectral features.
   * Returns confidence scores for each preset category.
   *
   * @param {Float32Array} audio - mono audio samples
   * @param {number} sr - sample rate
   * @returns {{ scene: string, confidence: number, scores: Object }}
   */
  classifyScene(audio, sr = 48000) {
    if (audio.length < 1024) return this._defaultScene();
    const rms = this._calcRMS(audio);
    const peak = this._calcPeak(audio);
    return this._classifyFromFeatures({
      rms,
      peak,
      crestFactor: peak / (rms + 1e-10),
      zcr: this._calcZCR(audio),
      spectralCentroid: this._calcSpectralCentroid(audio, sr),
      spectralFlux: this._calcSpectralFlux(audio),
      dynamicRange: this._calcDynamicRange(audio),
    });
  },

  /**
   * classifyScene over the whole track without blocking the main thread:
   * the same features from every sample, accumulated in chunks with
   * `opts.yieldBudget` awaited between them. Results equal classifyScene.
   * @param {Float32Array} audio
   * @param {number} sr
   * @param {{ yieldBudget?: () => Promise<void> }} [opts]
   */
  async classifySceneAsync(audio, sr = 48000, opts = {}) {
    if (audio.length < 1024) return this._defaultScene();
    if (!(audio instanceof Float32Array)) return this.classifyScene(audio, sr);
    const yieldBudget = opts.yieldBudget || this._defaultYieldBudget();
    const n = audio.length;
    const CHUNK = 1 << 17;
    const bits = new Uint32Array(audio.buffer, audio.byteOffset, n);
    const hi = new Uint32Array(65536);
    // Pass 1: RMS, peak, ZCR and the high-bits histogram for the percentiles.
    let sumSq = 0;
    let peak = 0;
    let crossings = 0;
    for (let start = 0; start < n; start += CHUNK) {
      const end = Math.min(n, start + CHUNK);
      for (let i = start; i < end; i++) {
        const v = audio[i];
        sumSq += v * v;
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
        if (i > 0 && (v >= 0) !== (audio[i - 1] >= 0)) crossings++;
        hi[(bits[i] & 0x7fffffff) >>> 15]++;
      }
      await yieldBudget();
    }
    // Pass 2: resolve the 5th/95th percentile of |x| (as _absOrderStats).
    const targets = [Math.floor(0.05 * n), Math.floor(0.95 * n)].map((k) => {
      let acc = 0;
      let bucket = 0;
      while (acc + hi[bucket] <= k) acc += hi[bucket++];
      return { bucket, rank: k - acc, lo: new Uint32Array(32768) };
    });
    for (let start = 0; start < n; start += CHUNK) {
      const end = Math.min(n, start + CHUNK);
      for (let i = start; i < end; i++) {
        const b = bits[i] & 0x7fffffff;
        const bucket = b >>> 15;
        for (const t of targets) if (t.bucket === bucket) t.lo[b & 0x7fff]++;
      }
      await yieldBudget();
    }
    const word = new Uint32Array(1);
    const asFloat = new Float32Array(word.buffer);
    const [p05raw, p95] = targets.map((t) => {
      let acc = 0;
      let low = 0;
      while (acc + t.lo[low] <= t.rank) acc += t.lo[low++];
      word[0] = (t.bucket << 15) | low;
      return asFloat[0];
    });
    const rms = Math.sqrt(sumSq / n);
    return this._classifyFromFeatures({
      rms,
      peak,
      crestFactor: peak / (rms + 1e-10),
      zcr: crossings / n,
      spectralCentroid: this._calcSpectralCentroid(audio, sr),
      spectralFlux: this._calcSpectralFlux(audio),
      dynamicRange: 20 * Math.log10(p95 / (p05raw + 1e-10)),
    });
  },

  /**
   * Fallback yield for classifySceneAsync: a real macrotask (so input and
   * paint run between chunks) at most once per ~10 ms of work. A resolved
   * promise would only resume as a microtask and never let the browser in.
   */
  _defaultYieldBudget() {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    let last = now();
    return async () => {
      if (now() - last < 10) return;
      await new Promise((resolve) => setTimeout(resolve, 0));
      last = now();
    };
  },

  _defaultScene() {
    return { scene: 'podcast', confidence: 0.5, scores: {}, features: { rms: 0, peak: 0, crestFactor: 0, zcr: 0, spectralCentroid: 0, spectralFlux: 0, dynamicRange: 0 } };
  },

  _classifyFromFeatures(features) {
    const { rms, peak, crestFactor, zcr, spectralCentroid, spectralFlux, dynamicRange } = features;

    // Heuristic scoring for each scene type
    const scores = {};

    // Podcast: speech-dominant, moderate dynamics, mid-range centroid
    scores.podcast = this._score([
      [spectralCentroid, 800, 3000, 1.0],   // centroid in speech range
      [crestFactor, 3, 12, 0.8],             // moderate crest factor
      [dynamicRange, 15, 35, 0.6],           // moderate dynamic range
      [zcr, 0.05, 0.25, 0.5],               // moderate ZCR
    ]);

    // Interview: similar to podcast but often with background noise
    scores.interview = this._score([
      [spectralCentroid, 600, 2500, 1.0],
      [crestFactor, 4, 15, 0.8],
      [dynamicRange, 20, 45, 0.7],
      [zcr, 0.04, 0.20, 0.5],
    ]);

    // Music: wide frequency range, high dynamic range, high spectral flux
    scores.music = this._score([
      [spectralCentroid, 1000, 8000, 1.0],
      [spectralFlux, 0.3, 1.0, 0.9],
      [dynamicRange, 30, 70, 0.8],
      [crestFactor, 6, 20, 0.6],
    ]);

    // Broadcast: tight dynamics, high intelligibility
    scores.broadcast = this._score([
      [spectralCentroid, 1000, 4000, 1.0],
      [dynamicRange, 8, 20, 0.9],
      [crestFactor, 2, 8, 0.8],
      [zcr, 0.06, 0.30, 0.5],
    ]);

    // Whisper: very low RMS, breathy dynamics, speech-band centroid
    scores.whisper = this._score([
      [rms, 0.003, 0.025, 1.0],
      [crestFactor, 8, 28, 0.8],
      [spectralCentroid, 700, 3500, 0.9],
      [dynamicRange, 20, 55, 0.6],
    ]);

    // Forensic: often degraded audio, wide noise floor
    scores.forensic = this._score([
      [crestFactor, 10, 30, 1.0],
      [dynamicRange, 40, 80, 0.9],
      [spectralFlux, 0.1, 0.5, 0.7],
    ]);

    // Film: wide dynamic range, mixed content
    scores.film = this._score([
      [dynamicRange, 40, 80, 1.0],
      [spectralFlux, 0.2, 0.8, 0.8],
      [spectralCentroid, 500, 6000, 0.6],
    ]);

    // Find best match
    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return {
      scene: best[0],
      confidence: best[1],
      scores,
      features: { rms, peak, crestFactor, zcr, spectralCentroid, spectralFlux, dynamicRange }
    };
  },

  // ── Auto-Tune Parameters ───────────────────────────────────────────────
  /**
   * Suggest optimal parameter adjustments based on audio analysis.
   *
   * @param {Float32Array} audio - mono audio
   * @param {number} sr - sample rate
   * @param {Object} currentParams - current slider values
   * @returns {Object} suggested parameter overrides
   */
  autoTuneParams(audio, sr, currentParams = {}) {
    return this._tuneFromAnalysis(this.classifyScene(audio, sr));
  },

  /** autoTuneParams over the whole track, yielding between chunks. */
  async autoTuneParamsAsync(audio, sr, _currentParams = {}, opts = {}) {
    return this._tuneFromAnalysis(await this.classifySceneAsync(audio, sr, opts));
  },

  _tuneFromAnalysis(analysis) {
    const { features } = analysis;
    const suggestions = {};

    // Auto-tune noise gate based on noise floor
    const noiseFloorDb = 20 * Math.log10(features.rms + 1e-10);
    if (noiseFloorDb < -50) {
      suggestions.gateThresh = Math.max(-70, noiseFloorDb - 5);
    }

    // Whisper / very quiet speech: lift intelligibility without gating breath
    if (analysis.scene === 'whisper' || features.rms < 0.025) {
      suggestions.gateThresh = Math.min(-60, Math.max(-70, noiseFloorDb - 18));
      suggestions.gateRange = -80;
      suggestions.gateHold = 40;
      suggestions.nrAmount = Math.min(70, Math.max(50, suggestions.nrAmount || 60));
      suggestions.compThresh = -36;
      suggestions.compRatio = 5;
      suggestions.compMakeup = 8;
      suggestions.outGain = 6;
      suggestions.eqMid = 3;
      suggestions.eqPresence = 3;
      suggestions.eqBody = 2;
      suggestions.deEssAmt = 3;
      suggestions.hpFreq = 120;
      suggestions.lpFreq = 14000;
    }

    // Auto-tune NR amount based on SNR estimate
    const snrEstimate = 20 * Math.log10(features.peak / (features.rms + 1e-10));
    if (snrEstimate < 15) {
      suggestions.nrAmount = Math.min(80, 30 + (15 - snrEstimate) * 2);
    } else if (snrEstimate > 30) {
      suggestions.nrAmount = Math.max(15, 30 - (snrEstimate - 30));
    }

    // Auto-tune HP filter based on low-frequency content
    if (analysis.scene === 'podcast' || analysis.scene === 'broadcast') {
      suggestions.hpFreq = 80;
    } else if (analysis.scene === 'forensic') {
      suggestions.hpFreq = 50;
    }

    // Auto-tune compression based on dynamic range
    if (features.dynamicRange > 40) {
      suggestions.compRatio = 4;
      suggestions.compThresh = -24;
    } else if (features.dynamicRange < 15) {
      suggestions.compRatio = 2;
      suggestions.compThresh = -18;
    }

    return {
      scene: analysis.scene,
      confidence: analysis.confidence,
      suggestions,
      features: analysis.features
    };
  },

  // ── SNR Tracker ────────────────────────────────────────────────────────
  /**
   * Compute instantaneous SNR estimate from original and processed audio.
   *
   * @param {Float32Array} original - original audio
   * @param {Float32Array} processed - processed audio
   * @returns {{ snrDb: number, improvement: number }}
   */
  computeSNRImprovement(original, processed) {
    const origRMS  = this._calcRMS(original);
    const procRMS  = this._calcRMS(processed);
    const origNoiseRMS = this._calcNoiseRMS(original);
    const procNoiseRMS = this._calcNoiseRMS(processed);

    const origSNR = 20 * Math.log10((origRMS + 1e-10) / (origNoiseRMS + 1e-10));
    const procSNR = 20 * Math.log10((procRMS + 1e-10) / (procNoiseRMS + 1e-10));

    return {
      originalSNR: origSNR,
      processedSNR: procSNR,
      improvement: procSNR - origSNR,
      snrDb: procSNR
    };
  },

  // ── Voice Quality Metrics ──────────────────────────────────────────────
  /**
   * Estimate voice quality metrics for processed audio.
   * Returns PESQ-approximation and MOS estimate.
   *
   * @param {Float32Array} audio - processed audio
   * @param {number} sr - sample rate
   * @returns {{ mosEstimate: number, clarity: number, naturalness: number }}
   */
  estimateVoiceQuality(audio, sr) {
    const centroid = this._calcSpectralCentroid(audio, sr);
    const flux = this._calcSpectralFlux(audio);
    const zcr = this._calcZCR(audio);
    const rms = this._calcRMS(audio);

    // Heuristic MOS estimation (1-5 scale)
    // Based on spectral characteristics of good voice audio
    let mos = 3.0;

    // Good speech centroid: 1000-3500 Hz
    if (centroid >= 1000 && centroid <= 3500) mos += 0.5;
    else if (centroid < 500 || centroid > 6000) mos -= 0.5;

    // Good ZCR for speech: 0.05-0.25
    if (zcr >= 0.05 && zcr <= 0.25) mos += 0.3;

    // Penalize very low or very high flux (musical noise or over-processing)
    if (flux > 0.1 && flux < 0.5) mos += 0.2;
    else if (flux > 0.8) mos -= 0.3;  // musical noise

    // Clamp to 1-5
    mos = Math.max(1.0, Math.min(5.0, mos));

    return {
      mosEstimate: Math.round(mos * 10) / 10,
      clarity: Math.min(100, Math.round(centroid / 40)),
      naturalness: Math.round((1 - Math.min(1, flux)) * 100),
      features: { centroid, flux, zcr, rms }
    };
  },

  // ── Private Helpers ────────────────────────────────────────────────────
  _calcRMS(audio) {
    let sum = 0;
    for (let i = 0; i < audio.length; i++) sum += audio[i] * audio[i];
    return Math.sqrt(sum / audio.length);
  },

  _calcPeak(audio) {
    let peak = 0;
    for (let i = 0; i < audio.length; i++) {
      const abs = Math.abs(audio[i]);
      if (abs > peak) peak = abs;
    }
    return peak;
  },

  _calcZCR(audio) {
    let crossings = 0;
    for (let i = 1; i < audio.length; i++) {
      if ((audio[i] >= 0) !== (audio[i - 1] >= 0)) crossings++;
    }
    return crossings / audio.length;
  },

  _calcSpectralCentroid(audio, sr) {
    // Use a small frame (512 samples) for fast computation
    const N = 512;
    const frame = audio.subarray(0, Math.min(N, audio.length));

    // Calculates spectral centroid from a DFT.
    // Faster than a full analysis, but not autocorrelation-based.

    let weightedSum = 0;
    let totalPower = 0;
    const halfN = N / 2;

    for (let k = 1; k < halfN; k++) {
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const angle = 2 * Math.PI * k * n / N;
        re += frame[n] * Math.cos(angle);
        im -= frame[n] * Math.sin(angle);
      }
      const power = re * re + im * im;
      const freq = k * sr / N;
      weightedSum += freq * power;
      totalPower += power;
    }

    return totalPower > 0 ? weightedSum / totalPower : 1000;
  },

  _calcSpectralFlux(audio) {
    // Measure frame-to-frame spectral change using energy variance
    // Fast approximation: compare RMS of consecutive short frames
    const SPECTRAL_FLUX_FRAME_SIZE = 256;
    const SPECTRAL_FLUX_MAX_FRAMES = 20; // Limit frames for performance

    const nFrames = Math.min(SPECTRAL_FLUX_MAX_FRAMES, Math.floor(audio.length / SPECTRAL_FLUX_FRAME_SIZE));
    if (nFrames < 2) return 0;

    let totalFlux = 0;
    let prevRMS = this._calcRMS(audio.subarray(0, SPECTRAL_FLUX_FRAME_SIZE));

    for (let f = 1; f < nFrames; f++) {
      const frame = audio.subarray(f * SPECTRAL_FLUX_FRAME_SIZE, (f + 1) * SPECTRAL_FLUX_FRAME_SIZE);
      const rms = this._calcRMS(frame);
      const diff = Math.abs(rms - prevRMS);
      totalFlux += diff;
      prevRMS = rms;
    }

    return totalFlux / (nFrames - 1);
  },

  _calcDynamicRange(audio) {
    // Compute dynamic range in dB using percentile method
    let p95;
    let p05;
    if (audio instanceof Float32Array && audio.length > 0) {
      [p05, p95] = this._absOrderStats(audio, [Math.floor(0.05 * audio.length), Math.floor(0.95 * audio.length)]);
    } else {
      const sorted = new Float32Array(audio.length);
      for (let i = 0; i < audio.length; i++) sorted[i] = Math.abs(audio[i]);
      sorted.sort();
      p95 = sorted[Math.floor(0.95 * sorted.length)];
      p05 = sorted[Math.floor(0.05 * sorted.length)];
    }
    p05 += 1e-10;

    return 20 * Math.log10(p95 / p05);
  },

  /**
   * k-th smallest |x| for each k — the same values as sorting a full |x| copy,
   * in two linear passes. The bit pattern of a non-negative float orders like
   * the float, so a 16-bit histogram of |x|'s bits finds each k's bucket and a
   * second pass resolves the low 15 bits. Sorting the track (the previous
   * method) ran in the post-Process idle callback: 2.2 s for 5 minutes.
   * @param {Float32Array} audio
   * @param {number[]} ks 0-based ranks, each < audio.length
   * @returns {number[]}
   */
  _absOrderStats(audio, ks) {
    const n = audio.length;
    const bits = new Uint32Array(audio.buffer, audio.byteOffset, n);
    const hi = new Uint32Array(65536);
    for (let i = 0; i < n; i++) hi[(bits[i] & 0x7fffffff) >>> 15]++;
    const targets = ks.map((k) => {
      let acc = 0;
      let bucket = 0;
      while (acc + hi[bucket] <= k) acc += hi[bucket++];
      return { bucket, rank: k - acc, lo: new Uint32Array(32768) };
    });
    for (let i = 0; i < n; i++) {
      const b = bits[i] & 0x7fffffff;
      const bucket = b >>> 15;
      for (const t of targets) if (t.bucket === bucket) t.lo[b & 0x7fff]++;
    }
    const word = new Uint32Array(1);
    const asFloat = new Float32Array(word.buffer);
    return targets.map((t) => {
      let acc = 0;
      let low = 0;
      while (acc + t.lo[low] <= t.rank) acc += t.lo[low++];
      word[0] = (t.bucket << 15) | low;
      return asFloat[0];
    });
  },

  _calcNoiseRMS(audio) {
    // Estimate noise RMS from quietest 10% of frames
    const frameSize = 512;
    const nFrames = Math.floor(audio.length / frameSize);
    const frameRMS = [];

    for (let f = 0; f < nFrames; f++) {
      const frame = audio.subarray(f * frameSize, (f + 1) * frameSize);
      frameRMS.push(this._calcRMS(frame));
    }

    frameRMS.sort((a, b) => a - b);
    const noiseFrames = frameRMS.slice(0, Math.max(1, Math.floor(nFrames * 0.1)));
    const sum = noiseFrames.reduce((a, b) => a + b, 0);
    return sum / noiseFrames.length;
  },

  /**
   * Score a feature against a range [min, max] with given weight.
   * Returns 0-1 based on how well the feature falls in range.
   */
  _scoreFeature(value, min, max, weight) {
    if (value >= min && value <= max) return weight;
    const center = (min + max) / 2;
    const halfRange = (max - min) / 2;
    const dist = Math.abs(value - center) - halfRange;
    return weight * Math.max(0, 1 - dist / halfRange);
  },

  /**
   * Compute composite score from feature ranges.
   * @param {Array} features - [[value, min, max, weight], ...]
   */
  _score(features) {
    let total = 0;
    let maxTotal = 0;
    for (const [value, min, max, weight] of features) {
      total += this._scoreFeature(value, min, max, weight);
      maxTotal += weight;
    }
    return maxTotal > 0 ? total / maxTotal : 0;
  }
};

// Export for both browser and Node.js (tests)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AIIntelligence;
} else {
  self.AIIntelligence = AIIntelligence;
}
