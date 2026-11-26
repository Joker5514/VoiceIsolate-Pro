/**
 * UI-01 — capability registry is the authority (LOCAL 2026-11-25).
 *
 * The registry derives every capability fact from PresetCalibration's
 * disabled flags + ModelManifest's shipped flags — no duplicated lists,
 * no hardcoded preset list anywhere else. RecommendationEngine and
 * AnalyzerWhisperBridge re-route through it; the worker enforces the
 * same list at init. This suite proves the registry's own contract:
 * attestation snapshots are wholesale-replaced (never mutated in place),
 * revalidation substitutes the Standard profile with a recorded reason,
 * and disabled presets can never be reintroduced through it.
 *
 * Known limit (recorded, not hidden): the MODEL side of the registry is
 * written but not yet queried by production code — OrtStatus records the
 * validated attestation snapshot and MLWorkerHost clears it on worker
 * creation, but no caller passes it to getModelCapability(id, snapshot)
 * before recommending. The worker remains the enforcement point for
 * model availability (rejects unshipped models at load; self-test gates
 * readiness in the capability table). Wiring model-gating into the
 * recommendation flow is a separate behavior change, not part of UI-01.
 */
'use strict';

let Registry;
let Preset;

beforeAll(async () => {
  Registry = await import('../src/core/CapabilityRegistry.js');
  Preset = await import('../src/core/PresetCalibration.js');
});

describe('preset capabilities', () => {
  test('every preset in the calibration table has a capability entry', () => {
    for (const name of Object.keys(Preset.CALIBRATED_ENGINEER_PRESETS)) {
      const cap = Registry.getPresetCapability(name);
      expect(typeof cap.enabled).toBe('boolean');
      expect(cap.id).toBe(name);
      expect(cap.kind).toBe('preset');
    }
    // The two disabled presets are the only disabled ones.
    const disabled = Object.keys(Preset.CALIBRATED_ENGINEER_PRESETS)
      .filter((n) => !Registry.isPresetEnabled(n));
    expect(disabled.sort()).toEqual(['Aggressive Isolate', 'Room Echo Reduction'].sort());
  });

  test('aliases resolve to the same capability as their preset', () => {
    expect(Registry.isPresetEnabled('Whisper in a Club')).toBe(false);
    expect(Registry.getPresetCapability('Whisper in a Club').id).toBe('Aggressive Isolate');
    expect(Registry.getPresetCapability('Whisper in a Club').status).toBe('disabled');
    expect(Registry.isPresetEnabled('Voice Clarity')).toBe(true);
    expect(Registry.getPresetCapability('Voice Clarity').status).toBe('ready');
  });

  test('unknown preset names resolve to the Standard profile (fail-safe)', () => {
    // resolvePresetName falls back to 'Voice Clarity' for unknown names,
    // so an unknown name can never smuggle in a disabled preset.
    expect(Registry.getPresetCapability('Not A Preset').id).toBe('Voice Clarity');
    expect(Registry.isPresetEnabled('Not A Preset')).toBe(true);
  });
});

describe('model capabilities', () => {
  test('shipped models are unknown before attestation, unshipped are unavailable', () => {
    const cap = Registry.getModelCapability('bsrnn_vocals');
    expect(cap.enabled).toBe(false);
    expect(cap.status).toBe('unknown');
    expect(cap.reason).toMatch(/No worker attestation/);
    const unshipped = Registry.getModelCapability('bsrnn_complex');
    expect(unshipped.enabled).toBe(false);
    expect(unshipped.status).toBe('unavailable');
    expect(unshipped.reason).toMatch(/not shipped/);
    const unknown = Registry.getModelCapability('not-a-model');
    expect(unknown.status).toBe('unavailable');
    expect(unknown.reason).toMatch(/Unknown model/);
  });

  test('a passed snapshot drives model state; the store replaces wholesale', () => {
    const snap = {
      bsrnn_vocals: { id: 'bsrnn_vocals', kind: 'model', enabled: true, status: 'ready', reason: null },
      rnnoise: { id: 'rnnoise', kind: 'model', enabled: false, status: 'degraded', reason: 'hash mismatch' },
    };
    Registry.recordAttestationSnapshot(snap);
    expect(Registry.getAttestationSnapshot()).toEqual(snap);
    expect(Registry.getModelCapability('bsrnn_vocals', Registry.getAttestationSnapshot()).status).toBe('ready');
    expect(Registry.getModelCapability('rnnoise', Registry.getAttestationSnapshot()).status).toBe('degraded');
    expect(Registry.getModelCapability('rnnoise', Registry.getAttestationSnapshot()).reason).toBe('hash mismatch');

    // A new snapshot replaces the old one wholesale: rnnoise is gone.
    Registry.recordAttestationSnapshot({
      bsrnn_vocals: { id: 'bsrnn_vocals', kind: 'model', enabled: true, status: 'ready', reason: null },
    });
    expect(Registry.getModelCapability('rnnoise', Registry.getAttestationSnapshot()).status).toBe('unknown');
    Registry.clearAttestationSnapshot();
    expect(Registry.getAttestationSnapshot()).toEqual({});
    expect(Registry.getModelCapability('bsrnn_vocals', Registry.getAttestationSnapshot()).status).toBe('unknown');
  });
});

describe('revalidation', () => {
  test('revalidatePreset never returns a disabled preset', () => {
    for (const name of ['Aggressive Isolate', 'Room Echo Reduction', 'Whisper in a Club']) {
      const checked = Registry.revalidatePreset(name);
      expect(checked.substituted).toBe(true);
      expect(checked.preset).toBe('Voice Clarity');
      expect(Registry.isPresetEnabled(checked.preset)).toBe(true);
      expect(checked.reason).toMatch(/disabled/);
    }
    const ok = Registry.revalidatePreset('Whisper Boost');
    expect(ok.substituted).toBe(false);
    expect(ok.preset).toBe('Whisper Boost');
  });

  test('revalidateRecommendation cannot reintroduce a disabled preset', () => {
    const rec = {
      recommendedPreset: 'Aggressive Isolate',
      recommendedStageConfig: { musicKill: 90 },
      reasons: ['Music bed present → Aggressive Isolate to suppress accompaniment'],
      autoApplySafe: true,
    };
    const fixed = Registry.revalidateRecommendation(rec);
    expect(fixed.recommendedPreset).toBe('Voice Clarity');
    expect(fixed.autoApplySafe).toBe(false);
    expect(fixed.recommendedStageConfig.maskStrength).toBe(0.15);
    expect(fixed.recommendedStageConfig.whisperMode).toBe(1);
    expect(fixed.recommendedStageConfig.whisperLift).toBe(8);
    expect(fixed.recommendedStageConfig.gateThresh).toBe(-58);
    // The original musicKill tuning is preserved (non-canonical key).
    expect(fixed.recommendedStageConfig.musicKill).toBe(90);
    // Input is not mutated.
    expect(rec.recommendedPreset).toBe('Aggressive Isolate');
    // Re-running revalidation is a no-op: the disabled preset is gone.
    const again = Registry.revalidateRecommendation(fixed);
    expect(again.recommendedPreset).toBe('Voice Clarity');
    expect(Registry.findDisabledPresetsInRecommendation(again)).toEqual([]);
  });
});
