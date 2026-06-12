/**
 * VoiceIsolate Pro — Speaker Diarization Primitives (Layer 1: Core)
 *
 * Lightweight, model-free speaker segmentation used by the Stem-Split &
 * Live-Mix pipeline to power per-speaker mute/solo controls. Operates on a
 * single mono channel (the CLEAN voice stem produced by MLWorker — running
 * on the separated voice gives far better speaker features than the raw mix).
 *
 * Algorithm (ported from the retired Engineer-Mode prototype):
 *   1. Slice the signal into 200 ms analysis windows (100 ms hop)
 *   2. Per-window features: RMS energy, zero-crossing rate, spectral flatness
 *   3. Min-max normalise features, cluster with k-means (k = 2–4 by duration)
 *   4. Merge adjacent same-cluster windows into segments, drop silence and
 *      segments shorter than MIN_SEGMENT_SEC
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
/** RMS below this is treated as silence (no speaker). */
export const SILENCE_RMS = 0.003;
/** Segments shorter than this are discarded as jitter. */
export const MIN_SEGMENT_SEC = 0.3;

/**
 * Per-window feature vector: [rms, normalised zcr, spectral flatness].
 * Cheap (no FFT) but discriminative enough to separate speaking voices.
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

  const features = [];
  const frameStarts = [];
  for (let i = 0; i + winSamp <= samples.length; i += hopSamp) {
    features.push(frameFeatures(samples.subarray(i, i + winSamp)));
    frameStarts.push(i);
  }
  if (features.length === 0) return [];

  // Cluster VOICED frames only. Silent windows must not participate: their
  // degenerate features (zero energy, flatness → 1) skew the min-max
  // normalisation and absorb a whole cluster, collapsing real speakers.
  const voicedIdx = [];
  for (let fi = 0; fi < features.length; fi++) {
    if (features[fi][0] >= SILENCE_RMS) voicedIdx.push(fi);
  }
  if (voicedIdx.length === 0) return [];

  // Cluster count grows with duration; clamp to caller's cap and frame count.
  const durSec = samples.length / sampleRate;
  const maxSpeakers = Math.min(8, Math.max(2, options.maxSpeakers || 4));
  const k = Math.min(maxSpeakers, voicedIdx.length, durSec < 10 ? 2 : durSec < 30 ? 3 : 4);

  // Min-max normalise each dimension (over voiced frames) so no single
  // feature dominates the distance metric.
  const dim = features[0].length;
  const fMin = new Float64Array(dim).fill(Infinity);
  const fMax = new Float64Array(dim).fill(-Infinity);
  for (const fi of voicedIdx) {
    for (let d = 0; d < dim; d++) {
      if (features[fi][d] < fMin[d]) fMin[d] = features[fi][d];
      if (features[fi][d] > fMax[d]) fMax[d] = features[fi][d];
    }
  }
  const norm = (fi) => features[fi].map(
    (v, d) => (fMax[d] > fMin[d] ? (v - fMin[d]) / (fMax[d] - fMin[d]) : 0)
  );

  const voicedLabels = kMeans(voicedIdx.map(norm), k);
  const labelByFrame = new Map(voicedIdx.map((fi, j) => [fi, voicedLabels[j]]));

  // Merge adjacent same-speaker windows; silence breaks segments.
  const segments = [];
  let segCluster = null; // cluster index or null for silence
  let segStart = 0;
  let segEnergy = 0;     // Σ normalised RMS over the segment's own frames
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
      segEnergy += norm(fi)[0];
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
