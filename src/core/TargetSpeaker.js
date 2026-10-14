/**
 * VoiceIsolate Pro — Target-speaker enrollment & local voiceprint (Layer 1)
 *
 * Fully on-device. No network. Uses:
 *   • Energy + SoftVad-style speech checks for enrollment validity
 *   • Mel-band loudness-invariant voiceprint (diarization.melBands): always
 *     available, but weak at telling speakers apart (EER ~19 %)
 *   • Optional ECAPA-TDNN (WeSpeaker voxceleb_ECAPA512, hash-pinned in
 *     ModelManifest, not bundled): scored in SpeakerEmbeddingWorker; this
 *     module supplies the shared window/gain/match logic
 *
 * Optional: diarization cluster ids can be fused into the gain curve so
 * non-target speaker segments are attenuated more aggressively.
 */
'use strict';

import { melBands } from './diarization.js';
import { smoothGainCurve } from './AudioClickFix.js';

export const MIN_ENROLL_SEC = 0.4;
export const MAX_ENROLL_SEC = 12;
export const DEFAULT_SPEECH_RMS = 0.008;
export const DEFAULT_SIM_THRESHOLD = 0.42;

/**
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @param {{ startSec: number, endSec: number }} range
 * @returns {Float32Array}
 */
export function sliceSeconds(samples, sampleRate, range) {
  const n = samples.length;
  const a = Math.max(0, Math.floor((range.startSec || 0) * sampleRate));
  const b = Math.min(n, Math.ceil((range.endSec || 0) * sampleRate));
  if (b <= a) return new Float32Array(0);
  return samples.subarray(a, b);
}

/**
 * Validate an enrollment segment (speech energy + duration).
 * @returns {{ ok: boolean, reason?: string, speechRatio?: number, rms?: number }}
 */
export function validateEnrollmentSegment(samples, sampleRate, range, opts = {}) {
  const seg = sliceSeconds(samples, sampleRate, range);
  const dur = seg.length / (sampleRate || 1);
  if (dur < (opts.minSec ?? MIN_ENROLL_SEC)) {
    return { ok: false, reason: `Enrollment too short (${dur.toFixed(2)}s). Select ≥ ${MIN_ENROLL_SEC}s of speech.` };
  }
  if (dur > (opts.maxSec ?? MAX_ENROLL_SEC)) {
    return { ok: false, reason: `Enrollment too long (${dur.toFixed(1)}s). Keep under ${MAX_ENROLL_SEC}s.` };
  }
  let sumSq = 0;
  let speech = 0;
  const frame = Math.max(64, Math.floor(sampleRate * 0.02));
  const hop = Math.max(32, Math.floor(frame / 2));
  const thr = opts.speechRms ?? DEFAULT_SPEECH_RMS;
  for (let i = 0; i + frame <= seg.length; i += hop) {
    let e = 0;
    for (let j = 0; j < frame; j++) e += seg[i + j] * seg[i + j];
    const rms = Math.sqrt(e / frame);
    sumSq += e;
    if (rms >= thr) speech++;
  }
  const frames = Math.max(1, Math.floor((seg.length - frame) / hop) + 1);
  const speechRatio = speech / frames;
  const rms = Math.sqrt(sumSq / Math.max(1, seg.length));
  if (speechRatio < 0.35 || rms < thr * 0.5) {
    return {
      ok: false,
      reason: 'Selected region has little speech. Pick a clearer talking segment.',
      speechRatio,
      rms,
    };
  }
  return { ok: true, speechRatio, rms };
}

/**
 * Local speaker embedding = mean of normalized mel voiceprints over speech frames.
 * @param {Float32Array} samples enrollment PCM (mono)
 * @param {number} sampleRate
 * @returns {Float32Array} length 24 (or MEL_BANDS)
 */
export function extractLocalVoiceprint(samples, sampleRate) {
  const bands = 24;
  const winSec = 0.2;
  const hopSec = 0.1;
  const win = Math.max(64, Math.floor(sampleRate * winSec));
  const hop = Math.max(32, Math.floor(sampleRate * hopSec));
  const acc = new Float32Array(bands);
  let count = 0;
  const thr = DEFAULT_SPEECH_RMS;
  for (let i = 0; i + win <= samples.length; i += hop) {
    const frame = samples.subarray(i, i + win);
    let e = 0;
    for (let j = 0; j < frame.length; j++) e += frame[j] * frame[j];
    if (Math.sqrt(e / frame.length) < thr) continue;
    const mel = melBands(frame, sampleRate, bands);
    for (let b = 0; b < bands; b++) acc[b] += mel[b];
    count++;
  }
  if (count === 0) {
    // Fallback: whole segment once
    const mel = melBands(samples, sampleRate, bands);
    return mel;
  }
  for (let b = 0; b < bands; b++) acc[b] /= count;
  // L2 normalize for cosine similarity
  let n2 = 0;
  for (let b = 0; b < bands; b++) n2 += acc[b] * acc[b];
  n2 = Math.sqrt(n2) || 1;
  for (let b = 0; b < bands; b++) acc[b] /= n2;
  return acc;
}

/**
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number} cosine similarity in [-1, 1]
 */
export function cosineSimilarity(a, b) {
  const n = Math.min(a?.length || 0, b?.length || 0);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 1e-12 ? dot / d : 0;
}

/**
 * ECAPA-TDNN window scoring, measured on LibriSpeech test-clean (10 speakers,
 * 3 s enrollment, 1.5 s windows): EER 1.9 % at cosine 0.34; at 0.35 the
 * target is missed on 2.2 % of windows and other talkers pass on 1.6 %.
 * The blueprint's 0.75 rejected 95 % of target windows. Mel voiceprint on
 * the same data: EER 19 %, and its 0.42 default passes 96 % of other talkers.
 */
export const ECAPA_SIMILARITY = Object.freeze({
  threshold: 0.35,
  softWidth: 0.08,
  windowSec: 1.5,
  hopSec: 0.5,
});

/**
 * Analysis windows [start, end) in samples.
 * @param {{ coverTail?: boolean, allowShort?: boolean }} [opts]
 *   coverTail adds a last window ending at `length` when hops leave a tail;
 *   allowShort returns one window over the whole signal when none fits.
 * @returns {Array<[number, number]>}
 */
export function similarityWindows(length, sampleRate, winSec, hopSec, opts = {}) {
  const win = Math.max(64, Math.floor(sampleRate * winSec));
  const hop = Math.max(32, Math.floor(sampleRate * hopSec));
  const out = [];
  let i = 0;
  for (; i + win <= length; i += hop) out.push([i, i + win]);
  if (!out.length) return opts.allowShort && length > 0 ? [[0, length]] : out;
  if (opts.coverTail && out[out.length - 1][1] < length) out.push([length - win, length]);
  return out;
}

/**
 * Soft per-sample gain [floor, 1] from window similarities to the target,
 * with optional diarization fusion and click-free smoothing.
 * @param {number} length samples
 * @param {number} sampleRate
 * @param {Array<[number, number]>} windows
 * @param {ArrayLike<number>} sims cosine similarity per window
 * @param {{ threshold?: number, softWidth?: number, diarizationSegments?: Array, targetSpeakerId?: string|number, smoothMs?: number, maxStepPerMs?: number }} [opts]
 * @returns {Float32Array}
 */
export function gainCurveFromSimilarities(length, sampleRate, windows, sims, opts = {}) {
  const thr = opts.threshold ?? DEFAULT_SIM_THRESHOLD;
  const soft = opts.softWidth ?? 0.12;
  const gain = new Float32Array(length);
  gain.fill(0.12); // floor for non-target
  windows.forEach(([a, b], w) => {
    const sim = sims[w];
    let g = 0.12;
    if (sim >= thr + soft) g = 1;
    else if (sim > thr - soft) {
      const t = (sim - (thr - soft)) / (2 * soft);
      g = 0.12 + t * 0.88;
    }
    for (let idx = a; idx < b; idx++) {
      if (g > gain[idx]) gain[idx] = g;
    }
  });

  // Optional diarization fusion: when segments + targetSpeakerId provided,
  // boost target cluster windows and attenuate other speakers more firmly.
  const segs = opts.diarizationSegments;
  const targetId = opts.targetSpeakerId;
  if (Array.isArray(segs) && targetId != null) {
    for (const seg of segs) {
      if (!seg || !Number.isFinite(seg.start) || !Number.isFinite(seg.end)) continue;
      const a = Math.max(0, Math.floor(seg.start * sampleRate));
      const b = Math.min(length, Math.ceil(seg.end * sampleRate));
      const isTarget = String(seg.speakerId) === String(targetId);
      const floor = isTarget ? 0.85 : 0.08;
      for (let i = a; i < b; i++) {
        if (isTarget) gain[i] = Math.max(gain[i], floor);
        else gain[i] = Math.min(gain[i], Math.max(floor, gain[i] * 0.5));
      }
    }
  }

  // 15 ms one-pole + rate-limited smooth prevents gain zipper clicks.
  return smoothGainCurve(gain, sampleRate, {
    smoothMs: opts.smoothMs ?? 15,
    maxStepPerMs: opts.maxStepPerMs ?? 0.06,
  });
}

/**
 * Build a soft time-domain gain curve [0,1] by comparing short windows to the
 * enrolled mel voiceprint. Used to attenuate non-target speech on the clean stem.
 * (The ECAPA path scores its windows in SpeakerEmbeddingWorker and calls
 * gainCurveFromSimilarities directly.)
 *
 * @param {Float32Array} samples full mono mix or clean stem
 * @param {number} sampleRate
 * @param {Float32Array} targetEmbedding
 * @param {{ threshold?: number, softWidth?: number }} [opts]
 * @returns {Float32Array} per-sample gain
 */
export function buildTargetGainCurve(samples, sampleRate, targetEmbedding, opts = {}) {
  const windows = similarityWindows(samples.length, sampleRate, 0.2, 0.05);
  const sims = windows.map(([a, b]) => cosineSimilarity(
    extractLocalVoiceprint(samples.subarray(a, b), sampleRate), targetEmbedding,
  ));
  return gainCurveFromSimilarities(samples.length, sampleRate, windows, sims, opts);
}

/**
 * Best-matching diarization cluster for a target embedding. Needs at least
 * two clusters (with one, every voice would be "the target").
 * @param {Array<{ speakerId: string, embedding: ArrayLike<number> }>} clusters mean embedding per speaker
 * @param {ArrayLike<number>} targetEmbedding
 * @returns {{ speakerId: string, similarity: number }|null}
 */
export function matchClusterEmbeddings(clusters, targetEmbedding) {
  if (!Array.isArray(clusters) || clusters.length < 2 || !targetEmbedding) return null;
  let best = null;
  let bestSim = -2;
  for (const { speakerId, embedding } of clusters) {
    const sim = cosineSimilarity(embedding, targetEmbedding);
    if (sim > bestSim) {
      bestSim = sim;
      best = speakerId;
    }
  }
  return best ? { speakerId: best, similarity: bestSim } : null;
}

/**
 * Match enrolled embedding to diarization speaker clusters by mean voiceprint
 * of each cluster's talk time. Returns best speakerId, or null when there is
 * no match or fewer than two clusters to choose between.
 *
 * @param {Float32Array} samples mono
 * @param {number} sampleRate
 * @param {Float32Array} targetEmbedding
 * @param {Array<{speakerId: string, start: number, end: number}>} segments
 * @returns {{ speakerId: string, similarity: number }|null}
 */
export function matchEmbeddingToDiarization(samples, sampleRate, targetEmbedding, segments) {
  if (!Array.isArray(segments) || !segments.length || !targetEmbedding) return null;
  /** @type {Map<string, { sum: Float32Array, n: number }>} */
  const byId = new Map();
  for (const seg of segments) {
    if (!seg?.speakerId) continue;
    const a = Math.max(0, Math.floor((seg.start || 0) * sampleRate));
    const b = Math.min(samples.length, Math.ceil((seg.end || 0) * sampleRate));
    if (b - a < sampleRate * 0.2) continue;
    const emb = extractLocalVoiceprint(samples.subarray(a, b), sampleRate);
    let row = byId.get(seg.speakerId);
    if (!row) {
      row = { sum: new Float32Array(emb.length), n: 0 };
      byId.set(seg.speakerId, row);
    }
    for (let i = 0; i < emb.length; i++) row.sum[i] += emb[i];
    row.n += 1;
  }
  // Fusion floors the matched cluster at 0.85. With one cluster every voice is
  // "the target", so a second speaker was lifted from ~0.45 back to ~0.9.
  const clusters = [];
  for (const [speakerId, row] of byId) {
    if (!row.n) continue;
    const mean = new Float32Array(row.sum.length);
    for (let i = 0; i < mean.length; i++) mean[i] = row.sum[i] / row.n;
    clusters.push({ speakerId, embedding: mean });
  }
  return matchClusterEmbeddings(clusters, targetEmbedding);
}

/**
 * Apply per-sample gain to multi-channel stems.
 * @param {Float32Array[]} channels
 * @param {Float32Array} gain
 * @returns {Float32Array[]}
 */
export function applyGainToChannels(channels, gain) {
  return channels.map((ch) => {
    const out = new Float32Array(ch.length);
    const n = Math.min(ch.length, gain.length);
    for (let i = 0; i < n; i++) out[i] = ch[i] * gain[i];
    for (let i = n; i < ch.length; i++) out[i] = ch[i] * (gain[gain.length - 1] || 0.12);
    return out;
  });
}

/**
 * Full enroll helper.
 * @returns {{ ok: true, embedding: Float32Array, meta: object } | { ok: false, reason: string }}
 */
export function enrollFromRange(samples, sampleRate, range) {
  const v = validateEnrollmentSegment(samples, sampleRate, range);
  if (!v.ok) return { ok: false, reason: v.reason };
  const seg = sliceSeconds(samples, sampleRate, range);
  const embedding = extractLocalVoiceprint(seg, sampleRate);
  return {
    ok: true,
    embedding,
    meta: {
      startSec: range.startSec,
      endSec: range.endSec,
      speechRatio: v.speechRatio,
      rms: v.rms,
      method: 'local-mel-voiceprint',
      dims: embedding.length,
    },
  };
}

export default {
  ECAPA_SIMILARITY,
  similarityWindows,
  gainCurveFromSimilarities,
  matchClusterEmbeddings,
  validateEnrollmentSegment,
  extractLocalVoiceprint,
  cosineSimilarity,
  buildTargetGainCurve,
  applyGainToChannels,
  enrollFromRange,
  matchEmbeddingToDiarization,
  sliceSeconds,
};
