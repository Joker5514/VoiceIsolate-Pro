/**
 * VoiceIsolate Pro — Soft VAD scores (Layer 1: Core)
 *
 * Frame-level speech activity probabilities for analysis. Always available
 * (classical). ML Silero scores can replace/blend via FullAnalysisHost.
 */
'use strict';

/**
 * Soft speech probability from classical feature frame.
 * @param {object} frame FeatureExtractor frame
 * @param {object} [ctx]
 * @returns {number} 0..1
 */
export function softVadFromFrame(frame, ctx = {}) {
  if (!frame) return 0;
  const noiseFloor = ctx.noiseFloor ?? 0.001;
  const rms = frame.rms ?? 0;
  if (rms < noiseFloor * 0.9) return 0;

  const speech = frame.speechRatio ?? 0;
  const harm = frame.harmonicity ?? 0;
  const voiced = frame.voiced ?? 0;
  const flat = frame.flatness ?? 1;
  const zcr = frame.zcr ?? 0.2;
  const rmsDb = frame.rmsDb ?? (20 * Math.log10(rms + 1e-12));

  // Level prior: silence low, speech mid, clipping less speech-like
  let level = 0;
  if (rmsDb > -52 && rmsDb < -8) level = 1;
  else if (rmsDb > -58 && rmsDb <= -52) level = 0.55;
  else if (rmsDb >= -8) level = 0.35;

  const structure = 0.4 * speech + 0.3 * harm + 0.2 * voiced + 0.1 * (1 - Math.min(1, flat));
  const noisePen = Math.min(1, Math.max(0, (zcr - 0.15) * 3.5 + (flat - 0.6) * 1.5));
  return Math.max(0, Math.min(1, level * structure * (1 - 0.5 * noisePen)));
}

/**
 * Build per-frame soft VAD series from feature extraction result.
 * @param {object} extraction extractFrameFeatures result
 * @param {object} [opts]
 * @returns {{ scores: Float32Array, active: boolean[], hopSec: number, threshold: number }}
 */
export function softVadFromExtraction(extraction, opts = {}) {
  const frames = extraction?.frames || [];
  const threshold = opts.threshold ?? 0.45;
  const ctx = { noiseFloor: extraction?.noiseFloor };
  const scores = new Float32Array(frames.length);
  const active = new Array(frames.length);
  for (let i = 0; i < frames.length; i++) {
    scores[i] = softVadFromFrame(frames[i], ctx);
    active[i] = scores[i] >= threshold;
  }
  // light temporal smooth (3-tap)
  for (let i = 1; i < scores.length - 1; i++) {
    scores[i] = 0.25 * scores[i - 1] + 0.5 * scores[i] + 0.25 * scores[i + 1];
    active[i] = scores[i] >= threshold;
  }
  return {
    scores,
    active,
    hopSec: extraction?.hopSec ?? 0.01,
    threshold,
    source: 'classical',
  };
}

/**
 * Resample an irregular/low-rate VAD series onto analysis frame times.
 * @param {Float32Array|number[]} vadTimes seconds
 * @param {Float32Array|number[]} vadScores 0..1
 * @param {number[]} frameTimes seconds
 */
export function alignVadToFrames(vadTimes, vadScores, frameTimes) {
  const out = new Float32Array(frameTimes.length);
  if (!vadTimes?.length || !vadScores?.length) return out;
  let j = 0;
  for (let i = 0; i < frameTimes.length; i++) {
    const t = frameTimes[i];
    while (j < vadTimes.length - 1 && vadTimes[j + 1] <= t) j++;
    out[i] = vadScores[j] ?? 0;
  }
  return out;
}

/**
 * Blend classical + ML soft scores (prefer ML when present).
 * @param {Float32Array} classical
 * @param {Float32Array|null} ml
 * @param {number} [mlWeight]
 */
export function blendVadScores(classical, ml, mlWeight = 0.7) {
  if (!ml || !ml.length) return classical;
  const n = Math.min(classical.length, ml.length);
  const out = new Float32Array(classical.length);
  const w = Math.max(0, Math.min(1, mlWeight));
  for (let i = 0; i < n; i++) {
    out[i] = (1 - w) * classical[i] + w * ml[i];
  }
  for (let i = n; i < classical.length; i++) out[i] = classical[i];
  return out;
}

export default {
  softVadFromFrame,
  softVadFromExtraction,
  alignVadToFrames,
  blendVadScores,
};
