/**
 * DSP-01 — Standard config runtime parity through the REAL worker
 * (LOCAL 2026-11-25, finish plan).
 *
 * The pure suite (tests/standard-config-parity.test.js) proves the four
 * paths resolve the same canonical values. This suite proves the values
 * actually reach the frame loop: the Landing, Engineer, and Stems-default
 * configs — resolved through their REAL builders — must produce
 * BIT-IDENTICAL audio through the production MLWorker + shipped
 * bsrnn_vocals.onnx, and the maskStrength value must be what changes the
 * output (s=0.15 output differs from s=1 output on the same input).
 *
 * The recommendation path deliberately tunes NON-canonical keys for the
 * content (stage overlays), so its full config differs from the bare
 * preset — and its output differs too. What must hold there is that the
 * recommendation config is EXACTLY the canonical core plus its own
 * non-canonical remainder: rebuilding canonical + remainder reproduces
 * the same revision and the same audio.
 *
 * Refusal cases prove the worker enforces the canonical claim itself
 * (ML-01/ML-02 boundary): a canonical claim with a missing, tampered,
 * wrong-typed, wrong-version, or disabled value is refused, never
 * silently run with a legacy mask.
 *
 * Each separate() is ~1 s of audio; the worker is shared across tests.
 * Timeouts are explicit (default Jest 5 s is too short for model load).
 */
'use strict';

const { createHash } = require('node:crypto');
const { createMlWorker } = require('../scripts/quality/lib/mlworker-node.cjs');

const TIMEOUT = 120000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 1 s speech-like fixture: harmonic complex + AM + noise. */
function fixtureInput(seed = 1234) {
  const rand = mulberry32(seed);
  const n = 48000;
  const out = new Float32Array(n);
  const freqs = [110, 220, 330, 440, 660, 880];
  for (let i = 0; i < n; i += 1) {
    const t = i / 48000;
    const am = 0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t); // syllabic AM
    let s = 0;
    for (let k = 0; k < freqs.length; k += 1) {
      s += Math.sin(2 * Math.PI * freqs[k] * t) / (k + 1);
    }
    out[i] = 0.12 * am * s + 0.02 * (rand() * 2 - 1);
  }
  return [out];
}

function hashChannels(channels) {
  const h = createHash('sha256');
  for (const c of channels) h.update(Buffer.from(c.buffer, c.byteOffset, c.byteLength));
  return h.digest('hex');
}

const MUSIC_ANALYSIS = {
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

let worker;
let Preset;
let Schema;
let Recommend;
let QuickClean;

beforeAll(async () => {
  worker = await createMlWorker();
  Preset = await import('../src/core/PresetCalibration.js');
  Schema = await import('../src/core/ParameterSchema.js');
  Recommend = await import('../src/core/RecommendationEngine.js');
  QuickClean = await import('../src/pipeline/QuickCleanPlan.js');
}, TIMEOUT);

describe('four paths, one effective config, one output', () => {
  test('Landing / Engineer / Stems-default configs are bit-identical through the worker', async () => {
    const input = fixtureInput();
    const landingCfg = QuickClean.resolveQuickCleanPlan('bsrnn_vocals').processingConfig;
    const engineerCfg = Preset.resolveEngineerProcessingConfig(
      { ...Preset.getStandardDefaultOverrides() },
      'Voice Clarity',
      { source: 'engineer-process' },
    ).config;
    const stemsCfg = Preset.resolveStemDefaultConfig(['bsrnn_vocals'], undefined);

    // Same effective config, proven before any inference runs.
    expect(landingCfg.revision).toBe('std1:emc1-mu4w9g');
    expect(engineerCfg.revision).toBe('std1:emc1-mu4w9g');
    expect(stemsCfg.revision).toBe('std1:emc1-mu4w9g');
    expect(engineerCfg.spectral).toEqual(landingCfg.spectral);
    expect(stemsCfg.spectral).toEqual(landingCfg.spectral);

    const a = await worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: landingCfg });
    const b = await worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: engineerCfg });
    const c = await worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: stemsCfg });

    expect(a.appliedProcessingConfigRevision).toBe('std1:emc1-mu4w9g');
    expect(b.appliedProcessingConfigRevision).toBe('std1:emc1-mu4w9g');
    expect(c.appliedProcessingConfigRevision).toBe('std1:emc1-mu4w9g');
    const ha = hashChannels(a.clean);
    const hb = hashChannels(b.clean);
    const hc = hashChannels(c.clean);
    expect(hb).toBe(ha);
    expect(hc).toBe(ha);
  }, TIMEOUT);

  test('the Stems resolver: explicit config wins, other chains get null', async () => {
    const explicit = Preset.buildStandardProcessingConfig({ maskStrength: 0.15 });
    expect(Preset.resolveStemDefaultConfig(['bsrnn_vocals'], explicit)).toBe(explicit);
    expect(Preset.resolveStemDefaultConfig(['bsrnn_vocals'], null)).toBeNull();
    expect(Preset.resolveStemDefaultConfig(['bsrnn_vocals', 'rnnoise'], undefined)).toBeNull();
    expect(Preset.resolveStemDefaultConfig(['rnnoise'], undefined)).toBeNull();
    const def = Preset.resolveStemDefaultConfig(['bsrnn_vocals'], undefined);
    expect(def.revision).toBe('std1:emc1-mu4w9g');
    expect(def.spectral.maskStrength).toBe(0.15);
  }, TIMEOUT);

  test('recommendation config = canonical core + its own stage overlay, nothing else', async () => {
    const input = fixtureInput();
    const rec = Recommend.recommendFromAnalysis(MUSIC_ANALYSIS);
    const recCfg = rec.resolvedProcessingConfig;
    expect(rec.resolution.mode).toBe('standard');
    expect(recCfg.spectral.maskStrength).toBe(0.15);
    expect(recCfg.spectral.whisperMode).toBe(1);
    expect(recCfg.spectral.whisperLift).toBe(8);
    expect(recCfg.revision).toMatch(/^std1:emc1-/);

    // Rebuild canonical + the recommendation's own non-canonical remainder:
    // it must reproduce the exact same revision (same full effective config).
    const { maskStrength, whisperMode, whisperLift, ...rest } = recCfg.spectral;
    expect(maskStrength).toBe(0.15);
    expect(whisperMode).toBe(1);
    expect(whisperLift).toBe(8);
    const rebuilt = Preset.buildStandardProcessingConfig(rest, { source: 'test-rebuild' });
    expect(rebuilt.revision).toBe(recCfg.revision);
    expect(rebuilt.spectral).toEqual(recCfg.spectral);

    const a = await worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: recCfg });
    const b = await worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: rebuilt });
    expect(a.appliedProcessingConfigRevision).toBe(recCfg.revision);
    expect(hashChannels(b.clean)).toBe(hashChannels(a.clean));
  }, TIMEOUT);
});

describe('maskStrength reaches the frame loop', () => {
  test('s=0.15 output differs from s=1 output on the same input', async () => {
    const input = fixtureInput();
    const canonical = Preset.buildStandardProcessingConfig();
    // Plain config, schema default maskStrength 1, no standard block.
    const s1 = Schema.buildMlProcessingConfig({});
    expect(s1.spectral.maskStrength).toBe(1);

    const a = await worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: canonical });
    const b = await worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: s1 });
    expect(hashChannels(b.clean)).not.toBe(hashChannels(a.clean));
    expect(a.appliedProcessingConfigRevision).toBe('std1:emc1-mu4w9g');
    expect(b.appliedProcessingConfigRevision).toBe(s1.revision);
  }, TIMEOUT);

  test('the standard block is metadata: same values without it give the same audio', async () => {
    const input = fixtureInput();
    const canonical = Preset.buildStandardProcessingConfig();
    // Same spectral values, plain build, no standard claim.
    const plain = Schema.buildMlProcessingConfig({ ...canonical.spectral });
    expect(plain.spectral).toEqual(canonical.spectral);
    expect(plain.revision).toBe('emc1-mu4w9g');

    const a = await worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: canonical });
    const b = await worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: plain });
    expect(hashChannels(b.clean)).toBe(hashChannels(a.clean));
  }, TIMEOUT);
});

describe('worker refuses corrupt canonical claims (fail closed)', () => {
  test('missing maskStrength in a canonical claim is refused', async () => {
    const input = fixtureInput();
    const canonical = Preset.buildStandardProcessingConfig();
    const broken = JSON.parse(JSON.stringify(canonical));
    delete broken.spectral.maskStrength;
    await expect(
      worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: broken }),
    ).rejects.toThrow(/Refusing process.*maskStrength/);
  }, TIMEOUT);

  test('tampered maskStrength in a canonical claim is refused', async () => {
    const input = fixtureInput();
    const canonical = Preset.buildStandardProcessingConfig();
    const tampered = JSON.parse(JSON.stringify(canonical));
    tampered.spectral.maskStrength = 0.5;
    await expect(
      worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: tampered }),
    ).rejects.toThrow(/Refusing process.*maskStrength=0\.5, expected 0\.15/);
  }, TIMEOUT);

  test('string-typed maskStrength in a canonical claim is refused', async () => {
    const input = fixtureInput();
    const canonical = Preset.buildStandardProcessingConfig();
    const typed = JSON.parse(JSON.stringify(canonical));
    typed.spectral.maskStrength = '0.15';
    await expect(
      worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: typed }),
    ).rejects.toThrow(/Refusing process.*maskStrength/);
  }, TIMEOUT);

  test('wrong config version in a canonical claim is refused', async () => {
    const input = fixtureInput();
    const canonical = Preset.buildStandardProcessingConfig();
    const wrong = JSON.parse(JSON.stringify(canonical));
    wrong.standard.configVersion = 99;
    await expect(
      worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: wrong }),
    ).rejects.toThrow(/Refusing process.*version 99/);
  }, TIMEOUT);

  test('a disabled profile in the standard block is refused', async () => {
    const input = fixtureInput();
    const canonical = Preset.buildStandardProcessingConfig();
    const disabled = JSON.parse(JSON.stringify(canonical));
    disabled.standard.profile = 'Aggressive Isolate';
    disabled.standard.profileId = 'aggressive-isolate';
    await expect(
      worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: disabled }),
    ).rejects.toThrow(/Refusing process.*disabled/);
  }, TIMEOUT);

  test('a diverged config (user value, no canonical claim) still runs', async () => {
    const input = fixtureInput();
    const { config } = Preset.resolveEngineerProcessingConfig(
      { ...Preset.getStandardDefaultOverrides(), maskStrength: 0.5 },
      'Voice Clarity',
    );
    expect(config.standard.status).toBe('diverged');
    const res = await worker.separate(input, { modelIds: ['bsrnn_vocals'], processingConfig: config });
    expect(res.appliedProcessingConfigRevision).toBe(config.revision);
    expect(res.clean[0].length).toBe(48000);
  }, TIMEOUT);
});
