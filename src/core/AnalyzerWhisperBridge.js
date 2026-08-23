/**
 * VoiceIsolate Pro — Analyzer ↔ WhisperHunter collaboration bridge (Layer 1: Core)
 *
 * Pure module. No DOM, no workers, no network.
 *
 * Goal: full-file analysis (Source Analysis Workspace) and WhisperHunter AI
 * share one joint map of:
 *   - protect regions  → speech / whisper / difficult speech (amplify & isolate)
 *   - suppress regions → music, broadband noise, hum, impulses (horns, barks…), reverb
 *
 * Does NOT invent words or run cloud ASR. Local classical + optional hunter env only.
 */
'use strict';

import { whisperProcessingPolicy } from './WhisperLogic.js';
import { recommendFromAnalysis } from './RecommendationEngine.js';

/** Unwanted sound classes we care about for isolation UX. */
export const UNWANTED_CLASSES = Object.freeze([
  'music',
  'broadband',
  'hum',
  'impulse', // car horns, barks, door slams, claps
  'reverb',
  'crowd',
  'traffic',
]);

/**
 * Coverage of segment list vs total duration [0, 1].
 * @param {Array<{start:number,end:number}>} segments
 * @param {number} duration
 */
export function segmentCoverage(segments, duration) {
  if (!duration || duration <= 0 || !segments?.length) return 0;
  let sum = 0;
  for (const s of segments) {
    const a = Number(s.start) || 0;
    const b = Number(s.end) || a;
    sum += Math.max(0, b - a);
  }
  return Math.max(0, Math.min(1, sum / duration));
}

/**
 * Merge overlapping regions and sort by start.
 * @param {Array<{start:number,end:number,confidence?:number,label?:string}>} regions
 */
export function mergeRegions(regions, mergeGapSec = 0.08) {
  if (!regions?.length) return [];
  const sorted = regions
    .map((r) => ({
      start: Number(r.start) || 0,
      end: Math.max(Number(r.start) || 0, Number(r.end) || 0),
      confidence: Number.isFinite(Number(r.confidence)) ? Number(r.confidence) : 0.5,
      label: r.label || 'region',
      explanation: r.explanation,
    }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start);

  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + mergeGapSec) {
      last.end = Math.max(last.end, r.end);
      last.confidence = Math.max(last.confidence, r.confidence);
      if (r.label && last.label !== r.label) last.label = `${last.label}+${r.label}`;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/**
 * Classify unwanted sounds from a FullAnalysis result.
 * @param {object} analysis
 * @returns {object}
 */
export function classifyUnwantedSounds(analysis) {
  const duration = analysis?.duration || 0;
  const musicCov = segmentCoverage(analysis?.musicSegments, duration);
  const noiseCov = segmentCoverage(analysis?.noiseSegments, duration);
  const humCov = segmentCoverage(analysis?.humSegments, duration);
  const impulseCov = segmentCoverage(analysis?.transientSegments, duration);
  const reverbCov = segmentCoverage(analysis?.reverbSegments, duration);
  const speechCov = segmentCoverage(analysis?.speechSegments, duration);
  const whisperCov = segmentCoverage(analysis?.whisperRegions, duration);

  const snr = analysis?.snrDb ?? analysis?.confidenceScores?.snrDb ?? 12;
  const musicRatio = analysis?.confidenceScores?.musicRatio ?? musicCov;
  const humStrength = analysis?.humProfile?.strength ?? 0;
  const reverb = typeof analysis?.reverbEstimate === 'number'
    ? analysis.reverbEstimate
    : (analysis?.roomEstimate?.amount ?? analysis?.roomEstimate ?? 0);

  /** @type {Record<string, { present: boolean, severity: number, coverage: number, label: string, hint: string }>} */
  const classes = {
    music: {
      present: musicCov > 0.04 || musicRatio > 0.22,
      severity: Math.min(1, musicCov * 1.4 + musicRatio * 0.8),
      coverage: musicCov,
      label: 'Loud music / accompaniment',
      hint: 'Suppress harmonic bed (musicKill / voiceIso) while protecting speech formants.',
    },
    broadband: {
      present: noiseCov > 0.08 || snr < 12,
      severity: Math.min(1, noiseCov + (snr < 8 ? 0.45 : snr < 14 ? 0.25 : 0.1)),
      coverage: noiseCov,
      label: 'Broadband noise (hiss / fans / room hash)',
      hint: 'Raise spectral NR and gate carefully; shallower gate if whispers present.',
    },
    hum: {
      present: !!analysis?.humProfile?.present || humStrength > 0.12 || humCov > 0.03,
      severity: Math.min(1, Math.max(humStrength, humCov)),
      coverage: humCov,
      label: `Hum / buzz (~${analysis?.humProfile?.freq || 60} Hz)`,
      hint: 'Engage hum removal and a stereo mono-correlation blend.',
    },
    impulse: {
      present: impulseCov > 0.015,
      severity: Math.min(1, impulseCov * 3.5),
      coverage: impulseCov,
      label: 'Impulses (horns, barks, claps, door slams)',
      hint: 'Click/transient suppression + crowdNull; do not over-smooth consonants in speech zones.',
    },
    reverb: {
      present: reverb > 0.32 || reverbCov > 0.06,
      severity: Math.min(1, Math.max(reverb, reverbCov)),
      coverage: reverbCov,
      label: 'Room echo / reverb tail',
      hint: 'Dereverb + roomCorrection; protect late-energy whispers.',
    },
    crowd: {
      present: speechCov > 0.15 && noiseCov > 0.12 && musicRatio < 0.35 && snr < 14,
      severity: Math.min(1, (1 - Math.min(1, snr / 20)) * 0.6 + noiseCov * 0.5),
      coverage: Math.min(1, noiseCov + speechCov * 0.2),
      label: 'Crowd / multi-talker babble',
      hint: 'Voice isolation + modest crosstalk cancel; avoid nuclear NR on overlaps.',
    },
    traffic: {
      present: snr < 10 && noiseCov > 0.1 && musicRatio < 0.25 && reverb < 0.55,
      severity: Math.min(1, (10 - Math.min(10, snr)) / 10 * 0.7 + noiseCov * 0.4),
      coverage: noiseCov,
      label: 'Traffic / outdoor rumble',
      hint: 'Surveillance-style NR, HP filter, bass crush for low rumble.',
    },
  };

  const present = UNWANTED_CLASSES.filter((k) => classes[k].present);
  const primary = present
    .slice()
    .sort((a, b) => classes[b].severity - classes[a].severity)[0] || null;

  return {
    classes,
    present,
    primary,
    speechCoverage: speechCov,
    whisperCoverage: whisperCov,
    snrDb: snr,
  };
}

/**
 * Build protect vs suppress region maps for isolation.
 * @param {object} analysis
 */
export function buildRegionMaps(analysis) {
  const protect = mergeRegions([
    ...(analysis?.speechSegments || []).map((s) => ({ ...s, label: s.label || 'speech' })),
    ...(analysis?.whisperRegions || []).map((s) => ({ ...s, label: 'whisper' })),
    ...(analysis?.difficultSpeechRegions || []).map((s) => ({ ...s, label: 'difficult' })),
  ], 0.12);

  const suppress = mergeRegions([
    ...(analysis?.musicSegments || []).map((s) => ({ ...s, label: 'music' })),
    ...(analysis?.noiseSegments || []).map((s) => ({ ...s, label: 'noise' })),
    ...(analysis?.transientSegments || []).map((s) => ({ ...s, label: 'impulse' })),
    ...(analysis?.humSegments || []).map((s) => ({ ...s, label: 'hum' })),
    ...(analysis?.reverbSegments || []).map((s) => ({ ...s, label: 'reverb' })),
  ], 0.1);

  // Voice-only protect: times that are speech/whisper and not pure suppress-only
  const voiceOnly = protect.filter((p) => {
    const mid = (p.start + p.end) / 2;
    const heavySuppress = suppress.some(
      (s) => mid >= s.start && mid <= s.end && (s.label === 'music' || s.label === 'impulse'),
    );
    // Keep protect even under music — that's the isolation target
    return !heavySuppress || p.label === 'whisper' || p.label === 'speech' || p.label === 'difficult';
  });

  return { protectRegions: protect, suppressRegions: suppress, voiceProtectRegions: voiceOnly };
}

/**
 * Fuse WhisperHunter environment profile into analyzer language.
 * @param {object} analysis
 * @param {object|null} envProfile from analyzeAcousticEnvironment
 */
export function mergeHunterEnvWithAnalysis(analysis, envProfile) {
  if (!analysis) return { analysis: null, jointEnv: null };
  const unwanted = classifyUnwantedSounds(analysis);
  const env = envProfile || {};

  let dominantNoise = unwanted.primary || 'broadband';
  // Map analyzer primary → hunter vocabulary when hunter is weak
  const map = {
    music: 'music',
    impulse: 'crowd',
    broadband: 'crowd',
    hum: 'hum',
    reverb: 'crowd',
    crowd: 'crowd',
    traffic: 'traffic',
  };
  dominantNoise = map[dominantNoise] || dominantNoise;

  // Prefer hunter when it agrees with stronger analyzer signal
  if (env.dominantNoise === 'music' && (unwanted.classes.music.severity > 0.25 || env.musicRatio > 0.45)) {
    dominantNoise = 'music';
  } else if (env.dominantNoise === 'traffic' && unwanted.classes.traffic.present) {
    dominantNoise = 'traffic';
  } else if (env.dominantNoise === 'hum' && unwanted.classes.hum.present) {
    dominantNoise = 'hum';
  } else if (unwanted.classes.music.severity > 0.4) {
    dominantNoise = 'music';
  } else if (unwanted.classes.impulse.severity > 0.35) {
    dominantNoise = 'crowd';
  }

  const speechCov = unwanted.speechCoverage;
  const whisperCov = unwanted.whisperCoverage;
  const voiceRatio = Math.max(
    Number(env.voiceRatio) || 0,
    speechCov * 0.85 + whisperCov * 0.5,
  );
  const musicRatio = Math.max(
    Number(env.musicRatio) || 0,
    unwanted.classes.music.severity,
  );
  const speechPresence = Math.max(
    Number(env.speechPresence) || 0,
    Math.min(1, speechCov * 1.4 + whisperCov),
  );

  const rt60 = Number.isFinite(env.rt60)
    ? Math.round(
      env.rt60 * 0.55
      + (unwanted.classes.reverb.severity * 900) * 0.45,
    )
    : Math.round(200 + unwanted.classes.reverb.severity * 800);

  const jointEnv = {
    rt60,
    dominantNoise,
    noiseFloor: env.noiseFloor ?? analysis.globalNoiseProfile?.floorDb ?? -40,
    speechPresence,
    voiceRatio,
    musicRatio,
    // Extended joint fields
    snrDb: unwanted.snrDb,
    hasWhisper: whisperCov > 0.01 || (analysis.whisperRegions || []).length > 0,
    hasDifficult: (analysis.difficultSpeechRegions || []).length > 0,
    unwantedPrimary: unwanted.primary,
    impulseSeverity: unwanted.classes.impulse.severity,
    humSeverity: unwanted.classes.hum.severity,
    broadbandSeverity: unwanted.classes.broadband.severity,
    source: envProfile ? 'analyzer+hunter' : 'analyzer-only',
  };

  return { analysis, jointEnv, unwanted };
}

/**
 * Stage-config overlays from unwanted sound map + whisper policy.
 * Complements RecommendationEngine without replacing it.
 * @param {object} analysis
 * @param {object} [opts]
 */
export function buildIsolationStageConfig(analysis, opts = {}) {
  const baseRec = opts.recommendation || analysis?.recommendation || recommendFromAnalysis(analysis);
  const stage = { ...(baseRec.recommendedStageConfig || {}) };
  const unwanted = opts.unwanted || classifyUnwantedSounds(analysis);
  const regions = opts.regions || buildRegionMaps(analysis);
  const whisperPolicy = whisperProcessingPolicy(
    {
      whisperRegions: analysis?.whisperRegions || [],
      difficultSpeechRegions: analysis?.difficultSpeechRegions || [],
    },
    { snrDb: unwanted.snrDb },
  );

  const findings = [...(baseRec.findings || [])];
  const reasons = [...(baseRec.reasons || [])];

  // ── Unwanted sound → DSP knobs ─────────────────────────────────────────
  if (unwanted.classes.music.present) {
    const s = unwanted.classes.music.severity;
    stage.musicKill = Math.max(stage.musicKill || 0, Math.round(55 + s * 40));
    stage.bgSuppress = Math.max(stage.bgSuppress || 0, Math.round(48 + s * 35));
    stage.voiceIso = Math.max(stage.voiceIso || 70, Math.round(82 + s * 12));
    stage.bassCrush = Math.max(stage.bassCrush || 0, Math.round(40 + s * 45));
    reasons.push(`Music bed coverage ${(unwanted.classes.music.coverage * 100).toFixed(0)}% → musicKill/voiceIso`);
  }

  if (unwanted.classes.impulse.present) {
    const s = unwanted.classes.impulse.severity;
    // No dedicated click-removal slider — use crowdNull + NR + transient shaper
    stage.crowdNull = Math.max(stage.crowdNull || 0, Math.round(55 + s * 40));
    stage.nrAmount = Math.max(stage.nrAmount || 0, Math.round(50 + s * 25));
    stage.transientShaper = Math.round(
      Math.max(-35, Math.min(0, (stage.transientShaper || 0) * 0.5 - 12 - s * 10)),
    );
    findings.push(
      `Impulsive noise (horns / barks / claps) ~${(unwanted.classes.impulse.coverage * 100).toFixed(0)}% of file`,
    );
    reasons.push('Impulse map → crowdNull + NR; speech/whisper zones still protected');
  }

  if (unwanted.classes.broadband.present) {
    const s = unwanted.classes.broadband.severity;
    stage.nrAmount = Math.max(stage.nrAmount || 0, Math.round(55 + s * 35));
    stage.bgSuppress = Math.max(stage.bgSuppress || 0, Math.round(40 + s * 30));
    if (whisperPolicy.activateWhisperPath) {
      stage.gateThresh = Math.min(stage.gateThresh ?? -52, whisperPolicy.gateThreshDb);
      stage.nrFloor = Math.min(stage.nrFloor ?? -68, whisperPolicy.nrFloorDb);
    } else {
      stage.gateThresh = Math.min(stage.gateThresh ?? -48, -50 - s * 8);
    }
  }

  if (unwanted.classes.hum.present) {
    const s = unwanted.classes.hum.severity;
    stage.humRemoval = Math.max(stage.humRemoval || 0, Math.round(45 + s * 50));
    stage.phaseCorr = Math.max(stage.phaseCorr || 0, Math.round(12 + s * 20));
  }

  if (unwanted.classes.reverb.present) {
    const s = unwanted.classes.reverb.severity;
    stage.derevAmt = Math.max(stage.derevAmt || 0, Math.round(28 + s * 50));
    stage.derevDecay = Math.max(stage.derevDecay || 0, Math.round(35 + s * 40));
    stage.roomCorrection = Math.max(stage.roomCorrection || 0, Math.round(25 + s * 40));
    stage.reverbStrip = Math.max(stage.reverbStrip || 0, Math.round(350 + s * 700));
  }

  if (unwanted.classes.traffic.present || unwanted.classes.crowd.present) {
    const s = Math.max(unwanted.classes.traffic.severity, unwanted.classes.crowd.severity);
    stage.voiceIso = Math.max(stage.voiceIso || 70, Math.round(80 + s * 15));
    stage.crowdNull = Math.max(stage.crowdNull || 0, Math.round(50 + s * 40));
    stage.hpFreq = Math.max(stage.hpFreq || 80, Math.round(90 + s * 40));
  }

  // ── Protect voices & whispers (amplify / isolate) ──────────────────────
  if (whisperPolicy.activateWhisperPath || unwanted.whisperCoverage > 0.01) {
    stage.whisperMode = Math.max(stage.whisperMode || 0, whisperPolicy.confidence >= 0.6 ? 2 : 1);
    stage.whisperLift = Math.max(stage.whisperLift || 0, whisperPolicy.whisperLiftDb || 10);
    stage.whisperClarity = Math.max(stage.whisperClarity || 0, Math.round(60 + whisperPolicy.confidence * 30));
    stage.whisperSensitivity = Math.max(stage.whisperSensitivity || 0, Math.round(55 + whisperPolicy.confidence * 25));
    stage.whisperThreshold = Math.max(stage.whisperThreshold || 0, Math.round(40 + (1 - whisperPolicy.confidence) * 25));
    stage.eqPresence = Math.max(stage.eqPresence || 0, whisperPolicy.formantBoost || 1.5);
    stage.harmRecov = Math.max(stage.harmRecov || 0, Math.round(12 + whisperPolicy.confidence * 18));
    findings.push(
      `${(analysis.whisperRegions || []).length} whisper / faint-speech region(s) marked for careful boost`,
    );
    reasons.push(...whisperPolicy.notes);
  } else if ((analysis?.speechSegments || []).length) {
    // Clean voice isolation without whisper path
    stage.voiceIso = Math.max(stage.voiceIso || 65, 78);
    stage.eqPresence = Math.max(stage.eqPresence || 0, 1.2);
    findings.push('Lead speech regions identified for isolation and mild presence lift');
  }

  if (unwanted.classes.impulse.present && whisperPolicy.activateWhisperPath) {
    // Don't let impulse kill bury whispers
    stage.gateThresh = Math.min(stage.gateThresh ?? -60, -66);
    reasons.push('Whispers + impulses: shallow gate so faint speech is not gated with horns/barks');
  }

  for (const key of unwanted.present) {
    const c = unwanted.classes[key];
    if (c.present) findings.push(`${c.label} (severity ${(c.severity * 100).toFixed(0)}%)`);
  }

  return {
    recommendedPreset: baseRec.recommendedPreset,
    recommendedStageConfig: stage,
    findings: dedupeStrings(findings),
    reasons: dedupeStrings(reasons),
    confidence: Math.min(1, (baseRec.confidence || 0.55) + (unwanted.present.length ? 0.05 : 0)),
    autoApplySafe: baseRec.autoApplySafe && !(unwanted.classes.impulse.severity > 0.7),
    whisperPolicy,
    protectRegions: regions.protectRegions,
    suppressRegions: regions.suppressRegions,
    voiceProtectRegions: regions.voiceProtectRegions,
    unwanted,
  };
}

/**
 * Full joint processing plan: analyzer + optional hunter env.
 * @param {object} analysis
 * @param {object|null} [envProfile]
 * @param {object} [opts]
 */
export function buildJointProcessingPlan(analysis, envProfile = null, opts = {}) {
  if (!analysis) {
    return {
      ok: false,
      error: 'No analysis',
      findings: [],
      reasons: [],
      recommendedPreset: 'Voice Clarity',
      recommendedStageConfig: {},
      protectRegions: [],
      suppressRegions: [],
      jointEnv: null,
      collaboration: { analyzer: false, hunter: false },
    };
  }

  const { jointEnv, unwanted } = mergeHunterEnvWithAnalysis(analysis, envProfile);
  const isolation = buildIsolationStageConfig(analysis, {
    unwanted,
    recommendation: opts.recommendation || analysis.recommendation,
  });

  // Hunter-driven preset nudge when analyzer is uncertain
  let preset = isolation.recommendedPreset;
  if (jointEnv?.dominantNoise === 'music' && (jointEnv.musicRatio || 0) > 0.4) {
    preset = 'Aggressive Isolate';
  } else if (jointEnv?.hasWhisper && (jointEnv.voiceRatio || 0) < 0.25) {
    preset = 'Whisper Boost';
  } else if (jointEnv?.dominantNoise === 'traffic') {
    preset = 'Surveillance';
  } else if ((jointEnv?.snrDb ?? 12) < 6 && !jointEnv?.hasWhisper) {
    preset = 'Forensic Extract';
  }

  const steps = [
    { id: 'analyze', label: 'Full-file analysis (sources, noise, whisper zones)' },
    { id: 'collaborate', label: 'Analyzer ↔ WhisperHunter joint map (protect / suppress)' },
    { id: 'ml-isolate', label: 'Local ML stem separation when models available' },
    { id: 'spectral', label: 'Single-pass spectral cleanup (one STFT → ops → one iSTFT)' },
    {
      id: 'whisper',
      label: isolation.whisperPolicy?.activateWhisperPath
        ? 'Careful whisper amplify in protect regions'
        : 'Voice isolate (no whisper path)',
    },
    { id: 'live-mix', label: 'Live-Mix preview (gate / de-ess / EQ)' },
    { id: 'export', label: 'Export clean voice when satisfied' },
  ];

  const collaboration = {
    analyzer: true,
    hunter: !!envProfile,
    primaryUnwanted: unwanted.primary,
    protectCount: isolation.protectRegions.length,
    suppressCount: isolation.suppressRegions.length,
    summary: summarizeCollaboration(unwanted, isolation, jointEnv),
  };

  return {
    ok: true,
    error: null,
    recommendedPreset: preset,
    recommendedStageConfig: isolation.recommendedStageConfig,
    findings: isolation.findings,
    reasons: isolation.reasons,
    confidence: isolation.confidence,
    autoApplySafe: isolation.autoApplySafe !== false && isolation.confidence >= 0.6,
    whisperPolicy: isolation.whisperPolicy,
    protectRegions: isolation.protectRegions,
    suppressRegions: isolation.suppressRegions,
    voiceProtectRegions: isolation.voiceProtectRegions,
    unwanted,
    jointEnv,
    steps,
    collaboration,
    emphasize: emphasizeFromStage(isolation.recommendedStageConfig, preset),
  };
}

/**
 * Slider morph targets for WhisperHunter when analysis already exists.
 * @param {object} analysis
 * @param {object|null} envProfile
 * @param {number} [maskConf]
 */
export function analysisToHunterSliderTargets(analysis, envProfile = null, maskConf = 0.5) {
  const plan = buildJointProcessingPlan(analysis, envProfile);
  const cfg = plan.recommendedStageConfig || {};
  const env = plan.jointEnv || {};
  const sep = Math.max(0, Math.min(1, (1 - maskConf) * 0.55 + (1 - (env.speechPresence || 0.4)) * 0.45));
  const impulse = env.impulseSeverity || plan.unwanted?.classes?.impulse?.severity || 0;
  const music = env.musicRatio || 0;

  return {
    preset: plan.recommendedPreset,
    sliders: {
      whisperClarity: Math.round(cfg.whisperClarity ?? (58 + sep * 32)),
      whisperSensitivity: Math.round(cfg.whisperSensitivity ?? (48 + (1 - (env.voiceRatio || 0.3)) * 38)),
      whisperThreshold: Math.round(cfg.whisperThreshold ?? (42 + sep * 48)),
      harmRecov: Math.round(cfg.harmRecov ?? ((env.voiceRatio || 0) < 0.25 ? 18 + sep * 22 : 8)),
      whisperLift: Math.round(cfg.whisperLift ?? (14 + sep * 24)),
      snrFloor: Math.round(cfg.snrFloor ?? (-78 + maskConf * 26)),
      crowdNull: Math.round(cfg.crowdNull ?? (68 + sep * 28 + impulse * 15)),
      musicKill: Math.round(
        cfg.musicKill
        ?? (env.dominantNoise === 'music' || music > 0.4
          ? 82 + sep * 16
          : 45 + sep * 20),
      ),
      bassCrush: Math.round(cfg.bassCrush ?? (55 + music * 40)),
      reverbStrip: Math.min(1200, Math.round(cfg.reverbStrip ?? ((env.rt60 || 400) * (0.85 + sep * 0.35)))),
      voiceTunnel: Math.round(cfg.voiceTunnel ?? (52 + maskConf * 38)),
      voiceIso: Math.round(cfg.voiceIso ?? 85),
      bgSuppress: Math.round(cfg.bgSuppress ?? 55),
      nrAmount: Math.round(cfg.nrAmount ?? (impulse > 0.1 ? 55 + impulse * 30 : 60)),
      humRemoval: Math.round(cfg.humRemoval ?? 0),
      derevAmt: Math.round(cfg.derevAmt ?? 0),
      whisperMode: cfg.whisperMode ?? (sep > 0.65 ? 3 : sep > 0.35 ? 2 : 1),
      transientShaper: Math.round(cfg.transientShaper ?? (impulse > 0.1 ? 12 + impulse * 15 : 12)),
    },
    plan,
  };
}

/**
 * Attach joint plan onto analysis object (mutates a shallow copy).
 * @param {object} analysis
 * @param {object|null} envProfile
 */
export function enrichAnalysisWithCollaboration(analysis, envProfile = null) {
  if (!analysis) return null;
  const plan = buildJointProcessingPlan(analysis, envProfile);
  return {
    ...analysis,
    jointPlan: plan,
    recommendedPreset: plan.recommendedPreset || analysis.recommendedPreset,
    recommendedStageConfig: {
      ...(analysis.recommendedStageConfig || {}),
      ...(plan.recommendedStageConfig || {}),
    },
    recommendation: {
      ...(analysis.recommendation || {}),
      recommendedPreset: plan.recommendedPreset,
      recommendedStageConfig: {
        ...(analysis.recommendation?.recommendedStageConfig || {}),
        ...(plan.recommendedStageConfig || {}),
      },
      findings: plan.findings,
      reasons: plan.reasons,
      confidence: plan.confidence,
      autoApplySafe: plan.autoApplySafe,
      recommendedProcessingPlan: {
        ...(analysis.recommendation?.recommendedProcessingPlan || {}),
        steps: plan.steps,
        emphasize: plan.emphasize,
        whisperPolicy: plan.whisperPolicy,
        collaboration: plan.collaboration,
      },
    },
    protectRegions: plan.protectRegions,
    suppressRegions: plan.suppressRegions,
  };
}

/**
 * After WhisperHunter finishes, fold results back into analysis for UI.
 * @param {object} analysis
 * @param {object} hunterResult { envProfile, maskConfidence, platform, message }
 */
export function applyHunterFeedbackToAnalysis(analysis, hunterResult = {}) {
  if (!analysis) return null;
  const env = hunterResult.envProfile || null;
  const enriched = enrichAnalysisWithCollaboration(analysis, env);
  enriched.hunterFeedback = {
    maskConfidence: hunterResult.maskConfidence ?? null,
    platform: hunterResult.platform || null,
    message: hunterResult.message || null,
    at: Date.now(),
  };
  if (typeof hunterResult.maskConfidence === 'number') {
    const mc = hunterResult.maskConfidence;
    enriched.confidenceScores = {
      ...(enriched.confidenceScores || {}),
      hunterMask: mc,
      analysisQuality: Math.min(
        0.95,
        (enriched.confidenceScores?.analysisQuality || 0.55) * 0.7 + mc * 0.3,
      ),
    };
  }
  return enriched;
}

function summarizeCollaboration(unwanted, isolation, jointEnv) {
  const parts = [];
  if (unwanted?.primary) {
    parts.push(`Primary interference: ${unwanted.classes[unwanted.primary]?.label || unwanted.primary}`);
  }
  parts.push(
    `Protect ${isolation.protectRegions?.length || 0} voice/whisper zone(s); suppress ${isolation.suppressRegions?.length || 0} noise zone(s)`,
  );
  if (jointEnv?.hasWhisper) parts.push('Faint speech path active (amplify carefully, no word invention)');
  if (jointEnv?.source) parts.push(`Map source: ${jointEnv.source}`);
  return parts.join(' · ');
}

function emphasizeFromStage(cfg, preset) {
  const stages = [];
  if ((cfg.musicKill || 0) > 40) stages.push('Music suppression');
  if ((cfg.crowdNull || 0) > 40) stages.push('Crowd / impulse null');
  if ((cfg.nrAmount || 0) > 55) stages.push('Noise reduction');
  if ((cfg.humRemoval || 0) > 30) stages.push('Hum removal');
  if ((cfg.derevAmt || 0) > 25) stages.push('Dereverb');
  if ((cfg.whisperLift || 0) > 0) stages.push('Whisper amplify');
  if ((cfg.voiceIso || 0) > 75) stages.push('Voice isolation');
  if (preset === 'Whisper Boost') stages.push('Whisper Boost preset');
  if (preset === 'Aggressive Isolate') stages.push('Aggressive Isolate preset');
  return stages;
}

function dedupeStrings(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr || []) {
    const t = String(s || '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

export default {
  UNWANTED_CLASSES,
  segmentCoverage,
  mergeRegions,
  classifyUnwantedSounds,
  buildRegionMaps,
  mergeHunterEnvWithAnalysis,
  buildIsolationStageConfig,
  buildJointProcessingPlan,
  analysisToHunterSliderTargets,
  enrichAnalysisWithCollaboration,
  applyHunterFeedbackToAnalysis,
};
