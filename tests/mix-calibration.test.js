/**
 * MixCalibration — preset completeness, loudness classification, auto-tune math.
 */
'use strict';

import {
  RT_SLIDER_DEFAULTS,
  LANDING_PRESETS,
  LANDING_PRESET_NAMES,
  buildPreset,
  calcRms,
  classifyLevel,
  calibrateFromStems,
  mergePreset,
  recommendEngineerPreset,
  levelOverrides,
} from '../src/core/MixCalibration.js';

const SLIDER_IDS = Object.keys(RT_SLIDER_DEFAULTS);

describe('MixCalibration — presets', () => {
  test('every landing preset covers all 23 real-time sliders', () => {
    for (const name of LANDING_PRESET_NAMES) {
      const preset = LANDING_PRESETS[name];
      for (const id of SLIDER_IDS) {
        expect(preset).toHaveProperty(id);
        expect(Number.isFinite(preset[id])).toBe(true);
      }
    }
  });

  test('whisper-boost lifts voice and keeps gate bypassed', () => {
    const p = LANDING_PRESETS['whisper-boost'];
    expect(p.voiceLevelSlider).toBeGreaterThan(100);
    expect(p.gateRangeSlider).toBe(0);
    expect(p.gateThresholdSlider).toBeLessThanOrEqual(-65);
  });

  test('buildPreset merges onto defaults', () => {
    const p = buildPreset({ voiceLevelSlider: 150 });
    expect(p.voiceLevelSlider).toBe(150);
    expect(p.volumeSlider).toBe(RT_SLIDER_DEFAULTS.volumeSlider);
  });

  test('mergePreset applies overrides', () => {
    const merged = mergePreset('balanced', { voiceLevelSlider: 130 });
    expect(merged.voiceLevelSlider).toBe(130);
    expect(merged.noiseReductionSlider).toBe(LANDING_PRESETS.balanced.noiseReductionSlider);
  });
});

describe('MixCalibration — loudness math', () => {
  test('calcRms of silence is ~0', () => {
    expect(calcRms(new Float32Array(48000))).toBeCloseTo(0, 5);
  });

  test('calcRms of unity sine is ~0.707', () => {
    const n = 4800;
    const buf = new Float32Array(n);
    for (let i = 0; i < n; i++) buf[i] = Math.sin(2 * Math.PI * 440 * i / 48000);
    expect(calcRms(buf)).toBeCloseTo(0.707, 2);
  });

  test('classifyLevel thresholds', () => {
    expect(classifyLevel(0.005)).toBe('whisper');
    expect(classifyLevel(0.02)).toBe('quiet');
    expect(classifyLevel(0.08)).toBe('normal');
    expect(classifyLevel(0.25)).toBe('loud');
  });
});

describe('MixCalibration — auto-calibration', () => {
  test('whisper stem selects whisper-boost preset', () => {
    const ch = new Float32Array(48000);
    for (let i = 0; i < ch.length; i++) ch[i] = 0.008 * Math.sin(2 * Math.PI * 300 * i / 48000);
    const result = calibrateFromStems([ch]);
    expect(result.level).toBe('whisper');
    expect(result.preset).toBe('whisper-boost');
    expect(result.sliders.voiceLevelSlider).toBeGreaterThan(120);
    expect(result.sliders.gateRangeSlider).toBe(0);
  });

  test('loud stem selects balanced with compression', () => {
    const ch = new Float32Array(4800);
    for (let i = 0; i < ch.length; i++) ch[i] = 0.5 * Math.sin(2 * Math.PI * 220 * i / 48000);
    const result = calibrateFromStems([ch]);
    expect(result.level).toBe('loud');
    expect(result.sliders.compThresholdSlider).toBeLessThan(0);
  });

  test('levelOverrides never gates whispers', () => {
    const o = levelOverrides('whisper', -50);
    expect(o.gateRangeSlider).toBe(0);
  });

  test('recommendEngineerPreset maps whisper to Whisper Boost', () => {
    const ch = new Float32Array(4800);
    for (let i = 0; i < ch.length; i++) ch[i] = 0.006 * Math.sin(2 * Math.PI * 300 * i / 48000);
    const rec = recommendEngineerPreset([ch]);
    expect(rec.preset).toBe('Whisper Boost');
    expect(rec.level).toBe('whisper');
  });
});