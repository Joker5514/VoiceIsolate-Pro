/** Pure, bounded recommendation selection over real AnalysisSnapshot evidence. */
'use strict';

import { getParamSpec, clampParam } from './ParameterSchema.js';
import {
  immutableProcessingPlan,
  validateAnalysisSnapshot,
  validateRecommendation,
} from './IntelligenceContracts.js';

export const SUPPORTED_GOALS = Object.freeze([
  'isolate_spoken_voice', 'reduce_background_noise', 'improve_dialogue_clarity',
]);

const POLICIES = Object.freeze({
  isolate_spoken_voice: Object.freeze({
    evidence: Object.freeze(['speech', 'music_bleed', 'background_noise']),
    operation: Object.freeze({ id: 'process-controls', parameters: Object.freeze({ voiceIso: 82, bgSuppress: 55 }) }),
    benefit: 'Raises the clean voice stem relative to the residual stem.',
    tradeoff: 'Stronger isolation can thin speech or leave musical artifacts.',
  }),
  reduce_background_noise: Object.freeze({
    evidence: Object.freeze(['background_noise', 'stationary_noise', 'hum']),
    operation: Object.freeze({ id: 'process-controls', parameters: Object.freeze({ nrAmount: 55, nrFloor: -58 }) }),
    benefit: 'Reduces measured background energy using the existing process-time controls.',
    tradeoff: 'Stronger reduction can introduce metallic or pumping artifacts.',
  }),
  improve_dialogue_clarity: Object.freeze({
    evidence: Object.freeze(['speech', 'low_clarity', 'bandwidth_limited']),
    operation: Object.freeze({ id: 'process-controls', parameters: Object.freeze({ eqPresence: 3, deEssAmt: 5 }) }),
    benefit: 'Improves dialogue presence with the established control path.',
    tradeoff: 'Excess presence can emphasize sibilance or background hiss.',
  }),
});

function stableId(prefix, values) {
  let hash = 2166136261;
  for (const char of values.join('|')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function recommendForGoal(snapshot, goal, context = {}) {
  validateAnalysisSnapshot(snapshot);
  const policy = POLICIES[goal];
  const evidence = snapshot.evidenceRegions.filter((region) => (
    region.support === 'supported' && policy?.evidence.includes(region.detectionType)
  ));
  const executable = Boolean(policy && ['fresh', 'cached'].includes(snapshot.freshness) && evidence.length > 0);
  const evidenceRefs = evidence.map(({ id }) => id);
  const recommendationId = stableId('rec', [snapshot.contentFingerprint, snapshot.analysisVersion, goal, ...evidenceRefs]);
  const unsupported = !policy ? 'This goal is not supported by the current local analyzers and DSP operations.'
    : snapshot.freshness === 'stale' ? 'Analysis is stale and must be refreshed before a plan can be created.'
      : 'No supported evidence for this goal was detected; no processing plan was created.';
  const certainty = evidence.some((item) => item.certainty === 'low' || item.certainty === 'unknown') ? 'low' : 'medium';
  const operations = executable ? [policy.operation] : [];
  const recommendation = {
    id: recommendationId,
    goal,
    summary: executable ? `${evidence[0].explanation} A reversible plan is available for review.` : unsupported,
    evidenceRefs,
    operations,
    certainty: executable ? certainty : 'unknown',
    benefits: executable ? [policy.benefit] : [],
    tradeoffs: executable ? [policy.tradeoff] : [],
    processingClass: executable ? 'process_time' : 'unsupported',
    rationale: executable ? `Selected because ${evidenceRefs.length} compatible evidence region(s) support the requested goal.` : unsupported,
    alternatives: [],
    preview: { available: Boolean(executable && context.previewAvailable), status: executable ? (context.previewAvailable ? 'available' : 'unavailable') : 'unsupported' },
    recovery: { reject: true, reset: true, undoBeforeExport: true },
  };
  validateRecommendation(recommendation);
  if (!executable) return { recommendation, plan: null };

  const parameters = {};
  for (const [id, value] of Object.entries(policy.operation.parameters)) {
    if (!getParamSpec(id)) throw new Error(`[VIP][Recommendation] Unsupported control '${id}'`);
    const override = context.userOverrides?.[id];
    parameters[id] = clampParam(id, override ?? value);
  }
  const plan = immutableProcessingPlan({
    id: stableId('plan', [recommendationId, JSON.stringify(parameters)]),
    version: '1',
    analysisVersion: snapshot.analysisVersion,
    goal,
    operations: [{ id: 'process-controls', parameters }],
    versions: { dsp: context.dspVersion || 'existing-engine', models: context.modelVersions || {} },
    userOverrides: { ...(context.userOverrides || {}) },
    validationState: 'validated',
    reversibility: { beforeExport: true, resetTo: 'captured-control-state' },
    evidenceRefs,
    recommendationId,
    constraints: { localOnly: true, requiresFreshAnalysis: true },
  });
  return { recommendation, plan };
}

export default { SUPPORTED_GOALS, recommendForGoal };
