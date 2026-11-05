const { describe, test, expect } = require('@jest/globals');

// Arena follow-up (PR #888): the mobile-freeze pin only counted call sites
// in landing.js, which does not prove the import path actually deduplicates.
// These tests exercise the real import path — runCoordinatedAutoAnalysis
// over a real AnalysisCoordinator with a counting analyzer — instead of
// re-testing the coordinator in isolation (already covered by
// intelligence-foundation.test.js).

let AnalysisCoordinator;
let runCoordinatedAutoAnalysis;
let computeQuickAudioFingerprint;

beforeAll(async () => {
  ({ AnalysisCoordinator, runCoordinatedAutoAnalysis, computeQuickAudioFingerprint } =
    await import('../src/pipeline/AnalysisCoordinator.js'));
});

function snapshot() {
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
  };
}

function audio(value, length = 4800) {
  return [Float32Array.from({ length }, () => value)];
}

describe('import-path analysis dedupe (VIP-032)', () => {
  test('concurrent import callers for the same audio share one analysis pass', async () => {
    let calls = 0;
    const coordinator = new AnalysisCoordinator({ analyze: async () => { calls += 1; return snapshot(); } });
    const channels = audio(0.5);
    const [a, b] = await Promise.all([
      runCoordinatedAutoAnalysis(channels, 48000, { coordinator }),
      runCoordinatedAutoAnalysis(channels, 48000, { coordinator }),
    ]);
    expect(calls).toBe(1);
    expect(a.freshness).toBe('fresh');
    expect(b.freshness).toBe('fresh');
    expect(a.regions).toEqual(b.regions);
  });

  test('a repeat import of the same audio reuses the cached snapshot', async () => {
    let calls = 0;
    const coordinator = new AnalysisCoordinator({ analyze: async () => { calls += 1; return snapshot(); } });
    const channels = audio(0.5);
    const first = await runCoordinatedAutoAnalysis(channels, 48000, { coordinator });
    const second = await runCoordinatedAutoAnalysis(channels, 48000, { coordinator });
    expect(first.freshness).toBe('fresh');
    expect(second.freshness).toBe('cached');
    expect(calls).toBe(1);
    expect(second.regions).toEqual(first.regions);
  });

  test('a changed file runs fresh instead of reusing the previous snapshot', async () => {
    let calls = 0;
    const coordinator = new AnalysisCoordinator({ analyze: async () => { calls += 1; return snapshot(); } });
    await runCoordinatedAutoAnalysis(audio(0.5), 48000, { coordinator });
    const changed = await runCoordinatedAutoAnalysis(audio(-0.5), 48000, { coordinator });
    expect(changed.freshness).toBe('fresh');
    expect(calls).toBe(2);
  });

  test('a different analysis configuration is a different identity, not a duplicate run', async () => {
    let calls = 0;
    const coordinator = new AnalysisCoordinator({ analyze: async () => { calls += 1; return snapshot(); } });
    const channels = audio(0.5);
    await runCoordinatedAutoAnalysis(channels, 48000, { coordinator });
    // A speaker-detection hook changes the coordinator identity
    // (configuration.hasSpeakerHook), so this must not reuse the no-hook entry.
    const withHook = await runCoordinatedAutoAnalysis(channels, 48000, {
      coordinator,
      detectSpeakers: async () => [],
    });
    expect(withHook.freshness).toBe('fresh');
    expect(calls).toBe(2);
  });

  test('the import fingerprint is deterministic for identical audio', () => {
    const fp1 = computeQuickAudioFingerprint(audio(0.25), 48000);
    const fp2 = computeQuickAudioFingerprint(audio(0.25), 48000);
    const fpOther = computeQuickAudioFingerprint(audio(-0.25), 48000);
    expect(fp1).not.toBe('unknown');
    expect(fp2).toBe(fp1);
    expect(fpOther).not.toBe(fp1);
  });
});
