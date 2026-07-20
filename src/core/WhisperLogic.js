/**
 * VoiceIsolate Pro — Whisper / Low-Level Speech Logic (Layer 1: Core)
 *
 * Detects likely whisper and difficult-speech regions using classical
 * features (and optional soft VAD scores). Does NOT transcribe or invent words.
 * Pure module.
 */
'use strict';

import { framesToSegments, majoritySmooth, labelFrames } from './SegmentMerger.js';

/**
 * Per-frame whisper confidence in [0, 1].
 * High when: low RMS, moderate speech-band energy, some harmonicity,
 * not pure noise (flatness not extreme), not pure silence.
 *
 * @param {object} frame feature frame from FeatureExtractor
 * @param {object} [ctx] { noiseFloor, snrDb }
 */
export function whisperFrameConfidence(frame, ctx = {}) {
  const noiseFloor = ctx.noiseFloor ?? 0.001;
  const rms = frame.rms ?? 0;
  const rmsDb = frame.rmsDb ?? (20 * Math.log10(rms + 1e-12));

  // Too quiet → silence, not whisper
  if (rms < noiseFloor * 1.2 && rmsDb < -55) return 0;
  // Loud speech is not whisper
  if (rmsDb > -28) return 0;

  const speech = frame.speechRatio ?? 0;
  const harm = frame.harmonicity ?? 0;
  const flat = frame.flatness ?? 1;
  const voiced = frame.voiced ?? 0;
  const zcr = frame.zcr ?? 0;

  // Quiet but structured speech band
  const levelScore = rmsDb > -52 && rmsDb < -30
    ? 1
    : rmsDb > -58 && rmsDb <= -52
      ? 0.75
      : rmsDb >= -30 && rmsDb < -28
        ? 0.35
        : 0.15;

  const structure = 0.35 * speech + 0.3 * harm + 0.2 * voiced + 0.15 * (1 - Math.min(1, flat));
  // Penalize pure noise (high ZCR + high flatness)
  const noisePen = Math.min(1, Math.max(0, (zcr - 0.12) * 4 + (flat - 0.55) * 2));
  const conf = Math.max(0, Math.min(1, levelScore * structure * (1 - 0.55 * noisePen)));
  return conf;
}

/**
 * Difficult speech: speech-like but low SNR / buried.
 * @param {object} frame
 * @param {object} [ctx]
 */
export function difficultSpeechConfidence(frame, ctx = {}) {
  const snrDb = ctx.snrDb ?? 10;
  const speech = frame.speechRatio ?? 0;
  const rmsDb = frame.rmsDb ?? -60;
  const harm = frame.harmonicity ?? 0;
  if (speech < 0.12 && harm < 0.08) return 0;
  if (rmsDb < -58) return 0;
  const buried = snrDb < 8 ? 1 : snrDb < 14 ? 0.6 : 0.2;
  return Math.max(0, Math.min(1, buried * (0.5 * speech + 0.5 * harm)));
}

/**
 * Detect whisper and difficult-speech regions from feature frames.
 * @param {object} extraction result of extractFrameFeatures
 * @param {object} [opts]
 * @returns {{ whisperRegions: Array, difficultSpeechRegions: Array, frameScores: Array }}
 */
export function detectWhisperRegions(extraction, opts = {}) {
  const frames = extraction.frames || [];
  const hopSec = extraction.hopSec ?? 0.01;
  const minWhisperConf = opts.minWhisperConf ?? 0.42;
  const minDifficultConf = opts.minDifficultConf ?? 0.4;
  const ctx = {
    noiseFloor: extraction.noiseFloor,
    snrDb: extraction.snrDb,
  };

  const frameScores = frames.map((f) => {
    const whisper = whisperFrameConfidence(f, ctx);
    const difficult = difficultSpeechConfidence(f, ctx);
    return { t: f.t, whisper, difficult };
  });

  const whisperActive = majoritySmooth(frameScores.map((s) => s.whisper >= minWhisperConf), 3);
  const difficultActive = majoritySmooth(frameScores.map((s) => s.difficult >= minDifficultConf), 3);

  const whisperLabeled = labelFrames(
    frames,
    (_, i) => (whisperActive[i] ? 'whisper' : 'other'),
    (_, i) => frameScores[i].whisper,
  );
  const difficultLabeled = labelFrames(
    frames,
    (_, i) => (difficultActive[i] ? 'difficult' : 'other'),
    (_, i) => frameScores[i].difficult,
  );

  const whisperRegions = framesToSegments(
    whisperLabeled.filter((x) => x.label === 'whisper'),
    hopSec,
    { minSec: 0.15, mergeGapSec: 0.2 },
  ).map((s) => ({
    start: s.start,
    end: s.end,
    confidence: s.confidence,
    label: 'whisper',
    explanation: 'Low-level speech-like energy with formant structure (not transcription)',
  }));

  const difficultSpeechRegions = framesToSegments(
    difficultLabeled.filter((x) => x.label === 'difficult'),
    hopSec,
    { minSec: 0.2, mergeGapSec: 0.25 },
  ).map((s) => ({
    start: s.start,
    end: s.end,
    confidence: s.confidence,
    label: 'difficultSpeech',
    explanation: 'Speech-like content with low estimated SNR — needs careful enhancement',
  }));

  return { whisperRegions, difficultSpeechRegions, frameScores };
}

/**
 * Processing policy for whisper / difficult regions (feeds recommendation + offline).
 * Conservative when confidence is low.
 * @param {{ whisperRegions: Array, difficultSpeechRegions: Array }} regions
 * @param {object} [globalCtx]
 */
export function whisperProcessingPolicy(regions, globalCtx = {}) {
  const w = regions.whisperRegions || [];
  const d = regions.difficultSpeechRegions || [];
  const maxW = w.reduce((m, s) => Math.max(m, s.confidence || 0), 0);
  const maxD = d.reduce((m, s) => Math.max(m, s.confidence || 0), 0);
  const hasWhisper = w.length > 0 && maxW >= 0.45;
  const hasDifficult = d.length > 0 && maxD >= 0.4;

  // Base safe defaults
  const policy = {
    activateWhisperPath: hasWhisper,
    activateDifficultPath: hasDifficult,
    gateThreshDb: hasWhisper ? -68 : -52,
    gateRangeDepth: hasWhisper ? 12 : 24, // shallower gate for whispers
    nrFloorDb: hasWhisper ? -78 : -68,
    whisperLiftDb: hasWhisper ? Math.round(8 + maxW * 14) : 0,
    protectConsonants: true,
    overGateProtection: true,
    formantBoost: hasWhisper ? Math.min(4, 1.5 + maxW * 2.5) : 0,
    confidence: Math.max(maxW, maxD),
    autoApplySafe: maxW >= 0.55 || maxD >= 0.6,
    notes: [],
  };

  if (hasWhisper) {
    policy.notes.push(
      `Detected ${w.length} likely faint-speech region(s) (peak conf ${(maxW * 100).toFixed(0)}%). ` +
      'Using shallower gating and in-region lift — not inventing words.',
    );
  }
  if (hasDifficult) {
    policy.notes.push(
      `Detected ${d.length} hard-to-hear speech zone(s). Prefer conservative isolation over aggressive NR.`,
    );
  }
  if (globalCtx.snrDb != null && globalCtx.snrDb < 6) {
    policy.notes.push('Very low SNR: prefer Forensic/Surveillance presets with manual review.');
    policy.autoApplySafe = false;
  }
  return policy;
}

export default {
  whisperFrameConfidence,
  difficultSpeechConfidence,
  detectWhisperRegions,
  whisperProcessingPolicy,
};
