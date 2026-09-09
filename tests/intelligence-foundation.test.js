const { describe, test, expect } = require('@jest/globals');

let contracts;
let recommendation;
let AnalysisCoordinator;
let planToControlPatch;

beforeAll(async () => {
  contracts = await import('../src/core/IntelligenceContracts.js');
  recommendation = await import('../src/core/IntelligenceRecommendation.js');
  ({ AnalysisCoordinator } = await import('../src/pipeline/AnalysisCoordinator.js'));
  ({ planToControlPatch } = await import('../src/pipeline/ProcessingPlanBridge.js'));
});

function snapshot(overrides = {}) {
  return {
    sessionId: 'session-local-1',
    contentFingerprint: 'sha256-safe-fingerprint',
    input: { sampleRate: 48000, channels: 1, durationSeconds: 3 },
    analysisVersion: '1',
    timestamp: '2026-08-29T00:00:00.000Z',
    versions: { analyzer: 'fixture-1', rules: '1' },
    capabilities: { basicDsp: { status: 'ready' } },
    measurements: { snrDb: 5 },
    detectedSources: [],
    evidenceRegions: [{
      id: 'noise-0-3', startTime: 0, endTime: 3,
      detectionType: 'stationary_noise', certainty: 'medium',
      evidence: { snrDb: 5 }, responsible: { id: 'fixture-analyzer', version: '1' },
      availableActions: ['nrAmount'], explanation: 'Stationary noise was measured during non-speech regions.',
      support: 'supported',
    }],
    warnings: [], unsupportedAnalyses: [], freshness: 'fresh',
    ...overrides,
  };
}

describe('canonical intelligence contracts', () => {
  test('validates a complete snapshot and rejects fabricated/incomplete evidence', () => {
    expect(contracts.validateAnalysisSnapshot(snapshot())).toBeTruthy();
    const invalid = snapshot();
    delete invalid.evidenceRegions[0].responsible;
    expect(() => contracts.validateAnalysisSnapshot(invalid)).toThrow(/responsible/);
  });

  test('validates EvaluationReport without a quality score', () => {
    const report = { before: { snrDb: 5 }, after: { snrDb: 8 }, deltas: { snrDb: 3 }, preview: { available: true }, regressionWarnings: [], durationMs: 20, exportReady: true, unsupportedComparisons: [] };
    expect(contracts.validateEvaluationReport(report)).toBe(report);
  });
});

describe('deterministic recommendation and bridge', () => {
  test('produces the same evidence-linked immutable plan and preserves overrides', () => {
    const context = { previewAvailable: true, userOverrides: { nrAmount: 42 } };
    const first = recommendation.recommendForGoal(snapshot(), 'reduce_background_noise', context);
    const second = recommendation.recommendForGoal(snapshot(), 'reduce_background_noise', context);
    expect(first).toEqual(second);
    expect(first.plan.evidenceRefs).toEqual(['noise-0-3']);
    expect(first.plan.operations[0].parameters.nrAmount).toBe(42);
    expect(Object.isFrozen(first.plan.operations[0].parameters)).toBe(true);
    expect(planToControlPatch(first.plan, { outGain: -2 }).outGain).toBe(-2);
  });

  test('does not create a plan for stale, unsupported, or no-material-problem analysis', () => {
    expect(recommendation.recommendForGoal(snapshot({ freshness: 'stale' }), 'reduce_background_noise').plan).toBeNull();
    expect(recommendation.recommendForGoal(snapshot(), 'prepare_transcription').plan).toBeNull();
    expect(recommendation.recommendForGoal(snapshot({ evidenceRegions: [] }), 'reduce_background_noise').plan).toBeNull();
  });
});

describe('analysis coordinator', () => {
  test('deduplicates requests, caches results, and invalidates by compatibility identity', async () => {
    let calls = 0;
    const coordinator = new AnalysisCoordinator({ analyze: async () => { calls += 1; return snapshot(); } });
    const identity = { contentFingerprint: 'a', analysisVersion: '1', analyzerVersions: { a: 1 }, modelVersions: {}, configuration: {}, runtime: 'wasm' };
    const [a, b] = await Promise.all([coordinator.analyze(identity, {}), coordinator.analyze(identity, {})]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    expect((await coordinator.analyze(identity, {})).freshness).toBe('cached');
    coordinator.invalidate(identity);
    await coordinator.analyze(identity, {});
    expect(calls).toBe(2);
  });
});
