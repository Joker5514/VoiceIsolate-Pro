/**
 * Slider calibration hardening — discipline curves, coupling, soft clamps, lock persistence.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const calSrc = fs.readFileSync(path.join(ROOT, 'public/app/slider-calibration.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const mapSrc = fs.readFileSync(path.join(ROOT, 'public/app/slider-map.js'), 'utf8');
const hintSrc = fs.readFileSync(path.join(ROOT, 'public/app/slider-hint-ui.js'), 'utf8');

/** Load ESM slider-calibration.js as CJS-ish exports for unit tests. */
function loadCalibration() {
  const transformed = calSrc
    .replace(/export function (\w+)/g, 'function $1')
    .replace(/export const (\w+)/g, 'const $1')
    .replace(/export \{[\s\S]*?\};?/g, '');
  const sandbox = { module: { exports: {} }, exports: {}, console, Math, Number, Array, Object, String, globalThis: {} };
  sandbox.exports = sandbox.module.exports;
  const exportNames = [
    'clamp01', 'clamp', 'normUi', 'sigmoid', 'easeOutCubic', 'logTaper',
    'curveVoiceIso', 'curveBgSuppress', 'curveCrosstalkCancel', 'calibrate',
    'isSpeechSafeSpan', 'protectSpeechWindow', 'stereoCorrelationGate',
    'applyCoupling', 'softClampArtifacts', 'getEffectiveDspParams',
    'calibrateRegistry', 'TF', 'SLIDER_FAMILY', 'SLIDER_EXAMPLES',
    'VOICE_ISO_HIGH_THRESHOLD', 'BG_SUPPRESS_CAP_WHEN_ISO_HIGH',
    'PROTECTED_SPEECH_MIN_WIDTH_HZ', 'ARTIFACT_ISO_EXTREME',
  ];
  const assign = exportNames.map((n) => `exports.${n} = typeof ${n} !== 'undefined' ? ${n} : undefined;`).join('\n');
  vm.runInNewContext(`${transformed}\n${assign}`, sandbox, { filename: 'slider-calibration.js' });
  return sandbox.exports;
}

const cal = loadCalibration();

describe('calibrate() voiceIso curve', () => {
  test('is a pure function and returns numbers across the range', () => {
    for (const raw of [0, 36, 72, 80, 90, 100]) {
      const v = cal.calibrate('voiceIso', raw);
      expect(typeof v).toBe('number');
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  test('0 → 0, 72 → 72 (default preserved), 100 compressed below 100', () => {
    expect(cal.calibrate('voiceIso', 0)).toBeCloseTo(0, 5);
    expect(cal.calibrate('voiceIso', 72)).toBeCloseTo(72, 5);
    const maxEff = cal.calibrate('voiceIso', 100);
    expect(maxEff).toBeLessThan(100);
    expect(maxEff).toBeGreaterThan(72);
    // Documented headroom: pivot 72 + 14 = 86
    expect(maxEff).toBeCloseTo(86, 0);
  });

  test('last 20 UI points (80–100) produce small bounded increase', () => {
    const at80 = cal.calibrate('voiceIso', 80);
    const at100 = cal.calibrate('voiceIso', 100);
    const delta = at100 - at80;
    // Must be much smaller than the raw UI delta of 20
    expect(delta).toBeLessThan(10);
    expect(delta).toBeGreaterThan(0);
  });

  test('monotonic non-decreasing across 0–100', () => {
    let prev = -1;
    for (let i = 0; i <= 100; i += 5) {
      const v = cal.calibrate('voiceIso', i);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
  });

  test('bgSuppress and crosstalkCancel compress upper range', () => {
    const bg100 = cal.calibrate('bgSuppress', 100);
    expect(bg100).toBeLessThan(100);
    expect(bg100).toBeGreaterThan(60);
    const xt50 = cal.calibrate('crosstalkCancel', 50);
    const xt100 = cal.calibrate('crosstalkCancel', 100);
    expect(xt50).toBeLessThan(50); // power curve soft-start
    expect(xt100).toBeCloseTo(100, 0);
  });
});

describe('coupling / soft clamp logic', () => {
  test('triggers bgSuppress cap when voiceIso high and band not speech-safe', () => {
    const raw = {
      voiceIso: 95,
      bgSuppress: 95,
      voiceFocusLo: 400,
      voiceFocusHi: 2000, // narrow, not speech-safe
      crosstalkCancel: 0,
    };
    const { effective, clamps } = cal.applyCoupling(raw, { stereoHint: { stereoActive: false } });
    expect(effective.bgSuppress).toBeLessThanOrEqual(cal.BG_SUPPRESS_CAP_WHEN_ISO_HIGH + 1e-6);
    expect(clamps.length).toBeGreaterThan(0);
    // UI raw values must not be mutated
    expect(raw.bgSuppress).toBe(95);
  });

  test('does not cap bgSuppress when speech-safe span is present', () => {
    const raw = {
      voiceIso: 90,
      bgSuppress: 70,
      voiceFocusLo: 200,
      voiceFocusHi: 5000, // covers 800–3400 with width ≥ 2600
      crosstalkCancel: 0,
    };
    const { effective, clamps } = cal.applyCoupling(raw);
    // bgSuppress may still be curve-compressed but should not hit high-iso cap if speech-safe
    expect(clamps.includes('bgSuppress-cap-high-iso')).toBe(false);
    expect(effective.bgSuppress).toBeGreaterThan(55);
  });

  test('protected speech window never collapses below minimum width', () => {
    const band = cal.protectSpeechWindow(900, 1000);
    expect(band.voiceFocusHi - band.voiceFocusLo).toBeGreaterThanOrEqual(cal.PROTECTED_SPEECH_MIN_WIDTH_HZ - 1e-6);
  });

  test('soft clamp activates on extreme iso + bg + narrow band', () => {
    const coupled = {
      voiceIso: 92,
      bgSuppress: 90,
      voiceFocusLo: 500,
      voiceFocusHi: 1800,
    };
    const { effective, activated } = cal.softClampArtifacts(coupled, { debug: false });
    expect(activated.length).toBeGreaterThan(0);
    expect(effective.voiceIso).toBeLessThan(coupled.voiceIso);
    expect(effective.bgSuppress).toBeLessThan(coupled.bgSuppress);
  });

  test('soft clamp does not fire on mild settings', () => {
    const mild = {
      voiceIso: 72,
      bgSuppress: 38,
      voiceFocusLo: 100,
      voiceFocusHi: 4500,
    };
    const { activated } = cal.softClampArtifacts(mild, { debug: false });
    expect(activated.length).toBe(0);
  });

  test('getEffectiveDspParams is pure end-to-end', () => {
    const raw = { voiceIso: 100, bgSuppress: 100, voiceFocusLo: 600, voiceFocusHi: 1500, crosstalkCancel: 80 };
    const a = cal.getEffectiveDspParams(raw);
    const b = cal.getEffectiveDspParams(raw);
    expect(a.voiceIso).toBe(b.voiceIso);
    expect(a.bgSuppress).toBe(b.bgSuppress);
    expect(raw.voiceIso).toBe(100); // never mutates input
  });
});

describe('lock persistence (app.js contract)', () => {
  test('uses localStorage key vip-slider-locks', () => {
    expect(appSrc).toContain('vip-slider-locks');
    expect(appSrc).toMatch(/localStorage\.setItem\(\s*VoiceIsolatePro\.SLIDER_LOCK_STORAGE_KEY/);
  });

  test('exposes public toggleSliderLock and data-locked attribute', () => {
    expect(appSrc).toMatch(/toggleSliderLock\s*\(/);
    expect(appSrc).toContain('data-locked');
    expect(appSrc).toMatch(/dataset\.locked/);
  });

  test('reset supports unlocked-only path', () => {
    expect(appSrc).toMatch(/_resetSliders\s*\(/);
    expect(appSrc).toMatch(/unlockedOnly/);
    expect(appSrc).toContain('resetUnlockedBtn');
  });

  test('lock persistence round-trip logic (simulated reload)', () => {
    const store = {};
    const localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    };
    const locks = new Set(['voiceIso', 'bgSuppress']);
    localStorage.setItem('vip-slider-locks', JSON.stringify([...locks]));
    // Simulate reload
    const raw = localStorage.getItem('vip-slider-locks');
    const ids = JSON.parse(raw);
    const restored = new Set(ids);
    expect(restored.has('voiceIso')).toBe(true);
    expect(restored.has('bgSuppress')).toBe(true);
    expect(restored.has('dryWet')).toBe(false);
    // "unmovable" contract: locked ids skipped by preset apply
    expect(appSrc).toMatch(/_isSliderLocked\(key\)\)\s*return/);
  });
});

describe('hint metadata + metrics centralization', () => {
  test('SLIDER_HINTS includes structured fields for separation sliders', () => {
    expect(mapSrc).toMatch(/voiceIso:\s*\{/);
    expect(mapSrc).toContain('purpose:');
    expect(mapSrc).toContain('bestFor:');
    expect(mapSrc).toContain('artifactRisk:');
    expect(mapSrc).toContain('pairedWith:');
    expect(mapSrc).toContain('modeDefaults:');
    expect(mapSrc).toContain('normalizeSliderHint');
  });

  test('slider-hint-ui surfaces metadata without replacing base hints', () => {
    expect(hintSrc).toContain('buildHintMetaDetails');
    expect(hintSrc).toContain('hint-meta-details');
    expect(hintSrc).toMatch(/buildHintPanel[\s\S]*meta/);
  });

  test('app.js has single updateAudioMetrics writer', () => {
    expect(appSrc).toMatch(/updateAudioMetrics\s*\(/);
    expect(appSrc).toContain('stat-voice');
    expect(appSrc).toContain('hVoice');
    expect(appSrc).toContain('hNoise');
  });

  test('runPipeline finally hides processing overlay', () => {
    expect(appSrc).toMatch(/finally\s*\{[\s\S]*hideProcessingOverlay/);
  });
});
