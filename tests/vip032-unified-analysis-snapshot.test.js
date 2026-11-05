/**
 * VIP-032 — Unified AnalysisSnapshot & AnalysisCoordinator Consolidation Tests
 */
'use strict';

let validateAnalysisSnapshot;
let adaptFullAnalysisToSnapshot;
let adaptAutoAnalysisToSnapshot;
let snapshotToOverlayModel;
let AnalysisCoordinator;
let StaleAnalysisError;
let computeQuickAudioFingerprint;
let runCoordinatedAutoAnalysis;
let evaluateEnhanceSuitability;
let ENHANCE_SUITABILITY;

beforeAll(async () => {
  ({ validateAnalysisSnapshot } = await import('../src/core/IntelligenceContracts.js'));
  ({
    adaptFullAnalysisToSnapshot,
    adaptAutoAnalysisToSnapshot,
    snapshotToOverlayModel,
  } = await import('../src/core/AnalysisSnapshotAdapter.js'));
  ({
    AnalysisCoordinator,
    StaleAnalysisError,
    computeQuickAudioFingerprint,
    runCoordinatedAutoAnalysis,
  } = await import('../src/pipeline/AnalysisCoordinator.js'));
  ({
    evaluateEnhanceSuitability,
    ENHANCE_SUITABILITY,
  } = await import('../src/core/EnhanceGuard.js'));
});

function synthSpeechWithWhisper(sampleRate = 16000) {
  const len = sampleRate * 2;
  const ch = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    if (t >= 0.2 && t < 0.9) {
      // Voiced speech-like harmonic burst
      ch[i] = 0.28 * Math.sin(2 * Math.PI * 190 * t) + 0.14 * Math.sin(2 * Math.PI * 380 * t);
    } else if (t >= 1.1 && t < 1.7) {
      // Quiet high-frequency whisper-like energy
      ch[i] = 0.03 * Math.sin(2 * Math.PI * 2400 * t + Math.sin(37 * t));
    } else {
      // Stationary low floor
      ch[i] = 0.002 * Math.sin(2 * Math.PI * 60 * t);
    }
  }
  return [ch];
}

describe('VIP-032 — Canonical AnalysisSnapshot parity across AutoAnalysis & FullAnalysis', () => {
  test('adaptAutoAnalysisToSnapshot and adaptFullAnalysisToSnapshot both pass validateAnalysisSnapshot and project to snapshotToOverlayModel', () => {
    const autoSnap = adaptAutoAnalysisToSnapshot(
      {
        sampleRate: 48000,
        channels: 1,
        duration: 4.0,
        rms: 0.12,
        peak: 0.65,
        snrDb: 14.5,
        speechRatio: 0.55,
        noiseFloor: { floorDb: -48 },
        confidence: 0.82,
        speechSegments: [{ id: 'speech-0-200-1800', type: 'speech', start: 0.2, end: 1.8, confidence: 0.88 }],
        whisperCandidates: [{ id: 'whisper-0-2000-3200', type: 'whisper', start: 2.0, end: 3.2, confidence: 0.72 }],
        noiseSegments: [{ id: 'noise-0-3300-3900', type: 'noise', start: 3.3, end: 3.9, confidence: 0.65 }],
        humSegments: [{ id: 'hum-0-0-4000', type: 'hum', start: 0, end: 4.0, confidence: 0.81, freqHz: 60 }],
        speakers: [{ id: 'S1', label: 'Speaker 1', confidence: 0.78 }],
        regions: [{ id: 'speaker-S1-0-200-1800', type: 'speaker', speakerId: 'S1', start: 0.2, end: 1.8, confidence: 0.78 }],
        warnings: [],
        speakerDetection: { method: 'dsp-kmeans' },
      },
      { contentFingerprint: 'sha256:abc123' },
    );

    const fullSnap = adaptFullAnalysisToSnapshot(
      {
        sampleRate: 48000,
        channels: 1,
        duration: 4.0,
        rms: 0.12,
        peak: 0.65,
        loudnessEstimate: -19.2,
        snrDb: 14.5,
        roomEstimate: 'small',
        reverbEstimate: 0.18,
        frameCount: 400,
        speechSegments: [{ start: 0.2, end: 1.8, confidence: 0.88 }],
        whisperSegments: [{ start: 2.0, end: 3.2, confidence: 0.72 }],
        noiseSegments: [{ start: 3.3, end: 3.9, confidence: 0.65 }],
        humProfile: { detected: true, fundamentalHz: 60, confidence: 0.81 },
        detectedSources: [{ id: 'speech', type: 'speech', label: 'Speech', confidence: 0.88 }],
        confidenceScores: { analysisQuality: 0.85, classicalOnly: false, vadSource: 'silero' },
      },
      { contentFingerprint: 'sha256:abc123' },
    );

    expect(() => validateAnalysisSnapshot(autoSnap)).not.toThrow();
    expect(() => validateAnalysisSnapshot(fullSnap)).not.toThrow();

    // Same top-level contract keys across both paths
    expect(Object.keys(autoSnap).sort()).toEqual(Object.keys(fullSnap).sort());

    const autoOverlay = snapshotToOverlayModel(autoSnap);
    const fullOverlay = snapshotToOverlayModel(fullSnap);
    expect(autoOverlay.speechSegments).toHaveLength(1);
    expect(autoOverlay.whisperCandidates).toHaveLength(1);
    expect(fullOverlay.speechSegments).toHaveLength(1);
    expect(fullOverlay.whisperCandidates).toHaveLength(1);

    // EnhanceGuard consumes the canonical AnalysisSnapshot directly:
    // confidence 0.72 >= 0.5 & whisperRatio > 0.15 -> UNSUITABLE;
    // low confidence 0.35 (< 0.5) -> UNCERTAIN.
    const guardVerdict = evaluateEnhanceSuitability(autoSnap);
    expect(guardVerdict.suitability).toBe(ENHANCE_SUITABILITY.UNSUITABLE);
    expect(guardVerdict.whisperRatio).toBeGreaterThan(0.2);

    const lowConfSnap = adaptAutoAnalysisToSnapshot(
      {
        sampleRate: 48000,
        channels: 1,
        duration: 4.0,
        speechSegments: [{ start: 0.2, end: 2.0, confidence: 0.9 }],
        whisperCandidates: [{ start: 2.2, end: 3.0, confidence: 0.35 }],
      },
      { contentFingerprint: 'sha256:def456' },
    );
    expect(evaluateEnhanceSuitability(lowConfSnap).suitability).toBe(ENHANCE_SUITABILITY.UNCERTAIN);
  });
});

describe('VIP-032 — AnalysisCoordinator deduplication, cache reuse, invalidation & stale suppression', () => {
  test('runCoordinatedAutoAnalysis deduplicates concurrent Landing & Engineer calls, caches by fingerprint, and produces deterministic region IDs', async () => {
    const audio = synthSpeechWithWhisper(16000);
    const fp = computeQuickAudioFingerprint(audio, 16000);
    expect(fp).toMatch(/^pcm-fnv-1ch-16000hz-32000-/);
    expect(computeQuickAudioFingerprint(audio, 16000)).toBe(fp);

    let underlyingRuns = 0;
    const { runAutoAnalysis } = await import('../src/core/audio/analysis/AutoAnalysis.js');
    const coordinator = new AnalysisCoordinator({
      analyze: async (input, opts) => {
        underlyingRuns += 1;
        const raw = await runAutoAnalysis(input.channelData, input.sampleRate, {
          signal: opts.signal,
        });
        return adaptAutoAnalysisToSnapshot(raw, {
          contentFingerprint: opts.identity?.contentFingerprint,
        });
      },
    });

    // Simulate Landing + Engineer firing concurrently for the same imported audio
    const [resLanding, resEngineer] = await Promise.all([
      runCoordinatedAutoAnalysis(audio, 16000, { coordinator }),
      runCoordinatedAutoAnalysis(audio, 16000, { coordinator }),
    ]);

    expect(underlyingRuns).toBe(1);
    expect(resLanding.freshness).toBe('fresh');
    expect(resEngineer.freshness).toBe('fresh');
    expect(resLanding.regions.map((r) => r.id)).toEqual(resEngineer.regions.map((r) => r.id));

    // Subsequent call hits coordinator cache
    const resCached = await runCoordinatedAutoAnalysis(audio, 16000, { coordinator });
    expect(underlyingRuns).toBe(1);
    expect(resCached.freshness).toBe('cached');
    expect(() => validateAnalysisSnapshot(resCached.snapshot)).not.toThrow();
  });

  test('invalidate() suppresses stale in-flight results with StaleAnalysisError and partial waiter abort preserves remaining waiter', async () => {
    let resolveDelayed;
    const coordinator = new AnalysisCoordinator({
      analyze: (input, opts) =>
        new Promise((resolve, reject) => {
          opts.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
          resolveDelayed = () =>
            resolve(
              adaptAutoAnalysisToSnapshot(
                { sampleRate: 16000, channels: 1, duration: 1.0 },
                { contentFingerprint: opts.identity.contentFingerprint },
              ),
            );
        }),
    });

    const identity = { contentFingerprint: 'sha256:track-1', analysisVersion: '1' };
    const ac1 = new AbortController();
    const ac2 = new AbortController();

    const p1 = coordinator.analyze(identity, {}, { signal: ac1.signal });
    const p2 = coordinator.analyze(identity, {}, { signal: ac2.signal });
    await Promise.resolve();

    // Caller 1 aborts, Caller 2 stays attached -> shared run continues for Caller 2!
    ac1.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    resolveDelayed();
    const snap2 = await p2;
    expect(snap2.freshness).toBe('fresh');

    // Now invalidate and start a new run, then invalidate mid-flight -> StaleAnalysisError
    coordinator.invalidate(identity);
    const pStale = coordinator.analyze(identity, {});
    await Promise.resolve();
    coordinator.invalidate(identity);
    await expect(pStale).rejects.toBeInstanceOf(StaleAnalysisError);
  });
});
