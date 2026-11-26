/**
 * Preset validation against SLIDER_REGISTRY + calibrated catalog.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const META_KEYS = new Set(['description', 'humRemoval', 'disabled', 'disabledReason', 'maskStrength']);
const sliderMapSrc = fs.readFileSync(path.join(ROOT, 'public/app/slider-map.js'), 'utf8');

function parseRegistry(src) {
  const entries = [];
  const re = /\{\s*id\s*:\s*'([^']+)',\s*key\s*:\s*'([^']+)'[\s\S]*?min\s*:\s*([^,]+),\s*max\s*:\s*([^,]+),\s*step\s*:\s*([^,]+),\s*default\s*:\s*([^,]+),/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    entries.push({
      id: m[1],
      min: Number(m[3]),
      max: Number(m[4]),
      default: Number(m[6]),
    });
  }
  return entries;
}

describe('preset validation', () => {
  let calibrated;
  let redirects;
  let resolvePresetName;
  const registry = parseRegistry(sliderMapSrc);

  beforeAll(async () => {
    const presets = await import('../src/core/PresetCalibration.js');
    calibrated = presets.CALIBRATED_ENGINEER_PRESETS;
    redirects = presets.PRESET_REDIRECTS;
    resolvePresetName = presets.resolvePresetName;
  });

  test('registry parse found 67 ids', () => {
    expect(registry.length).toBe(67);
  });

  test('every calibrated preset exists and has a description', () => {
    const names = Object.keys(calibrated);
    expect(names.length).toBeGreaterThanOrEqual(8);
    for (const name of names) {
      expect(typeof calibrated[name].description).toBe('string');
      expect(calibrated[name].description.length).toBeGreaterThan(8);
    }
  });

  test('preset keys are registry ids or allowlisted meta', () => {
    const ids = new Set(registry.map((s) => s.id));
    const unknown = [];
    for (const [name, preset] of Object.entries(calibrated)) {
      for (const key of Object.keys(preset)) {
        if (META_KEYS.has(key)) continue;
        if (!ids.has(key)) unknown.push(`${name}.${key}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  test('every slider value is finite and within registry bounds', () => {
    const byId = Object.fromEntries(registry.map((s) => [s.id, s]));
    const bad = [];
    for (const [name, preset] of Object.entries(calibrated)) {
      for (const [key, raw] of Object.entries(preset)) {
        if (META_KEYS.has(key)) continue;
        const spec = byId[key];
        if (!spec) continue;
        const v = Number(raw);
        if (!Number.isFinite(v)) bad.push(`${name}.${key}=nonfinite`);
        else if (v < spec.min || v > spec.max) bad.push(`${name}.${key}=${v} not in [${spec.min},${spec.max}]`);
      }
    }
    expect(bad).toEqual([]);
  });

  test('every registry id is present after fill semantics', () => {
    for (const [, preset] of Object.entries(calibrated)) {
      for (const s of registry) {
        expect(preset[s.id]).not.toBeUndefined();
      }
    }
  });

  test('redirects resolve to real presets', () => {
    for (const [from, to] of Object.entries(redirects)) {
      expect(calibrated[to]).toBeTruthy();
      expect(resolvePresetName(from)).toBe(to);
    }
  });

  // LM Arena fix session 4 (LOCAL 2026-11-25): Voice Clarity now uses the
  // Light whisper path (whisperMode 1, whisperLift 8) so quiet speech is
  // preserved instead of gated away. The old pin (whisperMode 0) is
  // superseded — the whisper path runs inside the existing STFT pass, no
  // extra transform, no added latency.
  test('Voice Clarity uses the Light whisper path (session 4)', () => {
    expect(calibrated['Voice Clarity'].whisperMode).toBe(1);
    expect(calibrated['Voice Clarity'].whisperLift).toBe(8);
    expect(calibrated['Voice Clarity'].crowdNull).toBe(0);
  });

  test('Forensic Extract keeps high isolation without runaway makeup+outGain', () => {
    const f = calibrated['Forensic Extract'];
    expect(f.voiceIso).toBeGreaterThanOrEqual(90);
    expect((f.compMakeup || 0) + (f.outGain || 0)).toBeLessThanOrEqual(10);
  });

  test('Surveillance keeps high NR', () => {
    expect(calibrated.Surveillance.nrAmount).toBeGreaterThanOrEqual(85);
  });

  test('round-trip copy is deterministic', () => {
    const a = JSON.stringify(calibrated['Podcast Clean']);
    const b = JSON.stringify({ ...calibrated['Podcast Clean'] });
    expect(a).toBe(b);
  });

  // LM Arena fix session 2 (LOCAL 2026-11-25): disabled presets resolve to
  // null unless explicitly acknowledged; aliases hit the same gate.
  test('disabled presets resolve to null unless acknowledged (session 2)', async () => {
    const mod = await import('../src/core/PresetCalibration.js');
    expect(Object.keys(mod.PRESET_DISABLED).sort()).toEqual(['Aggressive Isolate', 'Room Echo Reduction']);
    expect(mod.isPresetDisabled('Aggressive Isolate')).toBe(true);
    expect(mod.isPresetDisabled('Room Echo Reduction')).toBe(true);
    expect(mod.isPresetDisabled('Voice Clarity')).toBe(false);
    expect(mod.resolveEngineerPreset('Aggressive Isolate')).toBeNull();
    expect(mod.resolveEngineerPreset('Room Echo Reduction')).toBeNull();
    // Alias resolves to the disabled preset first, then the gate applies.
    expect(mod.resolveEngineerPreset('Whisper in a Club')).toBeNull();
    expect(mod.resolveEngineerPreset('Aggressive Isolate', { acknowledged: true })).toBe('Aggressive Isolate');
    expect(mod.resolveEngineerPreset('Voice Clarity')).toBe('Voice Clarity');
    expect(mod.presetDisabledReason('Voice Clarity')).toBeNull();
    expect(typeof mod.presetDisabledReason('Aggressive Isolate')).toBe('string');
  });
});
