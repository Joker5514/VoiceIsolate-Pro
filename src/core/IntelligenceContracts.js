/** Canonical, runtime-validated contracts shared by every intelligence surface. */
'use strict';

export const ANALYSIS_FRESHNESS = Object.freeze([
  'fresh', 'cached', 'stale', 'unsupported', 'failed',
]);
export const PROCESSING_CLASSES = Object.freeze([
  'live_mix', 'process_time', 'offline_required', 'unsupported',
]);
export const CERTAINTY = Object.freeze(['high', 'medium', 'low', 'unknown']);

function assertion(condition, message) {
  if (!condition) throw new TypeError(`[VIP][Contracts] ${message}`);
}

function record(value, name) {
  assertion(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
}

function text(value, name) {
  assertion(typeof value === 'string' && value.trim().length > 0, `${name} must be a non-empty string`);
}

function stringList(value, name) {
  assertion(Array.isArray(value) && value.every((item) => typeof item === 'string'), `${name} must be a string array`);
}

export function validateEvidenceRegion(region) {
  record(region, 'EvidenceRegion');
  text(region.id, 'EvidenceRegion.id');
  assertion(Number.isFinite(region.startTime) && region.startTime >= 0, 'EvidenceRegion.startTime is invalid');
  assertion(Number.isFinite(region.endTime) && region.endTime >= region.startTime, 'EvidenceRegion.endTime is invalid');
  text(region.detectionType, 'EvidenceRegion.detectionType');
  assertion(CERTAINTY.includes(region.certainty), 'EvidenceRegion.certainty is invalid');
  record(region.evidence, 'EvidenceRegion.evidence');
  record(region.responsible, 'EvidenceRegion.responsible');
  text(region.responsible.id, 'EvidenceRegion.responsible.id');
  text(region.responsible.version, 'EvidenceRegion.responsible.version');
  stringList(region.availableActions, 'EvidenceRegion.availableActions');
  text(region.explanation, 'EvidenceRegion.explanation');
  assertion(['supported', 'unsupported', 'unknown'].includes(region.support), 'EvidenceRegion.support is invalid');
  return region;
}

export function validateAnalysisSnapshot(snapshot) {
  record(snapshot, 'AnalysisSnapshot');
  text(snapshot.sessionId, 'AnalysisSnapshot.sessionId');
  text(snapshot.contentFingerprint, 'AnalysisSnapshot.contentFingerprint');
  record(snapshot.input, 'AnalysisSnapshot.input');
  text(snapshot.analysisVersion, 'AnalysisSnapshot.analysisVersion');
  assertion(Number.isFinite(Date.parse(snapshot.timestamp)), 'AnalysisSnapshot.timestamp is invalid');
  record(snapshot.versions, 'AnalysisSnapshot.versions');
  record(snapshot.capabilities, 'AnalysisSnapshot.capabilities');
  record(snapshot.measurements, 'AnalysisSnapshot.measurements');
  assertion(Array.isArray(snapshot.detectedSources), 'AnalysisSnapshot.detectedSources must be an array');
  assertion(Array.isArray(snapshot.evidenceRegions), 'AnalysisSnapshot.evidenceRegions must be an array');
  snapshot.evidenceRegions.forEach(validateEvidenceRegion);
  stringList(snapshot.warnings, 'AnalysisSnapshot.warnings');
  stringList(snapshot.unsupportedAnalyses, 'AnalysisSnapshot.unsupportedAnalyses');
  assertion(ANALYSIS_FRESHNESS.includes(snapshot.freshness), 'AnalysisSnapshot.freshness is invalid');
  return snapshot;
}

export function validateRecommendation(recommendation) {
  record(recommendation, 'Recommendation');
  text(recommendation.id, 'Recommendation.id');
  text(recommendation.goal, 'Recommendation.goal');
  text(recommendation.summary, 'Recommendation.summary');
  stringList(recommendation.evidenceRefs, 'Recommendation.evidenceRefs');
  assertion(Array.isArray(recommendation.operations), 'Recommendation.operations must be an array');
  assertion(CERTAINTY.includes(recommendation.certainty), 'Recommendation.certainty is invalid');
  stringList(recommendation.benefits, 'Recommendation.benefits');
  stringList(recommendation.tradeoffs, 'Recommendation.tradeoffs');
  assertion(PROCESSING_CLASSES.includes(recommendation.processingClass), 'Recommendation.processingClass is invalid');
  text(recommendation.rationale, 'Recommendation.rationale');
  assertion(Array.isArray(recommendation.alternatives), 'Recommendation.alternatives must be an array');
  record(recommendation.preview, 'Recommendation.preview');
  record(recommendation.recovery, 'Recommendation.recovery');
  return recommendation;
}

export function validateProcessingPlan(plan) {
  record(plan, 'ProcessingPlan');
  text(plan.id, 'ProcessingPlan.id');
  text(plan.version, 'ProcessingPlan.version');
  text(plan.analysisVersion, 'ProcessingPlan.analysisVersion');
  text(plan.goal, 'ProcessingPlan.goal');
  assertion(Array.isArray(plan.operations), 'ProcessingPlan.operations must be an array');
  plan.operations.forEach((operation, index) => {
    record(operation, `ProcessingPlan.operations[${index}]`);
    text(operation.id, `ProcessingPlan.operations[${index}].id`);
    record(operation.parameters, `ProcessingPlan.operations[${index}].parameters`);
  });
  record(plan.versions, 'ProcessingPlan.versions');
  record(plan.userOverrides, 'ProcessingPlan.userOverrides');
  assertion(plan.validationState === 'validated', 'ProcessingPlan must be validated');
  record(plan.reversibility, 'ProcessingPlan.reversibility');
  stringList(plan.evidenceRefs, 'ProcessingPlan.evidenceRefs');
  text(plan.recommendationId, 'ProcessingPlan.recommendationId');
  record(plan.constraints, 'ProcessingPlan.constraints');
  return plan;
}

export function validateEvaluationReport(report) {
  record(report, 'EvaluationReport');
  record(report.before, 'EvaluationReport.before');
  record(report.after, 'EvaluationReport.after');
  record(report.deltas, 'EvaluationReport.deltas');
  record(report.preview, 'EvaluationReport.preview');
  stringList(report.regressionWarnings, 'EvaluationReport.regressionWarnings');
  assertion(Number.isFinite(report.durationMs) && report.durationMs >= 0, 'EvaluationReport.durationMs is invalid');
  assertion(typeof report.exportReady === 'boolean', 'EvaluationReport.exportReady must be boolean');
  stringList(report.unsupportedComparisons, 'EvaluationReport.unsupportedComparisons');
  return report;
}

export function immutableProcessingPlan(plan) {
  validateProcessingPlan(plan);
  const freeze = (value) => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(plan);
}

export default {
  validateEvidenceRegion,
  validateAnalysisSnapshot,
  validateRecommendation,
  validateProcessingPlan,
  validateEvaluationReport,
  immutableProcessingPlan,
};
