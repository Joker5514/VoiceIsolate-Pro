/**
 * VoiceIsolate Pro — Speaker Diarization Primitives (Layer 1: Core)
 *
 * Lightweight, model-free speaker segmentation used by the Stem-Split &
 * Live-Mix pipeline to power per-speaker mute/solo/enhance controls. Operates
 * on a single mono channel (the CLEAN voice stem produced by MLWorker —
 * running on the separated voice gives far better speaker features than the
 * raw mix).
 *
 * Algorithm:
 *   1. Slice the signal into 200 ms analysis windows (100 ms hop)
 *   2. Per-window features:
 *        • RMS energy            — voice-activity gating + confidence
 *        • zero-crossing rate    — cheap spectral-centroid proxy
 *        • spectral flatness     — tonal-vs-noise discriminator
 *        • log-mel fingerprint   — loudness-invariant timbral signature
 *                                  (MFCC-style; the real "voiceprint")
 *   3. Min-max normalise the IDENTITY features (energy excluded — loudness is
 *      not identity), cluster with k-means (k = 2–4 by duration)
 *   4. Merge adjacent same-cluster windows into segments, drop silence and
 *      segments shorter than MIN_SEGMENT_SEC
 *
 * Whisper sensitivity: SILENCE_RMS sits well below a typical VAD gate so soft
 * and whispered speech on the denoised stem still registers as a speaker.
 * Pure digital silence (exact zero) always falls below it.
 *
 * Output contract (shared with PlaybackMixer.loadSpeakerSegments and the
 * presentation layer): non-overlapping, time-ordered segments
 *   { speakerId: 'S1', label: 'Speaker S1', start: s, end: s, confidence: 0..1 }
 *
 * Pure module: no DOM, no Web Audio, no I/O, no side effects — importable in
 * Node (tests), workers, and the browser.
 */
'use strict';

/** Analysis window length in seconds. */
export const WINDOW_SEC = 0.2;
/** Analysis hop in seconds. */
export const HOP_SEC = 0.1;
/**
 * RMS below this is treated as silence (no speaker). Deliberately low
 * (≈ −56 dBFS) so whispered/soft speech on the CLEAN stem is still captured;
 * the denoiser has already stripped background hiss, so a low floor admits
 * faint voices rather than noise. Exact-zero silence is always below it.
 */
export const SILENCE_RMS = 0.0015;
/** Segments shorter than this are discarded as jitter. */
export const MIN_SEGMENT_SEC = 0.3;
/** Number of mel bands in the per-window timbral fingerprint. */
export const MEL_BANDS = 20;
/** FFT size cap for the fingerprint (power of two). 8192 @ 48 kHz ≈ 5.9 Hz bins. */
const FINGERPRINT_FFT = 8192;

/**
 * Per-window feature vector: [rms, normalised zcr, spectral flatness].
 * Cheap (no FFT) and exported for tests / external callers. The internal
 * diarizer pairs these with the richer mel fingerprint below.
 * @param {Float32Array} frame
 * @returns {number[]}
 */
export function frameFeatures(frame) {
  const n = frame.length;
  if (n === 0) return [0, 0, 0];

  let sumSq = 0;
  for (let i = 0; i < n; i++) sumSq += frame[i] * frame[i];
  const rms = Math.sqrt(sumSq / n);

  // Zero-crossing rate as a cheap spectral-centroid proxy.
  let zc = 0;
  for (let i = 1; i < n; i++) {
    if ((frame[i] >= 0) !== (frame[i - 1] >= 0)) zc++;
  }
  const zcr = zc / (2 * n); // fraction of sign flips per sample, ∈ [0, 0.5]

  // Spectral flatness via geometric/arithmetic mean ratio of |x|.
  let sumAbs = 0;
  let logSum = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(frame[i]) + 1e-9;
    sumAbs += a;
    logSum += Math.log(a);
  }
  const flatness = Math.exp(logSum / n) / (sumAbs / n);

  return [rms, zcr, flatness];
}

// ─── Spectral fingerprint (radix-2 FFT + mel filterbank) ─────────────────────

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/** Precomputed FFT tables (bit-reversal permutation + twiddles) per size. */
const _fftCache = Object.create(null);
function fftTables(n) {
  if (_fftCache[n]) return _fftCache[n];
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  _fftCache[n] = { rev, cos, sin };
  return _fftCache[n];
}

/** In-place forward radix-2 complex FFT (power-of-two n). */
function fftForward(re, im) {
  const n = re.length;
  const { rev, cos, sin } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const r = rev[i];
    if (r > i) {
      let t = re[i]; re[i] = re[r]; re[r] = t;
      t = im[i]; im[i] = im[r]; im[r] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = 0, k = 0; j < half; j++, k += step) {
        const wr = cos[k];
        const wi = sin[k];
        const a = i + j;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/** Triangular mel filterbank cache, keyed by `${fftSize}:${sampleRate}:${bands}`. */
const _melCache = Object.create(null);
function melFilterbank(fftSize, sampleRate, bands) {
  const key = `${fftSize}:${sampleRate}:${bands}`;
  if (_melCache[key]) return _melCache[key];

  const nBins = fftSize / 2 + 1;
  const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const melToHz = (mel) => 700 * (10 ** (mel / 2595) - 1);
  const melMax = hzToMel(sampleRate / 2);

  // bands+2 mel-spaced points → bands overlapping triangles.
  const points = new Float32Array(bands + 2);
  for (let i = 0; i < points.length; i++) {
    const hz = melToHz((i / (bands + 1)) * melMax);
    points[i] = Math.round((hz / (sampleRate / 2)) * (nBins - 1));
  }

  // Each filter: {start, peak, end} bin indices for triangular weighting.
  const filters = [];
  for (let b = 0; b < bands; b++) {
    filters.push({ start: points[b], peak: points[b + 1], end: points[b + 2] });
  }
  _melCache[key] = { nBins, filters };
  return _melCache[key];
}

const _hannCache = Object.create(null);
function hann(n) {
  if (_hannCache[n]) return _hannCache[n];
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  _hannCache[n] = w;
  return w;
}

/**
 * Loudness-invariant log-mel timbral fingerprint for one window. Returns a
 * normalised band-energy distribution (sums to 1) so two utterances by the
 * same speaker at different volumes share a fingerprint, while different
 * voices (timbre) separate. This is the per-window "voiceprint".
 *
 * @param {Float32Array} frame
 * @param {number} sampleRate
 * @param {number} [bands]
 * @returns {Float32Array} length `bands`; all-zero for empty/degenerate input
 */
export function melBands(frame, sampleRate, bands = MEL_BANDS) {
  const out = new Float32Array(bands);
  if (!(frame instanceof Float32Array) || frame.length <= 1 ||
      !Number.isFinite(sampleRate) || sampleRate <= 0) {
    return out;
  }
  }

  const usable = Math.min(frame.length, FINGERPRINT_FFT);
  const fftSize = nextPow2(usable);
  const win = hann(usable);
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  for (let i = 0; i < usable; i++) re[i] = frame[i] * win[i];
  fftForward(re, im);

  const { nBins, filters } = melFilterbank(fftSize, sampleRate, bands);
  const power = new Float32Array(nBins);
  for (let k = 0; k < nBins; k++) power[k] = re[k] * re[k] + im[k] * im[k];

  let total = 0;
  for (let b = 0; b < bands; b++) {
    const { start, peak, end } = filters[b];
    let e = 0;
    for (let k = start; k <= end; k++) {
      if (k < 0 || k >= nBins) continue;
      // Triangular weight: rises to 1 at the peak bin, falls back to 0.
      const w = k <= peak
        ? (peak > start ? (k - start) / (peak - start) : 1)
        : (end > peak ? (end - k) / (end - peak) : 1);
      e += power[k] * w;
    }
    out[b] = e;
    total += e;
  }

  // Normalise to a shape (sum = 1) → exactly loudness-invariant: scaling the
  // input scales every band's power identically, leaving the shape unchanged.
  // This is what lets a whisper and a shout from the same voice share a
  // fingerprint. Silent windows stay all-zero.
  if (total > 1e-12) {
    for (let b = 0; b < bands; b++) out[b] /= total;
  }
  return out;
}

/**
 * Plain k-means over feature vectors. Deterministic init (centroids spread
 * across the timeline) so results are reproducible for tests.
 * @param {number[][]} features
 * @param {number} k
 * @param {number} [maxIter]
 * @returns {Int32Array} cluster label per feature row
 */
export function kMeans(features, k, maxIter = 20) {
  if (features.length === 0) return new Int32Array(0);
  const dim = features[0].length;
  const n = features.length;

  const centroids = Array.from({ length: k }, (_, ci) => {
    const fi = Math.floor((ci / k) * n);
    return features[fi].slice();
  });

  const labels = new Int32Array(n);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        let d = 0;
        for (let j = 0; j < dim; j++) {
          const diff = features[i][j] - centroids[c][j];
          d += diff * diff;
        }
        if (d < bestDist) { bestDist = d; best = c; }
      }
      if (labels[i] !== best) { labels[i] = best; changed = true; }
    }
    if (!changed) break;

    const sums = Array.from({ length: k }, () => new Float64Array(dim));
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) {
      counts[labels[i]]++;
      for (let j = 0; j < dim; j++) sums[labels[i]][j] += features[i][j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        for (let j = 0; j < dim; j++) centroids[c][j] = sums[c][j] / counts[c];
      }
    }
  }

  return labels;
}

/**
 * Diarize one mono channel into speaker segments.
 *
 * @param {Float32Array} samples  mono PCM (use the clean voice stem)
 * @param {number} sampleRate
 * @param {object} [options]
 * @param {number} [options.maxSpeakers]  cap on cluster count (2–8)
 * @returns {Array<{speakerId: string, label: string, start: number, end: number, confidence: number}>}
 */
export function diarizeChannel(samples, sampleRate, options = {}) {
  if (!(samples instanceof Float32Array) || samples.length === 0) return [];
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('[VIP][diarization] sampleRate must be a positive number.');
  }

  const winSamp = Math.round(WINDOW_SEC * sampleRate);
  const hopSamp = Math.round(HOP_SEC * sampleRate);
  // A rate this low rounds the hop to zero samples — the analysis loop could
  // never advance. Reject it loudly rather than hang or guess.
  if (hopSamp < 1 || winSamp < 1) {
    throw new RangeError(
      `[VIP][diarization] sampleRate ${sampleRate} is too low for the ${WINDOW_SEC}s analysis window.`
    );
  }

  // Per-window: energy (RMS) for VAD/confidence, plus the identity vector
  // [zcr, flatness, ...melFingerprint] used for clustering. Energy is kept out
  // of the identity vector on purpose — loudness is not who is speaking.
  const energies = [];
  const idFeatures = [];
  const frameStarts = [];
  for (let i = 0; i + winSamp <= samples.length; i += hopSamp) {
    const frame = samples.subarray(i, i + winSamp);
    const [rms, zcr, flatness] = frameFeatures(frame);
    const mel = melBands(frame, sampleRate);
    const id = new Array(2 + mel.length);
    id[0] = zcr;
    id[1] = flatness;
    for (let b = 0; b < mel.length; b++) id[2 + b] = mel[b];
    energies.push(rms);
    idFeatures.push(id);
    frameStarts.push(i);
  }
  if (idFeatures.length === 0) return [];

  // Cluster VOICED frames only. Silent windows must not participate: their
  // degenerate features skew the normalisation and absorb a whole cluster,
  // collapsing real speakers.
  const voicedIdx = [];
  for (let fi = 0; fi < energies.length; fi++) {
    if (energies[fi] >= SILENCE_RMS) voicedIdx.push(fi);
  }
  if (voicedIdx.length === 0) return [];

  // Cluster count grows with duration; clamp to caller's cap and frame count.
  const durSec = samples.length / sampleRate;
  const maxSpeakers = Math.min(8, Math.max(2, options.maxSpeakers || 4));
  const k = Math.min(maxSpeakers, voicedIdx.length, durSec < 10 ? 2 : durSec < 30 ? 3 : 4);

  // Min-max normalise each IDENTITY dimension (over voiced frames) so no single
  // feature dominates the distance metric.
  const dim = idFeatures[0].length;
  const fMin = new Float64Array(dim).fill(Infinity);
  const fMax = new Float64Array(dim).fill(-Infinity);
  for (const fi of voicedIdx) {
    for (let d = 0; d < dim; d++) {
      if (idFeatures[fi][d] < fMin[d]) fMin[d] = idFeatures[fi][d];
      if (idFeatures[fi][d] > fMax[d]) fMax[d] = idFeatures[fi][d];
    }
  }
  const norm = (fi) => idFeatures[fi].map(
    (v, d) => (fMax[d] > fMin[d] ? (v - fMin[d]) / (fMax[d] - fMin[d]) : 0)
  );

  // Separate normalised-energy scale for confidence (energy IS meaningful for
  // confidence, just not for identity).
  let eMin = Infinity;
  let eMax = -Infinity;
  for (const fi of voicedIdx) {
    if (energies[fi] < eMin) eMin = energies[fi];
    if (energies[fi] > eMax) eMax = energies[fi];
  }
  const normEnergy = (fi) => (eMax > eMin ? (energies[fi] - eMin) / (eMax - eMin) : 0);

  const voicedLabels = kMeans(voicedIdx.map(norm), k);
  const labelByFrame = new Map(voicedIdx.map((fi, j) => [fi, voicedLabels[j]]));

  // Merge adjacent same-speaker windows; silence breaks segments.
  const segments = [];
  let segCluster = null; // cluster index or null for silence
  let segStart = 0;
  let segEnergy = 0;     // Σ normalised energy over the segment's own frames
  let segFrames = 0;
  const flush = (endSamp) => {
    if (segCluster === null) return;
    // Confidence reflects the segment's own mean energy — never the frame
    // that triggered the boundary, which is typically silence and would
    // floor every confidence at the 0.68 baseline.
    const meanEnergy = segFrames > 0 ? segEnergy / segFrames : 0;
    segments.push({
      cluster: segCluster,
      start: segStart / sampleRate,
      end: endSamp / sampleRate,
      confidence: Math.min(0.97, 0.68 + meanEnergy * 0.29),
    });
  };

  for (let fi = 0; fi < frameStarts.length; fi++) {
    const cluster = labelByFrame.has(fi) ? labelByFrame.get(fi) : null;
    if (cluster !== segCluster) {
      flush(frameStarts[fi]);
      segStart = frameStarts[fi];
      segCluster = cluster;
      segEnergy = 0;
      segFrames = 0;
    }
    if (cluster !== null) {
      segEnergy += normEnergy(fi);
      segFrames++;
    }
  }
  flush(samples.length);

  // Drop jitter, then relabel clusters compactly (S1, S2, …) in order of
  // first appearance so absent clusters never produce phantom speakers.
  const kept = segments.filter((s) => s.end - s.start >= MIN_SEGMENT_SEC);
  const idByCluster = new Map();
  return kept.map((s) => {
    if (!idByCluster.has(s.cluster)) idByCluster.set(s.cluster, `S${idByCluster.size + 1}`);
    const speakerId = idByCluster.get(s.cluster);
    return {
      speakerId,
      label: `Speaker ${speakerId}`,
      start: s.start,
      end: s.end,
      confidence: s.confidence,
    };
  });
}

/**
 * Aggregate segments into a per-speaker summary for the presentation layer.
 * @param {ReturnType<typeof diarizeChannel>} segments
 * @returns {Array<{speakerId: string, label: string, talkTime: number, segmentCount: number}>}
 */
export function summarizeSpeakers(segments) {
  const byId = new Map();
  for (const seg of segments || []) {
    if (!seg || typeof seg.speakerId !== 'string') continue;
    const entry = byId.get(seg.speakerId) || {
      speakerId: seg.speakerId,
      label: seg.label || `Speaker ${seg.speakerId}`,
      talkTime: 0,
      segmentCount: 0,
    };
    entry.talkTime += Math.max(0, seg.end - seg.start);
    entry.segmentCount++;
    byId.set(seg.speakerId, entry);
  }
  return [...byId.values()];
}

export default diarizeChannel;
