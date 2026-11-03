/** Convert legacy FullAnalysis output into the canonical intelligence AnalysisSnapshot. */
'use strict';

import { validateAnalysisSnapshot } from './IntelligenceContracts.js';

export const FULL_ANALYSIS_SNAPSHOT_VERSION = '1';
export const FULL_ANALYSIS_ANALYZER_VERSION = 'full-analysis-1';
export const AUTO_ANALYSIS_ANALYZER_VERSION = 'auto-analysis-1';

let localSessionCounter = 0;

function nextLocalSessionId() {
  localSessionCounter += 1;
  return `analysis-local-${Date.now().toString(36)}-${localSessionCounter.toString(36)}`;
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()))];
}

function certaintyFromConfidence(value) {
  if (!Number.isFinite(value)) return 'unknown';
  if (value >= 0.8) return 'high';
  if (value >= 0.5) return 'medium';
  if (value > 0) return 'low';
  return 'unknown';
}

function safeTime(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function assertRequiredInputMetadata(rawAnalysis) {
  if (!Number.isFinite(rawAnalysis.sampleRate) || rawAnalysis.sampleRate <= 0) {
    throw new TypeError('[VIP][AnalysisSnapshotAdapter] rawAnalysis.sampleRate must be a positive finite number');
  }
  if (!Number.isInteger(rawAnalysis.channels) || rawAnalysis.channels <= 0) {
    throw new TypeError('[VIP][AnalysisSnapshotAdapter] rawAnalysis.channels must be a positive integer');
  }
  if (!Number.isFinite(rawAnalysis.duration) || rawAnalysis.duration < 0) {
    throw new TypeError('[VIP][AnalysisSnapshotAdapter] rawAnalysis.duration must be a non-negative finite number');
  }
}

function regionId(type, index, startTime, endTime) {
  const startMs = Math.round(safeTime(startTime) * 1000);
  const endMs = Math.round(safeTime(endTime, startTime) * 1000);
  return `${type}-${index}-${startMs}-${endMs}`;
}

function segmentEvidenceRegions(segments, config, analyzerVersion) {
  if (!Array.isArray(segments)) return [];
  return segments.flatMap((segment, index) => {
    const startTime = safeTime(segment?.start);
    const endTime = safeTime(segment?.end, startTime);
    if (endTime < startTime) return [];
    const confidence = Number.isFinite(segment?.confidence) ? segment.confidence : undefined;
    return [{
      id: regionId(config.detectionType, index, startTime, endTime),
      startTime,
      endTime,
      detectionType: config.detectionType,
      certainty: certaintyFromConfidence(confidence),
      evidence: {
        ...(confidence === undefined ? {} : { confidence }),
        ...(typeof config.evidence === 'function' ? config.evidence(segment) : {}),
      },
      responsible: { id: 'full-analysis', version: analyzerVersion },
      availableActions: [...config.availableActions],
      explanation: config.explanation,
      support: 'supported',
    }];
  });
}

function wholeFileEvidenceRegion(rawAnalysis, config, analyzerVersion) {
  const duration = safeTime(rawAnalysis?.duration);
  return {
    id: regionId(config.detectionType, 0, 0, duration),
    startTime: 0,
    endTime: duration,
    detectionType: config.detectionType,
    certainty: certaintyFromConfidence(config.confidence),
    evidence: { ...(config.evidence || {}) },
    responsible: { id: 'full-analysis', version: analyzerVersion },
    availableActions: [...config.availableActions],
    explanation: config.explanation,
    support: 'supported',
  };
}

function buildEvidenceRegions(rawAnalysis, analyzerVersion) {
  const regions = [
    ...segmentEvidenceRegions(rawAnalysis.speechSegments, {
      detectionType: 'speech',
      availableActions: ['voiceIso', 'eqPresence'],
      explanation: 'Speech activity was detected in this region by the local full-audio analyzer.',
    }, analyzerVersion),
    ...segmentEvidenceRegions(rawAnalysis.whisperSegments || rawAnalysis.whisperCandidates, {
      detectionType: 'whisper_candidate',
      availableActions: ['whisperLift', 'voiceTunnel'],
      explanation: 'Low-amplitude whisper speech candidate was detected in this region.',
    }, analyzerVersion),
    ...segmentEvidenceRegions(rawAnalysis.noiseSegments, {
      detectionType: 'background_noise',
      availableActions: ['bgSuppress', 'nrAmount', 'nrFloor'],
      explanation: 'Background-noise energy was detected in this region by the local full-audio analyzer.',
    }, analyzerVersion),
    ...segmentEvidenceRegions(rawAnalysis.musicSegments, {
      detectionType: 'music_bleed',
      availableActions: ['voiceIso', 'bgSuppress'],
      explanation: 'Music-like energy was detected alongside the analyzed program material in this region.',
    }, analyzerVersion),
    ...segmentEvidenceRegions(rawAnalysis.humSegments, {
      detectionType: 'hum',
      availableActions: ['nrAmount', 'nrFloor'],
      explanation: 'Hum or buzz energy was detected in this region by the local full-audio analyzer.',
      evidence: () => ({
        frequencyHz: rawAnalysis.humProfile?.freq,
        strength: rawAnalysis.humProfile?.strength,
      }),
    }, analyzerVersion),
    ...segmentEvidenceRegions(rawAnalysis.difficultSpeechRegions, {
      detectionType: 'low_clarity',
      availableActions: ['eqPresence', 'deEssAmt'],
      explanation: 'A difficult-speech region was detected and may benefit from dialogue-clarity controls.',
    }, analyzerVersion),
  ];

  if (rawAnalysis.humProfile?.present && !regions.some((region) => region.detectionType === 'hum')) {
    regions.push(wholeFileEvidenceRegion(rawAnalysis, {
      detectionType: 'hum',
      confidence: rawAnalysis.humProfile?.strength,
      evidence: {
        frequencyHz: rawAnalysis.humProfile?.freq,
        strength: rawAnalysis.humProfile?.strength,
      },
      availableActions: ['nrAmount', 'nrFloor'],
      explanation: 'The local analyzer measured a persistent hum or buzz profile across the file.',
    }, analyzerVersion));
  }

  // A low measured SNR is evidence of background noise even when no segment
  // was classified as noise; without it the reduce-noise goal has no evidence.
  const snrDb = rawAnalysis.snrDb;
  if (Number.isFinite(snrDb) && snrDb < 20
    && !regions.some((region) => region.detectionType === 'background_noise')) {
    const region = wholeFileEvidenceRegion(rawAnalysis, {
      detectionType: 'stationary_noise',
      evidence: { snrDb, noiseFloorDb: rawAnalysis.globalNoiseProfile?.floorDb ?? null },
      availableActions: ['nrAmount', 'nrFloor'],
      explanation: `The local analyzer measured an SNR of ${snrDb.toFixed(1)} dB across the file.`,
    }, analyzerVersion);
    // Certainty follows the measurement itself, not a classifier confidence.
    region.certainty = snrDb < 10 ? 'high' : 'medium';
    regions.push(region);
  }

  if (rawAnalysis.confidenceScores?.bandwidthLimited) {
    regions.push(wholeFileEvidenceRegion(rawAnalysis, {
      detectionType: 'bandwidth_limited',
      confidence: rawAnalysis.confidenceScores?.analysisQuality,
      evidence: { bandwidthLimited: true },
      availableActions: ['eqPresence', 'deEssAmt'],
      explanation: 'The local analyzer measured bandwidth-limited program material.',
    }, analyzerVersion));
  }

  return regions;
}

function buildMeasurements(rawAnalysis) {
  return {
    rms: rawAnalysis.rms,
    peak: rawAnalysis.peak,
    loudnessEstimate: rawAnalysis.loudnessEstimate,
    snrDb: rawAnalysis.snrDb,
    roomEstimate: rawAnalysis.roomEstimate,
    reverbEstimate: rawAnalysis.reverbEstimate,
    frameCount: rawAnalysis.frameCount,
    globalNoiseProfile: rawAnalysis.globalNoiseProfile || {},
    humProfile: rawAnalysis.humProfile || {},
    confidenceScores: rawAnalysis.confidenceScores || {},
  };
}

/**
 * Adapt raw `analyzeAudio()` output to the canonical intelligence snapshot.
 * This intentionally does not copy the legacy recommendation object; bounded
 * recommendations are generated separately by IntelligenceRecommendation.
 *
 * @param {object} rawAnalysis Legacy FullAnalysis output.
 * @param {object} [context] Snapshot identity/version metadata.
 * @returns {object} Runtime-validated AnalysisSnapshot.
 */
export function adaptFullAnalysisToSnapshot(rawAnalysis, context = {}) {
  if (!rawAnalysis || typeof rawAnalysis !== 'object' || Array.isArray(rawAnalysis)) {
    throw new TypeError('[VIP][AnalysisSnapshotAdapter] rawAnalysis must be an object');
  }
  assertRequiredInputMetadata(rawAnalysis);

  const sessionId = context.sessionId || nextLocalSessionId();
  const analysisVersion = context.analysisVersion || FULL_ANALYSIS_SNAPSHOT_VERSION;
  const analyzerVersion = context.analyzerVersion || FULL_ANALYSIS_ANALYZER_VERSION;
  const contentFingerprint = context.contentFingerprint || `unavailable:${sessionId}`;
  const warnings = [...(context.warnings || [])];

  if (!context.contentFingerprint) {
    warnings.push('Content fingerprint unavailable; this snapshot is session-scoped and must not be reused as a durable cache identity.');
  }
  if (rawAnalysis.confidenceScores?.classicalOnly) {
    warnings.push('ML VAD was unavailable or unused; analysis confidence reflects the classical local fallback.');
  }

  const snapshot = {
    sessionId,
    contentFingerprint,
    input: {
      sampleRate: rawAnalysis.sampleRate,
      channels: rawAnalysis.channels,
      durationSeconds: rawAnalysis.duration,
    },
    analysisVersion,
    timestamp: context.timestamp || new Date().toISOString(),
    versions: {
      analyzer: analyzerVersion,
      rules: 'intelligence-foundation-1',
      ...(context.versions || {}),
    },
    capabilities: {
      localAnalysis: { status: 'ready' },
      vad: {
        status: rawAnalysis.confidenceScores?.classicalOnly ? 'fallback' : 'ready',
        source: rawAnalysis.confidenceScores?.vadSource || 'none',
      },
      ...(context.capabilities || {}),
    },
    measurements: buildMeasurements(rawAnalysis),
    detectedSources: Array.isArray(rawAnalysis.detectedSources)
      ? rawAnalysis.detectedSources.map((source) => ({ ...source }))
      : [],
    evidenceRegions: buildEvidenceRegions(rawAnalysis, analyzerVersion),
    warnings: uniqueStrings(warnings),
    unsupportedAnalyses: uniqueStrings(context.unsupportedAnalyses || []),
    freshness: context.freshness || 'fresh',
  };

  return validateAnalysisSnapshot(snapshot);
}

/**
 * VIP-032: Adapt `runAutoAnalysis()` output to the canonical `AnalysisSnapshot`
 * contract (`validateAnalysisSnapshot`) so Landing Quick Clean and Engineer
 * Signal Canvas consume the exact same runtime-validated schema as FullAnalysis.
 *
 * @param {object} autoResult Output from `runAutoAnalysis()`.
 * @param {object} [context]
 * @returns {object} Runtime-validated `AnalysisSnapshot`.
 */
export function adaptAutoAnalysisToSnapshot(autoResult, context = {}) {
  if (!autoResult || typeof autoResult !== 'object' || Array.isArray(autoResult)) {
    throw new TypeError('[VIP][AnalysisSnapshotAdapter] autoResult must be an object');
  }
  assertRequiredInputMetadata(autoResult);

  const sessionId = context.sessionId || nextLocalSessionId();
  const analysisVersion = context.analysisVersion || FULL_ANALYSIS_SNAPSHOT_VERSION;
  const analyzerVersion = context.analyzerVersion || AUTO_ANALYSIS_ANALYZER_VERSION;
  const contentFingerprint = context.contentFingerprint || `unavailable:${sessionId}`;
  const warnings = [
    ...(Array.isArray(autoResult.warnings) ? autoResult.warnings : []),
    ...(Array.isArray(context.warnings) ? context.warnings : []),
  ];
  if (!context.contentFingerprint) {
    warnings.push('Content fingerprint unavailable; this snapshot is session-scoped and must not be reused as a durable cache identity.');
  }

  const evidenceRegions = [];
  const pushRegs = (list, type, actions, explainFn, idSource = 'vip-auto-analysis') => {
    if (!Array.isArray(list)) return;
    list.forEach((seg, idx) => {
      const startTime = safeTime(seg.start, 0);
      const endTime = Math.max(startTime, safeTime(seg.end, startTime));
      const conf = Number.isFinite(seg.confidence) ? seg.confidence : 0.6;
      evidenceRegions.push({
        id: typeof seg.id === 'string' && seg.id.trim()
          ? seg.id
          : regionId(type, idx, startTime, endTime),
        startTime,
        endTime,
        detectionType: type,
        certainty: certaintyFromConfidence(conf),
        evidence: {
          confidence: conf,
          ...(seg.speakerId ? { speakerId: seg.speakerId } : {}),
          ...(Number.isFinite(seg.freqHz) ? { freqHz: seg.freqHz } : {}),
          ...(Number.isFinite(seg.levelDb) ? { levelDb: seg.levelDb } : {}),
        },
        responsible: { id: idSource, version: analyzerVersion },
        availableActions: actions,
        explanation: explainFn(seg),
        support: 'supported',
      });
    });
  };

  pushRegs(
    autoResult.speechSegments,
    'speech',
    ['voiceGain', 'eqPresence'],
    () => 'Local energy/spectral voice activity detector measured speech energy.',
  );
  pushRegs(
    autoResult.whisperCandidates,
    'whisper_candidate',
    ['whisperLift', 'voiceTunnel'],
    () => 'Low-amplitude, unvoiced broadband speech candidate (whisper hazard for aggressive NR).',
  );
  pushRegs(
    autoResult.noiseSegments,
    'background_noise',
    ['bgSuppress', 'nrAmount'],
    () => 'Non-speech stationary or broadband background noise floor segment.',
  );
  pushRegs(
    autoResult.humSegments,
    'tonal_hum',
    ['humAmt', 'humFreq'],
    (seg) => `Narrowband mains hum harmonic energy${Number.isFinite(seg?.freqHz) ? ` near ${Math.round(seg.freqHz)} Hz` : ''}.`,
  );

  const speakers = Array.isArray(autoResult.speakers) ? autoResult.speakers : [];
  const speakerOverlays = Array.isArray(autoResult.regions)
    ? autoResult.regions.filter((r) => r && r.type === 'speaker')
    : [];
  pushRegs(
    speakerOverlays,
    'speaker_turn',
    ['voiceGain'],
    (seg) => `Detected speaker turn (${seg.speakerId || 'speaker'}).`,
    autoResult.speakerDetection?.method || 'vip-diarization',
  );

  const detectedSources = [];
  if ((autoResult.speechSegments || []).length > 0) {
    detectedSources.push({
      id: 'speech',
      type: 'speech',
      label: 'Speech',
      confidence: Number.isFinite(autoResult.confidence) ? autoResult.confidence : 0.7,
    });
  }
  if ((autoResult.whisperCandidates || []).length > 0) {
    detectedSources.push({
      id: 'whisper',
      type: 'whisper',
      label: 'Whisper Candidate',
      confidence: 0.65,
    });
  }
  if ((autoResult.noiseSegments || []).length > 0) {
    detectedSources.push({
      id: 'noise',
      type: 'noise',
      label: 'Background Noise',
      confidence: 0.7,
    });
  }
  if ((autoResult.humSegments || []).length > 0) {
    detectedSources.push({
      id: 'hum',
      type: 'hum',
      label: 'Mains Hum',
      confidence: 0.75,
    });
  }
  for (const spk of speakers) {
    detectedSources.push({
      id: spk.id || `speaker-${detectedSources.length}`,
      type: 'speaker',
      label: spk.label || spk.id || 'Speaker',
      confidence: Number.isFinite(spk.confidence) ? spk.confidence : 0.6,
    });
  }

  const snapshot = {
    sessionId,
    contentFingerprint,
    input: {
      sampleRate: autoResult.sampleRate,
      channels: autoResult.channels,
      durationSeconds: autoResult.duration,
    },
    analysisVersion,
    timestamp: autoResult.timestamp || context.timestamp || new Date().toISOString(),
    versions: {
      analyzer: analyzerVersion,
      rules: 'intelligence-foundation-1',
      speakerDetection: autoResult.speakerDetection?.method || 'none',
      ...(context.versions || {}),
    },
    capabilities: {
      localAnalysis: { status: 'ready' },
      speakerDiarization: {
        status: speakers.length > 0 ? 'ready' : 'unavailable',
        method: autoResult.speakerDetection?.method || 'none',
      },
      ...(context.capabilities || {}),
    },
    measurements: {
      rms: Number.isFinite(autoResult.rms) ? autoResult.rms : 0,
      peak: Number.isFinite(autoResult.peak) ? autoResult.peak : 0,
      snrDb: Number.isFinite(autoResult.snrDb) ? autoResult.snrDb : 0,
      speechRatio: Number.isFinite(autoResult.speechRatio) ? autoResult.speechRatio : 0,
      noiseFloor: autoResult.noiseFloor || {},
      confidence: Number.isFinite(autoResult.confidence) ? autoResult.confidence : 0,
      speakers,
    },
    detectedSources,
    evidenceRegions,
    warnings: uniqueStrings(warnings),
    unsupportedAnalyses: uniqueStrings(context.unsupportedAnalyses || []),
    freshness: context.freshness || 'fresh',
  };

  return validateAnalysisSnapshot(snapshot);
}

/**
 * Project any canonical `AnalysisSnapshot` (from `AutoAnalysis` OR `FullAnalysis`)
 * into the Signal Canvas / `audioSessionStore` overlay model while preserving
 * `snapshot` as the canonical source of truth.
 *
 * @param {object} snapshot Validated `AnalysisSnapshot`.
 * @returns {object}
 */
export function snapshotToOverlayModel(snapshot) {
  validateAnalysisSnapshot(snapshot);
  const confidenceFromCertainty = { high: 0.9, medium: 0.68, low: 0.38, unknown: 0.5 };
  const typeMap = {
    speech: 'speech',
    whisper: 'whisper',
    whisper_candidate: 'whisper',
    background_noise: 'noise',
    noise: 'noise',
    tonal_hum: 'hum',
    hum: 'hum',
    speaker_turn: 'speaker',
    music_bed: 'music',
  };

  const regions = [];
  const speechSegments = [];
  const whisperCandidates = [];
  const noiseSegments = [];
  const humSegments = [];

  for (const er of snapshot.evidenceRegions) {
    const uiType = typeMap[er.detectionType] || er.detectionType;
    const confidence = Number.isFinite(er.evidence?.confidence)
      ? er.evidence.confidence
      : (confidenceFromCertainty[er.certainty] ?? 0.5);
    const item = {
      id: er.id,
      type: uiType,
      start: er.startTime,
      end: er.endTime,
      confidence,
      ...(er.evidence?.speakerId ? { speakerId: er.evidence.speakerId } : {}),
      ...(Number.isFinite(er.evidence?.freqHz) ? { freqHz: er.evidence.freqHz } : {}),
    };
    regions.push(item);
    if (uiType === 'speech') speechSegments.push(item);
    else if (uiType === 'whisper') whisperCandidates.push(item);
    else if (uiType === 'noise') noiseSegments.push(item);
    else if (uiType === 'hum') humSegments.push(item);
  }

  regions.sort((a, b) => a.start - b.start);
  const m = snapshot.measurements || {};

  return {
    snapshot,
    sessionId: snapshot.sessionId,
    contentFingerprint: snapshot.contentFingerprint,
    freshness: snapshot.freshness,
    duration: snapshot.input.durationSeconds,
    sampleRate: snapshot.input.sampleRate,
    channels: snapshot.input.channels,
    snrDb: Number.isFinite(m.snrDb) ? m.snrDb : 0,
    rms: Number.isFinite(m.rms) ? m.rms : 0,
    peak: Number.isFinite(m.peak) ? m.peak : 0,
    speechRatio: Number.isFinite(m.speechRatio) ? m.speechRatio : 0,
    noiseFloor: m.noiseFloor || m.globalNoiseProfile || {},
    speakers: Array.isArray(m.speakers) ? m.speakers : [],
    speechSegments,
    whisperCandidates,
    noiseSegments,
    humSegments,
    regions,
    warnings: snapshot.warnings,
    confidence: Number.isFinite(m.confidence)
      ? m.confidence
      : (Number.isFinite(m.confidenceScores?.analysisQuality) ? m.confidenceScores.analysisQuality : 0.7),
    timestamp: snapshot.timestamp,
  };
}

export default {
  adaptFullAnalysisToSnapshot,
  adaptAutoAnalysisToSnapshot,
  snapshotToOverlayModel,
};
