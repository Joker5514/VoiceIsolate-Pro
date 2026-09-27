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
    const current = { sessionId: 'session-local-1', contentFingerprint: 'sha256-safe-fingerprint' };
    expect(planToControlPatch(first.plan, { outGain: -2 }, current).outGain).toBe(-2);
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

describe('analysis coordinator cancellation and staleness', () => {
  const identity = { contentFingerprint: 'fp-1', analysisVersion: '1', analyzerVersions: {}, modelVersions: {}, configuration: {}, runtime: 'wasm' };

  // Mirrors FullAnalysisHost: rejects as soon as its signal aborts.
  function abortableAnalyzer(delayMs = 20) {
    const calls = { count: 0, aborted: 0 };
    const analyze = (_input, { signal }) => new Promise((resolve, reject) => {
      calls.count += 1;
      const cancel = () => {
        calls.aborted += 1;
        const err = new Error('Cancelled');
        err.name = 'CancellationError';
        reject(err);
      };
      if (signal.aborted) { cancel(); return; }
      const timer = setTimeout(() => resolve(snapshot({ contentFingerprint: 'fp-1' })), delayMs);
      signal.addEventListener('abort', () => { clearTimeout(timer); cancel(); }, { once: true });
    });
    return { analyze, calls };
  }

  test('a caller that re-requests after cancelling its own request gets a fresh result', async () => {
    // AnalysisInsightsUI aborts its previous controller and re-analyzes the same
    // file; the second caller must not inherit the first caller's cancellation.
    const { analyze, calls } = abortableAnalyzer();
    const coordinator = new AnalysisCoordinator({ analyze });
    const first = new AbortController();
    const p1 = coordinator.analyze(identity, {}, { signal: first.signal });
    first.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError', code: 'CANCELLED' });
    const second = new AbortController();
    const result = await coordinator.analyze(identity, {}, { signal: second.signal });
    expect(result.freshness).toBe('fresh');
    expect(calls.count).toBe(2);
    expect(calls.aborted).toBe(1);
  });

  test('one waiter cancelling does not cancel a shared run other waiters still need', async () => {
    const { analyze, calls } = abortableAnalyzer();
    const coordinator = new AnalysisCoordinator({ analyze });
    const a = new AbortController();
    const pa = coordinator.analyze(identity, {}, { signal: a.signal });
    const pb = coordinator.analyze(identity, {}, {});
    a.abort();
    await expect(pa).rejects.toMatchObject({ name: 'AbortError' });
    await expect(pb).resolves.toMatchObject({ freshness: 'fresh' });
    expect(calls.count).toBe(1);
    expect(calls.aborted).toBe(0);
  });

  test('invalidate() reports in-flight waiters as stale and lets new callers start fresh', async () => {
    const { analyze, calls } = abortableAnalyzer();
    const coordinator = new AnalysisCoordinator({ analyze });
    const orphan = coordinator.analyze(identity, {}, {});
    coordinator.invalidate(identity);
    await expect(orphan).rejects.toMatchObject({ name: 'StaleAnalysisError', code: 'STALE' });
    await expect(coordinator.analyze(identity, {}, {})).resolves.toMatchObject({ freshness: 'fresh' });
    expect(calls.count).toBe(2);
  });

  test('requests without a content fingerprint are never cached or shared', async () => {
    let n = 0;
    const coordinator = new AnalysisCoordinator({ analyze: async () => { n += 1; return snapshot(); } });
    const anon = { ...identity, contentFingerprint: undefined };
    await coordinator.analyze(anon, {});
    await coordinator.analyze(anon, {});
    await coordinator.analyze({ ...identity, contentFingerprint: 'unknown' }, {});
    expect(n).toBe(3);
    expect(coordinator.cache.size).toBe(0);
  });

  test('an uncacheable request reports its own cancellation as CANCELLED', async () => {
    const { analyze } = abortableAnalyzer();
    const coordinator = new AnalysisCoordinator({ analyze });
    const ctrl = new AbortController();
    const pending = coordinator.analyze({ ...identity, contentFingerprint: undefined }, {}, { signal: ctrl.signal });
    ctrl.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError', code: 'CANCELLED' });
  });

  test('a failed run does not poison later requests', async () => {
    let n = 0;
    const coordinator = new AnalysisCoordinator({ analyze: async () => { n += 1; if (n === 1) throw new Error('boom'); return snapshot({ contentFingerprint: 'fp-1' }); } });
    await expect(coordinator.analyze(identity, {})).rejects.toThrow('boom');
    await expect(coordinator.analyze(identity, {})).resolves.toMatchObject({ freshness: 'fresh' });
  });
});

describe('processing plan session binding', () => {
  test('plans carry the session and input they were derived from', () => {
    const { plan } = recommendation.recommendForGoal(snapshot(), 'reduce_background_noise');
    expect(plan.sessionId).toBe('session-local-1');
    expect(plan.contentFingerprint).toBe('sha256-safe-fingerprint');
  });

  test('the bridge rejects a plan for another session or input', () => {
    const { plan } = recommendation.recommendForGoal(snapshot(), 'reduce_background_noise');
    const current = { sessionId: 'session-local-1', contentFingerprint: 'sha256-safe-fingerprint' };
    expect(planToControlPatch(plan, {}, current).nrAmount).toBe(55);
    expect(() => planToControlPatch(plan, {}, { ...current, contentFingerprint: 'other-file' }))
      .toThrow(expect.objectContaining({ name: 'StalePlanError', code: 'STALE' }));
    expect(() => planToControlPatch(plan, {}, { ...current, sessionId: 'session-2' })).toThrow(/stale/);
    expect(() => planToControlPatch(plan, {}, { sessionId: 'x', contentFingerprint: 'y' }))
      .toThrow(/stale for the current session and input/);
  });

  test('the bridge refuses to compare against a missing or partial current identity', () => {
    const { plan } = recommendation.recommendForGoal(snapshot(), 'reduce_background_noise');
    expect(() => planToControlPatch(plan, {})).toThrow(/current identity/);
    expect(() => planToControlPatch(plan, {}, { sessionId: 'session-local-1' })).toThrow(/contentFingerprint/);
    expect(() => planToControlPatch(plan, {}, { contentFingerprint: 'sha256-safe-fingerprint' })).toThrow(/sessionId/);
  });

  test('a plan without session binding fails validation', () => {
    const { plan } = recommendation.recommendForGoal(snapshot(), 'reduce_background_noise');
    const { sessionId: _omit, ...unbound } = plan;
    expect(() => contracts.validateProcessingPlan(unbound)).toThrow(/sessionId/);
  });
});
