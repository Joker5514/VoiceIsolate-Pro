/** Convert legacy FullAnalysis output into the canonical intelligence AnalysisSnapshot. */
'use strict';

import { validateAnalysisSnapshot } from './IntelligenceContracts.js';

export const FULL_ANALYSIS_SNAPSHOT_VERSION = '1';
export const FULL_ANALYSIS_ANALYZER_VERSION = 'full-analysis-1';

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

export default { adaptFullAnalysisToSnapshot };
