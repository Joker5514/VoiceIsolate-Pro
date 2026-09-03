const { describe, test, expect } = require('@jest/globals');

let analyzeAudio;
let adaptFullAnalysisToSnapshot;
let validateAnalysisSnapshot;
let recommendForGoal;

beforeAll(async () => {
  ({ analyzeAudio } = await import('../src/core/FullAnalysis.js'));
  ({ adaptFullAnalysisToSnapshot } = await import('../src/core/AnalysisSnapshotAdapter.js'));
  ({ validateAnalysisSnapshot } = await import('../src/core/IntelligenceContracts.js'));
  ({ recommendForGoal } = await import('../src/core/IntelligenceRecommendation.js'));
});

function tone(freq = 300, sampleRate = 16000, seconds = 0.4, amplitude = 0.15) {
  const out = new Float32Array(Math.floor(sampleRate * seconds));
  for (let i = 0; i < out.length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return out;
}

function rawFixture(overrides = {}) {
  return {
    duration: 3,
    sampleRate: 48000,
    channels: 1,
    rms: 0.08,
    peak: 0.6,
    loudnessEstimate: -21,
    snrDb: 7,
    globalNoiseProfile: { floor: 0.01, floorDb: -40 },
    humProfile: { present: false, freq: 60, strength: 0 },
    roomEstimate: 0.2,
    reverbEstimate: 0.2,
    speechSegments: [{ start: 0.2, end: 2.5, confidence: 0.9 }],
    silenceSegments: [],
    musicSegments: [],
    noiseSegments: [{ start: 0, end: 0.2, confidence: 0.8 }],
    transientSegments: [],
    reverbSegments: [],
    humSegments: [],
    speakerSegments: [],
    overlapRegions: [],
    whisperRegions: [],
    difficultSpeechRegions: [],
    detectedSources: [{ id: 'lead_speech', label: 'Lead speech', confidence: 0.9 }],
    confidenceScores: {
      speechRatio: 0.7,
      musicRatio: 0,
      snrDb: 7,
      continuity: 0.9,
      hum: 0,
      reverb: 0.2,
      analysisQuality: 0.82,
      bandwidthLimited: false,
      classicalOnly: false,
      vadSource: 'silero',
    },
    visualLayers: [],
    frameCount: 120,
    platformHints: {},
    recommendedPreset: 'Voice Clarity',
    recommendedStageConfig: {},
    recommendedProcessingPlan: { steps: [], emphasize: [], modelChain: [], whisperPolicy: {} },
    recommendation: {},
    ...overrides,
  };
}

describe('AnalysisSnapshotAdapter', () => {
  test('adapts real FullAnalysis output into the canonical validated contract', () => {
    const sampleRate = 16000;
    const raw = analyzeAudio([tone(300, sampleRate)], sampleRate, { skipVad: true });
    const snapshot = adaptFullAnalysisToSnapshot(raw, {
      sessionId: 'session-real-analysis',
      contentFingerprint: 'sha256-real-analysis',
      timestamp: '2026-09-02T12:00:00.000Z',
    });

    expect(validateAnalysisSnapshot(snapshot)).toBe(snapshot);
    expect(snapshot.input).toEqual({
      sampleRate,
      channels: 1,
      durationSeconds: expect.any(Number),
    });
    expect(snapshot.measurements.snrDb).toBe(raw.snrDb);
    expect(snapshot.detectedSources).toEqual(raw.detectedSources);
    expect(snapshot.freshness).toBe('fresh');
  });

  test('maps supported evidence into recommendation-compatible detection types', () => {
    const snapshot = adaptFullAnalysisToSnapshot(rawFixture(), {
      sessionId: 'session-evidence',
      contentFingerprint: 'sha256-evidence',
      timestamp: '2026-09-02T12:00:00.000Z',
    });

    const types = snapshot.evidenceRegions.map((region) => region.detectionType);
    expect(types).toContain('speech');
    expect(types).toContain('background_noise');
    expect(snapshot.evidenceRegions.every((region) => region.support === 'supported')).toBe(true);

    const result = recommendForGoal(snapshot, 'reduce_background_noise', { previewAvailable: true });
    expect(result.plan).not.toBeNull();
    expect(result.plan.evidenceRefs.length).toBeGreaterThan(0);
    expect(result.plan.operations[0].parameters).toHaveProperty('nrAmount');
  });

  test('adds whole-file hum and bandwidth evidence when segmented regions are absent', () => {
    const snapshot = adaptFullAnalysisToSnapshot(rawFixture({
      humProfile: { present: true, freq: 60, strength: 0.7 },
      humSegments: [],
      confidenceScores: {
        ...rawFixture().confidenceScores,
        bandwidthLimited: true,
      },
    }), {
      sessionId: 'session-global-evidence',
      contentFingerprint: 'sha256-global-evidence',
      timestamp: '2026-09-02T12:00:00.000Z',
    });

    expect(snapshot.evidenceRegions.some((region) => region.detectionType === 'hum')).toBe(true);
    expect(snapshot.evidenceRegions.some((region) => region.detectionType === 'bandwidth_limited')).toBe(true);
  });

  test('uses a session-scoped identity and warning when no content fingerprint is available', () => {
    const snapshot = adaptFullAnalysisToSnapshot(rawFixture(), {
      sessionId: 'session-no-fingerprint',
      timestamp: '2026-09-02T12:00:00.000Z',
    });

    expect(snapshot.contentFingerprint).toBe('unavailable:session-no-fingerprint');
    expect(snapshot.warnings.join(' ')).toMatch(/must not be reused as a durable cache identity/i);
  });

  test('rejects malformed raw analysis rather than fabricating a snapshot', () => {
    expect(() => adaptFullAnalysisToSnapshot(null)).toThrow(/rawAnalysis must be an object/);
  });
});
