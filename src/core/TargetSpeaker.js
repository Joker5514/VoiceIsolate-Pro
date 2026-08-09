/**
 * VoiceIsolate Pro — Target-speaker enrollment & local voiceprint (Layer 1)
 *
 * Fully on-device. No network. Uses:
 *   • Energy + SoftVad-style speech checks for enrollment validity
 *   • Mel-band loudness-invariant voiceprint (diarization.melBands) as the
 *     local embedding until a pinned ECAPA-TDNN ONNX ships in the manifest
 *
 * When ECAPA weights are added to ModelManifest under id `ecapa_tdnn`,
 * extractEmbeddingAsync() can load them via MLWorker; today we stay pure-JS.
 */
'use strict';

import { melBands } from './diarization.js';

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
 * Build a soft time-domain gain curve [0,1] by comparing short windows to the
 * enrolled voiceprint. Used to attenuate non-target speech on the clean stem.
 *
 * @param {Float32Array} samples full mono mix or clean stem
 * @param {number} sampleRate
 * @param {Float32Array} targetEmbedding
 * @param {{ threshold?: number, softWidth?: number }} [opts]
 * @returns {Float32Array} per-sample gain
 */
export function buildTargetGainCurve(samples, sampleRate, targetEmbedding, opts = {}) {
  const thr = opts.threshold ?? DEFAULT_SIM_THRESHOLD;
  const soft = opts.softWidth ?? 0.12;
  const win = Math.max(64, Math.floor(sampleRate * 0.2));
  const hop = Math.max(32, Math.floor(sampleRate * 0.05));
  const gain = new Float32Array(samples.length);
  gain.fill(0.12); // floor for non-target
  for (let i = 0; i + win <= samples.length; i += hop) {
    const frame = samples.subarray(i, i + win);
    const emb = extractLocalVoiceprint(frame, sampleRate);
    const sim = cosineSimilarity(emb, targetEmbedding);
    // Map similarity → gain
    let g = 0.12;
    if (sim >= thr + soft) g = 1;
    else if (sim > thr - soft) {
      const t = (sim - (thr - soft)) / (2 * soft);
      g = 0.12 + t * 0.88;
    }
    for (let j = 0; j < win; j++) {
      const idx = i + j;
      if (g > gain[idx]) gain[idx] = g;
    }
  }
  // Smooth
  const sm = Math.max(1, Math.floor(sampleRate * 0.01));
  const out = new Float32Array(samples.length);
  let run = 0;
  for (let i = 0; i < samples.length; i++) {
    run += gain[i];
    if (i >= sm) run -= gain[i - sm];
    out[i] = run / Math.min(sm, i + 1);
  }
  return out;
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
  validateEnrollmentSegment,
  extractLocalVoiceprint,
  cosineSimilarity,
  buildTargetGainCurve,
  applyGainToChannels,
  enrollFromRange,
  sliceSeconds,
};
