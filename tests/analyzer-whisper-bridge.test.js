/**
 * Analyzer ↔ WhisperHunter collaboration bridge tests
 */
'use strict';

let segmentCoverage;
let mergeRegions;
let classifyUnwantedSounds;
let buildRegionMaps;
let mergeHunterEnvWithAnalysis;
let buildJointProcessingPlan;
let analysisToHunterSliderTargets;
let enrichAnalysisWithCollaboration;
let applyHunterFeedbackToAnalysis;

beforeAll(async () => {
  const bridge = await import('../src/core/AnalyzerWhisperBridge.js');
  ({
    segmentCoverage,
    mergeRegions,
    classifyUnwantedSounds,
    buildRegionMaps,
    mergeHunterEnvWithAnalysis,
    buildJointProcessingPlan,
    analysisToHunterSliderTargets,
    enrichAnalysisWithCollaboration,
    applyHunterFeedbackToAnalysis,
  } = bridge);
});

function mockAnalysis(overrides = {}) {
  return {
    duration: 10,
    snrDb: 8,
    rms: 0.02,
    loudnessEstimate: -34,
    reverbEstimate: 0.2,
    humProfile: { present: false, strength: 0, freq: 60 },
    speechSegments: [{ start: 1, end: 3, confidence: 0.8, label: 'speech' }],
    whisperRegions: [{ start: 4, end: 5, confidence: 0.7, label: 'whisper' }],
    difficultSpeechRegions: [],
    musicSegments: [{ start: 0, end: 8, confidence: 0.6, label: 'music' }],
    noiseSegments: [{ start: 0, end: 2, confidence: 0.5 }],
    transientSegments: [
      { start: 2.0, end: 2.15, confidence: 0.7 },
      { start: 6.0, end: 6.12, confidence: 0.65 },
    ],
    humSegments: [],
    reverbSegments: [],
    speakerSegments: [],
    overlapRegions: [],
    confidenceScores: { musicRatio: 0.4, speechRatio: 0.25, snrDb: 8 },
    recommendation: {
      recommendedPreset: 'Aggressive Isolate',
      recommendedStageConfig: { musicKill: 50, voiceIso: 80, nrAmount: 55 },
      findings: ['base'],
      reasons: ['base reason'],
      confidence: 0.68,
      autoApplySafe: true,
      recommendedProcessingPlan: { emphasize: ['Music suppression'] },
    },
    ...overrides,
  };
}

describe('AnalyzerWhisperBridge', () => {
  test('segmentCoverage sums region duration over file length', () => {
    expect(segmentCoverage([{ start: 0, end: 2 }, { start: 5, end: 7 }], 10)).toBeCloseTo(0.4, 5);
    expect(segmentCoverage([], 10)).toBe(0);
  });

  test('mergeRegions merges overlapping intervals', () => {
    const merged = mergeRegions([
      { start: 0, end: 1, confidence: 0.5, label: 'a' },
      { start: 0.9, end: 2, confidence: 0.8, label: 'b' },
      { start: 5, end: 6, confidence: 0.4, label: 'c' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].start).toBe(0);
    expect(merged[0].end).toBe(2);
    expect(merged[0].confidence).toBe(0.8);
  });

  test('classifyUnwantedSounds detects music and impulses', () => {
    const u = classifyUnwantedSounds(mockAnalysis());
    expect(u.classes.music.present).toBe(true);
    expect(u.classes.impulse.present).toBe(true);
    expect(u.present).toContain('music');
    expect(u.primary).toBeTruthy();
  });

  test('buildRegionMaps separates protect vs suppress', () => {
    const maps = buildRegionMaps(mockAnalysis());
    expect(maps.protectRegions.length).toBeGreaterThan(0);
    expect(maps.suppressRegions.length).toBeGreaterThan(0);
    expect(maps.protectRegions.some((r) => r.label === 'whisper' || String(r.label).includes('whisper'))).toBe(true);
  });

  test('mergeHunterEnvWithAnalysis prefers joint dominant noise', () => {
    const analysis = mockAnalysis();
    const { jointEnv, unwanted } = mergeHunterEnvWithAnalysis(analysis, {
      rt60: 600,
      dominantNoise: 'music',
      noiseFloor: -35,
      speechPresence: 0.2,
      voiceRatio: 0.15,
      musicRatio: 0.6,
    });
    expect(unwanted.classes.music.present).toBe(true);
    expect(jointEnv.dominantNoise).toBe('music');
    expect(jointEnv.source).toBe('analyzer+hunter');
    expect(jointEnv.hasWhisper).toBe(true);
  });

  test('buildJointProcessingPlan raises musicKill and whisper path', () => {
    const plan = buildJointProcessingPlan(mockAnalysis());
    expect(plan.ok).toBe(true);
    expect(plan.recommendedStageConfig.musicKill).toBeGreaterThanOrEqual(55);
    expect(plan.recommendedStageConfig.crowdNull).toBeGreaterThan(0);
    expect(plan.protectRegions.length).toBeGreaterThan(0);
    expect(plan.suppressRegions.length).toBeGreaterThan(0);
    expect(plan.collaboration.analyzer).toBe(true);
    expect(plan.findings.some((f) => /music|Impulse|whisper|voice/i.test(f))).toBe(true);
  });

  test('analysisToHunterSliderTargets returns morphable sliders', () => {
    const { preset, sliders, plan } = analysisToHunterSliderTargets(mockAnalysis(), {
      rt60: 500,
      dominantNoise: 'music',
      voiceRatio: 0.2,
      musicRatio: 0.5,
      speechPresence: 0.25,
    }, 0.55);
    expect(preset).toBeTruthy();
    expect(sliders.musicKill).toBeGreaterThan(40);
    expect(sliders.whisperMode).toBeGreaterThanOrEqual(1);
    expect(plan.ok).toBe(true);
  });

  test('enrichAnalysisWithCollaboration attaches jointPlan', () => {
    const enriched = enrichAnalysisWithCollaboration(mockAnalysis());
    expect(enriched.jointPlan?.ok).toBe(true);
    expect(enriched.recommendation.findings.length).toBeGreaterThan(0);
    expect(enriched.protectRegions.length).toBeGreaterThan(0);
  });

  test('applyHunterFeedbackToAnalysis stores mask confidence', () => {
    const base = enrichAnalysisWithCollaboration(mockAnalysis());
    const withFb = applyHunterFeedbackToAnalysis(base, {
      envProfile: { dominantNoise: 'music', rt60: 400, voiceRatio: 0.2, musicRatio: 0.5, speechPresence: 0.3 },
      maskConfidence: 0.72,
      platform: 'browser',
      message: 'ok',
    });
    expect(withFb.hunterFeedback.maskConfidence).toBe(0.72);
    expect(withFb.confidenceScores.hunterMask).toBe(0.72);
  });

  test('empty analysis yields safe failure plan', () => {
    const plan = buildJointProcessingPlan(null);
    expect(plan.ok).toBe(false);
    expect(plan.protectRegions).toEqual([]);
  });
});
