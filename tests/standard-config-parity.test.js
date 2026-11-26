/**
 * DSP-01 — Standard config runtime parity (LOCAL 2026-11-25, finish plan).
 *
 * These tests prove RUNTIME parity, not label parity: a test that only says
 * defaultPreset === "voice-clarity" proves the label, not the behavior, and
 * is not accepted as evidence here. Every path is driven through its ACTUAL
 * resolver/plan builder and the resulting config's effective values are
 * asserted — maskStrength 0.15 must be present in the built spectral config
 * that would reach the worker, the revision must be the versioned Standard
 * revision, and the `standard` block must record requested vs effective.
 *
 * The worker-side half of parity (the same configs through real inference
 * must produce bit-identical output) lives in
 * tests/mlworker-standard-config.test.js.
 */
'use strict';

let Preset;
let Registry;
let Recommend;
let Bridge;
let QuickClean;
let Cache;

beforeAll(async () => {
  Preset = await import('../src/core/PresetCalibration.js');
  Registry = await import('../src/core/CapabilityRegistry.js');
  Recommend = await import('../src/core/RecommendationEngine.js');
  Bridge = await import('../src/core/AnalyzerWhisperBridge.js');
  QuickClean = await import('../src/pipeline/QuickCleanPlan.js');
  Cache = await import('../src/pipeline/MLStemCache.js');
});

const CANONICAL = { maskStrength: 0.15, whisperMode: 1, whisperLift: 8, gateThresh: -58 };

describe('canonical Standard builder', () => {
  test('builds the measured config: maskStrength 0.15, whisper 1/8, gate -58', () => {
    const cfg = Preset.buildStandardProcessingConfig();
    expect(cfg.spectral.maskStrength).toBe(0.15);
    expect(cfg.spectral.whisperMode).toBe(1);
    expect(cfg.spectral.whisperLift).toBe(8);
    // gateThresh is a Live-Mix realtime param, not a spectral id: the
    // builder drops it from `spectral` by design (see STANDARD_WORKER_KEYS).
    // It is still recorded in the standard block's effective values.
    expect(cfg.standard.effective.gateThresh).toBe(-58);
    expect(cfg.standard.profileId).toBe('voice-clarity');
    expect(cfg.standard.configVersion).toBe(1);
    expect(cfg.standard.status).toBe('canonical');
  });

  test('revision is version-prefixed over the measured emc1 hash', () => {
    const cfg = Preset.buildStandardProcessingConfig();
    expect(cfg.revision).toBe('std1:emc1-mu4w9g');
  });

  test('missing canonical keys are filled AND recorded (never silent)', () => {
    const cfg = Preset.buildStandardProcessingConfig({ nrAmount: 40 });
    expect(cfg.spectral.maskStrength).toBe(0.15);
    expect(cfg.spectral.whisperMode).toBe(1);
    expect(cfg.spectral.whisperLift).toBe(8);
    const filled = cfg.standard.substitutions.map((s) => s.id).sort();
    expect(filled).toEqual(['gateThresh', 'maskStrength', 'whisperLift', 'whisperMode']);
    for (const s of cfg.standard.substitutions) {
      expect(s.effective).toBe(CANONICAL[s.id]);
      expect(s.reason).toMatch(/missing/);
    }
  });

  test('present-but-invalid canonical values throw (fail closed)', () => {
    expect(() => Preset.buildStandardProcessingConfig({ maskStrength: 2 })).toThrow(/maskStrength/);
    expect(() => Preset.buildStandardProcessingConfig({ maskStrength: -0.5 })).toThrow(/maskStrength/);
    expect(() => Preset.buildStandardProcessingConfig({ maskStrength: NaN })).toThrow(/maskStrength/);
    expect(() => Preset.buildStandardProcessingConfig({ maskStrength: '0.15' })).toThrow(/maskStrength/);
    expect(() => Preset.buildStandardProcessingConfig({ whisperMode: 1.5 })).toThrow(/whisperMode/);
    expect(() => Preset.buildStandardProcessingConfig({ whisperLift: 41 })).toThrow(/whisperLift/);
    expect(() => Preset.buildStandardProcessingConfig({ gateThresh: 5 })).toThrow(/gateThresh/);
  });

  test('result is frozen and survives a JSON round-trip (message protocol)', () => {
    const cfg = Preset.buildStandardProcessingConfig();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.spectral)).toBe(true);
    expect(Object.isFrozen(cfg.standard)).toBe(true);
    const rt = JSON.parse(JSON.stringify(cfg));
    expect(rt.spectral.maskStrength).toBe(0.15);
    expect(rt.spectral.whisperMode).toBe(1);
    expect(rt.spectral.whisperLift).toBe(8);
    expect(rt.revision).toBe('std1:emc1-mu4w9g');
    expect(rt.standard.profileId).toBe('voice-clarity');
    expect(rt.standard.configVersion).toBe(1);
    expect(rt.standard.status).toBe('canonical');
  });
});

describe('Engineer resolver', () => {
  test('Voice Clarity preset values resolve to canonical with no divergence', () => {
    const { config, resolution } = Preset.resolveEngineerProcessingConfig(
      { ...Preset.getStandardDefaultOverrides() },
      'Voice Clarity',
      { source: 'test' },
    );
    expect(resolution.mode).toBe('standard');
    expect(resolution.divergences).toEqual([]);
    expect(config.spectral.maskStrength).toBe(0.15);
    expect(config.revision).toBe('std1:emc1-mu4w9g');
    expect(config.standard.status).toBe('canonical');
  });

  test('no preset named resolves to the Standard default', () => {
    const { config, resolution } = Preset.resolveEngineerProcessingConfig({}, null);
    expect(resolution.mode).toBe('standard');
    expect(config.spectral.maskStrength).toBe(0.15);
  });

  test('a user-diverged canonical key yields a plain build with the divergence recorded', () => {
    const values = { ...Preset.getStandardDefaultOverrides(), gateThresh: -40 };
    const { config, resolution } = Preset.resolveEngineerProcessingConfig(values, 'Voice Clarity');
    expect(resolution.mode).toBe('diverged');
    expect(resolution.divergences).toHaveLength(1);
    expect(resolution.divergences[0].id).toBe('gateThresh');
    expect(resolution.divergences[0].requested).toBe(-40);
    expect(config.standard.status).toBe('diverged');
    // A diverged config carries NO canonical claim: plain revision.
    expect(config.revision).not.toMatch(/^std\d+:/);
    expect(config.revision).toMatch(/^emc1-/);
  });

  test('a diverged maskStrength is the user value, not silently reset to 0.15', () => {
    const values = { ...Preset.getStandardDefaultOverrides(), maskStrength: 0.5 };
    const { config, resolution } = Preset.resolveEngineerProcessingConfig(values, 'Voice Clarity');
    expect(resolution.mode).toBe('diverged');
    expect(config.spectral.maskStrength).toBe(0.5);
    expect(config.standard.status).toBe('diverged');
  });

  test('another preset resolves plain with its own values (no standard claim)', () => {
    const { config, resolution } = Preset.resolveEngineerProcessingConfig({}, 'Whisper Boost');
    expect(resolution.mode).toBe('preset');
    expect(config.standard.status).toBe('preset');
    expect(config.standard.profile).toBe('Whisper Boost');
    // Whisper Boost does not set maskStrength: schema default 1 (as trained).
    expect(config.spectral.maskStrength).toBe(1);
    expect(config.revision).toMatch(/^emc1-/);
  });

  test('an invalid canonical value throws instead of falling back', () => {
    expect(() => Preset.resolveEngineerProcessingConfig(
      { ...Preset.getStandardDefaultOverrides(), maskStrength: 2 },
      'Voice Clarity',
    )).toThrow(/maskStrength/);
  });
});

describe('Landing plan (QuickCleanPlan)', () => {
  test('bsrnn_vocals outcome carries the canonical Standard config', () => {
    const plan = QuickClean.resolveQuickCleanPlan('bsrnn_vocals');
    expect(plan.profileId).toBe('voice-clarity');
    expect(plan.configVersion).toBe(1);
    expect(plan.processingConfig.spectral.maskStrength).toBe(0.15);
    expect(plan.processingConfig.spectral.whisperMode).toBe(1);
    expect(plan.processingConfig.spectral.whisperLift).toBe(8);
    expect(plan.processingConfig.revision).toBe('std1:emc1-mu4w9g');
    expect(plan.processingConfig.standard.status).toBe('canonical');
    expect(plan.processingConfig.standard.source).toBe('quick-clean-plan:bsrnn_vocals');
  });

  test('other outcomes carry NO processingConfig (unmeasured at 0.15)', () => {
    for (const id of ['max_isolation', 'rnnoise', 'enhance_speech']) {
      const plan = QuickClean.resolveQuickCleanPlan(id);
      expect(plan.processingConfig).toBeNull();
      expect(plan.profileId).toBeNull();
      expect(plan.configVersion).toBeNull();
    }
  });
});

describe('capability registry (UI-01)', () => {
  test('disabled presets are not enabled, enabled presets are', () => {
    expect(Registry.isPresetEnabled('Aggressive Isolate')).toBe(false);
    expect(Registry.isPresetEnabled('Room Echo Reduction')).toBe(false);
    expect(Registry.isPresetEnabled('Voice Clarity')).toBe(true);
    expect(Registry.isPresetEnabled('Whisper Boost')).toBe(true);
  });

  test('revalidatePreset substitutes the Standard profile with a reason', () => {
    const checked = Registry.revalidatePreset('Aggressive Isolate');
    expect(checked.preset).toBe('Voice Clarity');
    expect(checked.substituted).toBe(true);
    expect(checked.reason).toMatch(/disabled/);
    const alias = Registry.revalidatePreset('Whisper in a Club');
    expect(alias.preset).toBe('Voice Clarity');
    expect(alias.substituted).toBe(true);
  });

  test('revalidateRecommendation rewrites a disabled recommendation', () => {
    const rec = {
      recommendedPreset: 'Room Echo Reduction',
      recommendedStageConfig: { reverbStrip: 500 },
      reasons: ['High reverb estimate → Room Echo Reduction'],
      autoApplySafe: true,
    };
    const fixed = Registry.revalidateRecommendation(rec);
    expect(fixed.recommendedPreset).toBe('Voice Clarity');
    expect(fixed.autoApplySafe).toBe(false);
    expect(fixed.reasons.length).toBeGreaterThan(rec.reasons.length);
    expect(fixed.recommendedStageConfig.maskStrength).toBe(0.15);
    expect(fixed.recommendedStageConfig.gateThresh).toBe(-58);
    // Input is not mutated.
    expect(rec.recommendedPreset).toBe('Room Echo Reduction');
  });

  test('findDisabledPresetsInRecommendation flags disabled presets', () => {
    expect(Registry.findDisabledPresetsInRecommendation({ recommendedPreset: 'Aggressive Isolate' }))
      .toEqual(['Aggressive Isolate']);
    expect(Registry.findDisabledPresetsInRecommendation({ recommendedPreset: 'Voice Clarity' }))
      .toEqual([]);
  });
});

describe('recommendation-generated plans', () => {
  const musicAnalysis = {
    snrDb: 12,
    rms: 0.05,
    loudnessEstimate: -26,
    whisperRegions: [],
    difficultSpeechRegions: [],
    musicSegments: [{ start: 0, end: 5 }, { start: 10, end: 15 }],
    speakerSegments: [{ start: 0, end: 20 }],
    overlapRegions: [],
    humProfile: {},
    roomEstimate: 0.2,
    confidenceScores: { musicRatio: 0.9, speechRatio: 0.6 },
    transientSegments: [],
  };

  test('a music bed never yields a disabled recommendation', () => {
    const rec = Recommend.recommendFromAnalysis(musicAnalysis);
    expect(Registry.findDisabledPresetsInRecommendation(rec)).toEqual([]);
    expect(rec.recommendedPreset).toBe('Voice Clarity');
    expect(rec.reasons.join(' ')).toMatch(/disabled/);
    expect(rec.reasons.join(' ')).toMatch(/Standard profile/);
  });

  test('the music-bed recommendation resolves to the canonical Standard config', () => {
    const rec = Recommend.recommendFromAnalysis(musicAnalysis);
    expect(rec.resolution.mode).toBe('standard');
    expect(rec.resolvedProcessingConfig.spectral.maskStrength).toBe(0.15);
    expect(rec.resolvedProcessingConfig.spectral.whisperMode).toBe(1);
    expect(rec.resolvedProcessingConfig.spectral.whisperLift).toBe(8);
    // The revision is version-prefixed, but its emc1 hash is NOT the bare
    // preset hash: the stage overlays tune NON-canonical keys (musicKill)
    // for this content, and the hash covers the full effective config.
    // That difference is deliberate — the four canonical keys are what
    // must be identical across paths, and the hash difference is exactly
    // the stage tuning (asserted below), not a canonical drift.
    expect(rec.resolvedProcessingConfig.revision).toMatch(/^std1:emc1-/);
    expect(rec.resolvedProcessingConfig.spectral.musicKill).toBe(85);
    expect(rec.resolvedProcessingConfig.standard.status).toBe('canonical');
    expect(rec.resolvedProcessingConfig.standard.source).toBe('recommendation-engine');
  });

  test('a high-reverb analysis never yields Room Echo Reduction', () => {
    const rec = Recommend.recommendFromAnalysis({
      ...musicAnalysis,
      musicSegments: [],
      confidenceScores: { musicRatio: 0, speechRatio: 0.6 },
      roomEstimate: 0.8,
    });
    expect(Registry.findDisabledPresetsInRecommendation(rec)).toEqual([]);
    expect(rec.recommendedPreset).not.toBe('Room Echo Reduction');
  });

  test('a null analysis yields a standard empty recommendation, never a legacy config', () => {
    // The corrupt-stage rejection path (resolution mode 'rejected') is a
    // defensive guard in generateRecommendation: stage values are built
    // from internal scenario/overlay constants, all in range by
    // construction, so no public input can drive an invalid stage value.
    // The fail-closed throw itself is proven at the resolver level
    // (canonical Standard builder + Engineer resolver tests above).
    const rec = Recommend.recommendFromAnalysis(null);
    expect(rec.resolution.mode).toBe('standard');
    expect(rec.resolvedProcessingConfig).not.toBeNull();
  });
});

describe('joint plan (AnalyzerWhisperBridge)', () => {
  test('the hunter music nudge never yields Aggressive Isolate', () => {
    const analysis = {
      snrDb: 12,
      rms: 0.05,
      whisperRegions: [],
      difficultSpeechRegions: [],
      musicSegments: [{ start: 0, end: 5 }],
      speakerSegments: [],
      overlapRegions: [],
      humProfile: {},
      roomEstimate: 0.2,
      confidenceScores: { musicRatio: 0.9, speechRatio: 0.6 },
      transientSegments: [],
    };
    const envProfile = { dominantNoise: 'music', musicRatio: 0.9, voiceRatio: 0.5, snrDb: 12 };
    const plan = Bridge.buildJointProcessingPlan(analysis, envProfile);
    expect(plan.recommendedPreset).not.toBe('Aggressive Isolate');
    expect(Registry.findDisabledPresetsInRecommendation(plan)).toEqual([]);
    expect(plan.reasons.join(' ')).toMatch(/disabled/);
  });
});

describe('cached plans and config versions', () => {
  test('a config-version change invalidates cached plans (different cache keys)', () => {
    const channels = [new Float32Array([0.1, -0.2, 0.3, -0.4])];
    const keyV1 = Cache.stemCacheKey(channels, 48000, ['bsrnn_vocals'], 'f.wav', 'std1:emc1-mu4w9g');
    const keyV2 = Cache.stemCacheKey(channels, 48000, ['bsrnn_vocals'], 'f.wav', 'std2:emc1-mu4w9g');
    const keyPlain = Cache.stemCacheKey(channels, 48000, ['bsrnn_vocals'], 'f.wav', 'emc1-mu4w9g');
    expect(keyV1).not.toBe(keyV2);
    expect(keyV1).not.toBe(keyPlain);
    expect(keyV2).not.toBe(keyPlain);
  });

  test('identical Standard configs produce identical cache keys', () => {
    const channels = [new Float32Array([0.1, -0.2, 0.3, -0.4])];
    const a = Cache.stemCacheKey(channels, 48000, ['bsrnn_vocals'], 'f.wav', 'std1:emc1-mu4w9g');
    const b = Cache.stemCacheKey(channels, 48000, ['bsrnn_vocals'], 'f.wav', 'std1:emc1-mu4w9g');
    expect(a).toBe(b);
  });
});
