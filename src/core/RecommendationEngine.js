/**
 * VoiceIsolate Pro — Recommendation Engine (Layer 1: Core)
 *
 * Maps full-analysis results to preset + stage configuration with
 * explainable reasoning. Pure module.
 */
'use strict';

import { whisperProcessingPolicy } from './WhisperLogic.js';
import { bootstrapScenario, clampGainStaging, HUM_DEFAULTS } from './DspCalibration.js';
import { revalidatePreset } from './CapabilityRegistry.js';
import { resolveEngineerProcessingConfig, getStandardDefaultOverrides, STANDARD_DEFAULT, STANDARD_CANONICAL_KEYS, CALIBRATED_ENGINEER_PRESETS } from './PresetCalibration.js';

/** Engineer Mode preset names that remain after cleanup. */
export const ENGINEER_PRESET_CATALOG = Object.freeze([
  'Voice Clarity',
  'Podcast Clean',
  'Whisper Boost',
  'Phone/Radio',
  'Room Echo Reduction',
  'Hum Removal',
  'Forensic Extract',
  'Aggressive Isolate',
  'Surveillance',
]);

/**
 * @typedef {object} Recommendation
 * @property {string} recommendedPreset
 * @property {Record<string, number>} recommendedStageConfig
 * @property {object} recommendedProcessingPlan
 * @property {string[]} reasons
 * @property {string[]} findings
 * @property {boolean} autoApplySafe
 * @property {number} confidence
 */

/**
 * Build recommendations from a structured analysis object.
 * @param {object} analysis
 * @returns {Recommendation}
 */
export function recommendFromAnalysis(analysis) {
  if (!analysis) {
    return emptyRecommendation('No analysis available');
  }

  const findings = [];
  const reasons = [];
  let preset = 'Voice Clarity';
  let scenario = 'cleanSpeech';
  let confidence = 0.55;

  const snr = analysis.snrDb ?? analysis.confidenceScores?.snrDb ?? 12;
  const hum = analysis.humProfile || {};
  const room = analysis.roomEstimate || analysis.reverbEstimate || 0;
  const reverb = typeof room === 'number' ? room : (room.amount ?? 0);
  const whisperRegions = analysis.whisperRegions || [];
  const difficult = analysis.difficultSpeechRegions || [];
  const music = analysis.musicSegments || [];
  const speakers = analysis.speakerSegments || [];
  const overlap = analysis.overlapRegions || [];
  const rmsDb = analysis.rms != null
    ? 20 * Math.log10(analysis.rms + 1e-12)
    : (analysis.loudnessEstimate ?? -30);

  // Input file level vs its quietest 10% of frames: not the post-Process
  // header SNR (kept vs removed stems), so it can differ in sign.
  findings.push(`Input SNR estimate ≈ ${snr.toFixed ? snr.toFixed(1) : snr} dB (file level vs its quietest 10% of frames)`);
  findings.push(`Level ≈ ${Number(rmsDb).toFixed(1)} dBFS RMS`);

  if (hum.present || (hum.strength && hum.strength > 0.15)) {
    findings.push(`Hum suspected near ${hum.freq || 60} Hz (strength ${(hum.strength || 0).toFixed(2)})`);
  }
  if (reverb > 0.35) findings.push(`Elevated room/reverb estimate (${reverb.toFixed(2)})`);
  if (whisperRegions.length) findings.push(`${whisperRegions.length} faint-speech region(s)`);
  if (difficult.length) findings.push(`${difficult.length} difficult-speech zone(s)`);
  if (music.length) findings.push(`${music.length} music-bed segment(s)`);
  if (speakers.length) findings.push(`Speaker activity segments: ${speakers.length}`);
  if (overlap.length) findings.push(`${overlap.length} likely overlap region(s)`);

  // Preset decision tree (ordered by specificity)
  if (whisperRegions.length >= 1 && (rmsDb < -36 || snr < 10)) {
    preset = 'Whisper Boost';
    scenario = 'whisper';
    reasons.push('Faint speech regions + low level → Whisper Boost');
    confidence = 0.72;
  } else if (snr < 6 && reverb < 0.5) {
    preset = 'Forensic Extract';
    scenario = 'forensic';
    reasons.push('Very low SNR → Forensic Extract (artifact risk — review manually)');
    confidence = 0.65;
  } else if (music.length >= 2 || (analysis.confidenceScores?.musicRatio || 0) > 0.35) {
    preset = 'Aggressive Isolate';
    scenario = 'noisy';
    reasons.push('Music bed present → Aggressive Isolate to suppress accompaniment');
    confidence = 0.68;
  } else if (reverb > 0.45) {
    preset = 'Room Echo Reduction';
    scenario = 'podcast';
    reasons.push('High reverb estimate → Room Echo Reduction');
    confidence = 0.7;
  } else if (hum.present && (hum.strength || 0) > 0.2 && snr > 8) {
    preset = 'Hum Removal';
    scenario = 'cleanSpeech';
    reasons.push('Strong hum profile → Hum Removal');
    confidence = 0.75;
  } else if (snr < 12) {
    preset = 'Surveillance';
    scenario = 'noisy';
    reasons.push('Moderate noise → Surveillance field preset');
    confidence = 0.62;
  } else if (analysis.confidenceScores?.bandwidthLimited) {
    preset = 'Phone/Radio';
    scenario = 'noisy';
    reasons.push('Band-limited spectrum → Phone/Radio');
    confidence = 0.7;
  } else if ((analysis.confidenceScores?.speechRatio || 0.5) > 0.55 && snr > 14) {
    preset = 'Podcast Clean';
    scenario = 'podcast';
    reasons.push('Clean speech-dominant content → Podcast Clean');
    confidence = 0.78;
  } else {
    preset = 'Voice Clarity';
    scenario = 'cleanSpeech';
    reasons.push('Default balanced isolation → Voice Clarity');
    confidence = 0.6;
  }

  // UI-01 (LOCAL 2026-11-25): the decision tree above may still name a
  // disabled preset (music bed → Aggressive Isolate, high reverb → Room
  // Echo Reduction). Route through the capability registry — never
  // recommend a disabled capability. The registry is the authority; there
  // is no hardcoded list here.
  {
    const checked = revalidatePreset(preset);
    if (checked.substituted) {
      preset = checked.preset;
      scenario = 'cleanSpeech';
      reasons.push(checked.reason);
      confidence = Math.min(confidence, 0.6);
    }
  }

  const whisperPolicy = whisperProcessingPolicy(
    { whisperRegions, difficultSpeechRegions: difficult },
    { snrDb: snr },
  );
  reasons.push(...whisperPolicy.notes);

  const base = bootstrapScenario(scenario);
  /** @type {Record<string, number>} */
  const stageConfig = { ...base };

  // Apply whisper policy overlays
  if (whisperPolicy.activateWhisperPath) {
    stageConfig.gateThresh = Math.min(stageConfig.gateThresh, whisperPolicy.gateThreshDb);
    stageConfig.nrFloor = Math.min(stageConfig.nrFloor ?? -68, whisperPolicy.nrFloorDb);
    stageConfig.whisperLift = whisperPolicy.whisperLiftDb;
    stageConfig.whisperMode = whisperPolicy.confidence >= 0.6 ? 1 : 0;
    stageConfig.eqPresence = Math.max(stageConfig.eqPresence || 0, whisperPolicy.formantBoost);
  }

  if (hum.present && (hum.strength || 0) > 0.12) {
    stageConfig.humRemoval = Math.round(HUM_DEFAULTS.strength * Math.min(1, hum.strength * 2));
    stageConfig.phaseCorr = Math.max(stageConfig.phaseCorr || 0, 10);
  }

  if (reverb > 0.3) {
    stageConfig.derevAmt = Math.round(20 + reverb * 55);
    stageConfig.derevDecay = Math.round(30 + reverb * 40);
  }

  if (music.length || (analysis.confidenceScores?.musicRatio || 0) > 0.25) {
    stageConfig.musicKill = Math.round(40 + (analysis.confidenceScores?.musicRatio || 0.3) * 50);
    stageConfig.bgSuppress = Math.max(stageConfig.bgSuppress || 0, 50);
    stageConfig.voiceIso = Math.max(stageConfig.voiceIso || 70, 85);
  }

  // Impulses: car horns, barks, claps — suppress without nuking speech formants
  const transients = analysis.transientSegments || [];
  if (transients.length >= 2) {
    findings.push(`${transients.length} impulsive event region(s) (horns / barks / claps)`);
    stageConfig.crowdNull = Math.max(stageConfig.crowdNull || 0, Math.min(100, 45 + transients.length * 6));
    stageConfig.nrAmount = Math.max(stageConfig.nrAmount || 0, 55);
    stageConfig.transientShaper = Math.min(stageConfig.transientShaper || 0, -10);
    reasons.push('Impulsive noise map → crowdNull + NR while protecting speech zones');
    confidence = Math.min(confidence + 0.03, 0.82);
  }

  if (overlap.length) {
    // Conservative isolation to reduce artifacts on overlaps
    stageConfig.voiceIso = Math.min(stageConfig.voiceIso || 80, 78);
    stageConfig.crosstalkCancel = Math.min(25, 8 + overlap.length * 4);
    reasons.push('Overlap regions → reduced isolation strength to limit artifacts');
    confidence *= 0.92;
  }

  // Gain staging safety
  const g = clampGainStaging(stageConfig.compMakeup || 0, stageConfig.outGain || 0);
  stageConfig.compMakeup = g.makeupDb;
  stageConfig.outGain = g.outGainDb;
  if (g.limited) reasons.push('Gain staging clamped to prevent clipping');

  // DSP-01 (LOCAL 2026-11-25): prune canonical keys that still carry
  // their scenario-base value. The stage config is overlaid ONTO the
  // preset at application time (Object.assign over preset values), so a
  // base value here would silently undo the preset's canonical value —
  // e.g. gateThresh -44 (cleanSpeech base) clobbering the Standard -58.
  // A key an overlay deliberately changed is kept: that is a genuine
  // divergence, recorded by the resolver below.
  pruneUnchangedCanonicalKeys(stageConfig, base);

  const autoApplySafe = Boolean(
    whisperPolicy.autoApplySafe !== false
    && confidence >= 0.62
    && snr > 4
    && !(preset === 'Forensic Extract' && snr < 5),
  );

  if (!autoApplySafe) {
    reasons.push('Auto-apply gated: review recommendations before processing');
  }

  const recommendedProcessingPlan = {
    steps: [
      { id: 'decode', label: 'Local decode (already done if analyzing)' },
      { id: 'ml-isolate', label: 'ML stem separation (Demucs/BSRNN/RNNoise when available)' },
      { id: 'spectral', label: 'Single-pass spectral cleanup (one STFT → ops → one iSTFT)' },
      { id: 'whisper', label: whisperPolicy.activateWhisperPath ? 'Whisper-region careful enhance' : 'Skip whisper path' },
      { id: 'live-mix', label: 'Load result into Live-Mix for real-time EQ/gate' },
      { id: 'export', label: 'Export clean stem when satisfied' },
    ],
    emphasize: emphasizeStages(preset, stageConfig),
    preserveMusic: (analysis.confidenceScores?.preserveMusic === true),
    whisperPolicy,
    modelChain: pickModelChain(analysis),
  };

  // DSP-01 (LOCAL 2026-11-25): resolve the recommendation into the
  // processing config it would actually produce when applied. Effective
  // values = the recommended preset's numbers, overlaid with this plan's
  // stage config (stage overlays win — that is the application order:
  // preset first, then stage). The resolution records whether the plan is
  // the canonical Standard config, diverged from it (a stage overlay
  // moved a canonical key), or another preset's config — requested vs
  // effective, no silent downgrade. A disabled preset can never reach
  // this point: it was re-routed above.
  let resolvedProcessingConfig = null;
  let resolution = null;
  try {
    const presetNumbers = preset === STANDARD_DEFAULT.profile
      ? getStandardDefaultOverrides()
      : presetNumbersFor(preset);
    const effectiveValues = { ...presetNumbers, ...stageConfig };
    const resolved = resolveEngineerProcessingConfig(effectiveValues, preset, { source: 'recommendation-engine' });
    resolvedProcessingConfig = resolved.config;
    resolution = resolved.resolution;
    if (resolution.mode === 'diverged') {
      reasons.push(`Recommendation diverges from the Standard config: ${resolution.divergences.map((d) => `${d.id}=${d.requested}`).join(', ')} (stage overlay).`);
    }
    if (resolution.mode === 'standard' && resolution.substitutions.length > 0) {
      reasons.push(`Standard config resolved with substitutions: ${resolution.substitutions.map((s) => `${s.id}=${s.effective}`).join(', ')}.`);
    }
  } catch (err) {
    // A corrupt stage value must fail the recommendation explicitly, not
    // silently produce a legacy config.
    reasons.push(`Processing-plan resolution failed: ${err?.message || err}`);
    return {
      recommendedPreset: preset,
      recommendedStageConfig: stageConfig,
      recommendedProcessingPlan,
      reasons,
      findings,
      autoApplySafe: false,
      confidence: Math.max(0, Math.min(1, confidence)),
      resolvedProcessingConfig: null,
      resolution: { mode: 'rejected', divergences: [], substitutions: [], error: String(err?.message || err) },
    };
  }
  recommendedProcessingPlan.resolvedProcessingConfig = resolvedProcessingConfig;

  return {
    recommendedPreset: preset,
    recommendedStageConfig: stageConfig,
    recommendedProcessingPlan,
    reasons,
    findings,
    autoApplySafe,
    confidence: Math.max(0, Math.min(1, confidence)),
    resolvedProcessingConfig,
    resolution,
  };
}

/**
 * Numeric values of a named preset (numbers only), for plan resolution.
 * @param {string} name
 * @returns {Record<string, number>}
 */
function presetNumbersFor(name) {
  const preset = CALIBRATED_ENGINEER_PRESETS[name];
  if (!preset) return {};
  const out = {};
  for (const [k, v] of Object.entries(preset)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/**
 * Remove canonical keys from a stage config when they still equal the
 * scenario-base value they were constructed from. Such a key is not a
 * tuning decision — it is a construction artifact that would silently
 * undo the recommended preset's canonical value when the stage config is
 * overlaid onto the preset at application time. Keys an overlay
 * deliberately changed are kept (genuine divergence, recorded by the
 * resolver). Mutates and returns the stage config.
 * @param {Record<string, number>} stageConfig
 * @param {Record<string, number>} base scenario-base values
 * @returns {Record<string, number>}
 */
function pruneUnchangedCanonicalKeys(stageConfig, base) {
  for (const id of Object.keys(STANDARD_CANONICAL_KEYS)) {
    if (stageConfig[id] !== undefined && base[id] !== undefined && stageConfig[id] === base[id]) {
      delete stageConfig[id];
    }
  }
  return stageConfig;
}

function emphasizeStages(preset, cfg) {
  const stages = [];
  if ((cfg.nrAmount || 0) > 60) stages.push('Noise reduction');
  if ((cfg.derevAmt || 0) > 25) stages.push('Dereverb');
  if ((cfg.humRemoval || 0) > 30) stages.push('Hum removal');
  if ((cfg.whisperLift || 0) > 0) stages.push('Whisper lift');
  if ((cfg.musicKill || 0) > 40) stages.push('Music suppression');
  if ((cfg.voiceIso || 0) > 80) stages.push('Voice isolation');
  if (preset === 'Podcast Clean') stages.push('De-esser', 'Broadcast EQ');
  return stages;
}

function pickModelChain(analysis) {
  const memPressure = analysis.platformHints?.lowMemory;
  if (memPressure) return ['rnnoise', 'bsrnn'];
  if ((analysis.confidenceScores?.musicRatio || 0) > 0.3) return ['demucs', 'rnnoise'];
  return ['demucs', 'rnnoise'];
}

function emptyRecommendation(msg) {
  const stageConfig = bootstrapScenario('cleanSpeech');
  pruneUnchangedCanonicalKeys(stageConfig, { ...stageConfig });
  let resolved = null;
  try {
    resolved = resolveEngineerProcessingConfig(
      { ...getStandardDefaultOverrides(), ...stageConfig },
      STANDARD_DEFAULT.profile,
      { source: 'recommendation-engine-empty' },
    );
  } catch { /* empty recommendation stays unresolved */ }
  return {
    recommendedPreset: 'Voice Clarity',
    recommendedStageConfig: stageConfig,
    recommendedProcessingPlan: {
      steps: [],
      emphasize: [],
      whisperPolicy: whisperProcessingPolicy({ whisperRegions: [], difficultSpeechRegions: [] }),
      modelChain: ['rnnoise'],
      resolvedProcessingConfig: resolved?.config || null,
    },
    reasons: [msg],
    findings: [],
    autoApplySafe: false,
    confidence: 0,
    resolvedProcessingConfig: resolved?.config || null,
    resolution: resolved?.resolution || { mode: 'rejected', divergences: [], substitutions: [], error: 'unresolved' },
  };
}

export default {
  ENGINEER_PRESET_CATALOG,
  recommendFromAnalysis,
};
