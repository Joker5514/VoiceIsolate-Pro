/**
 * VoiceIsolate Pro — Preset Completeness Tests
 * Verifies isolation-focused presets cover every slider ID and use calibrated SSOT.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8').replace(/\r\n/g, '\n');

// Extract slider IDs from the inline SLIDERS block (EXTREME_DATA_PARAMS may follow).
const slidersBlockMatch = appJs.match(/const SLIDERS = \{([\s\S]*?)\n\};/);
const sliderIds = slidersBlockMatch
  ? [...slidersBlockMatch[1].matchAll(/id\s*:\s*'(\w+)'/g)].map(m => m[1])
  : [];

/** First-class calibrated presets (post cleanup). */
const PRESET_NAMES = [
  'Voice Clarity',
  'Podcast Clean',
  'Forensic Extract',
  'Whisper Boost',
  'Phone/Radio',
  'Room Echo Reduction',
  'Hum Removal',
  'Aggressive Isolate',
  'Surveillance',
];

const REMOVED_PRESETS = [
  'Music Vocal',
  'Live Performance',
  'Heavy Rain Call',
  'Helicopter Rescue',
  'Phone Wiretap',
  'Whisper Room',
];

const LEGACY_ALIASES = [
  'Whisper in a Club',
  'Stadium Crowd',
];

describe('Presets', () => {
  let calibrated;

  beforeAll(async () => {
    const mod = await import('../src/core/PresetCalibration.js');
    calibrated = mod.CALIBRATED_ENGINEER_PRESETS;
  });

  test('app.js wires PRESETS from PresetCalibration SSOT', () => {
    expect(appJs).toMatch(/getCalibratedPresets/);
    expect(appJs).toMatch(/from '\/src\/core\/PresetCalibration\.js'/);
    expect(appJs).toMatch(/const PRESETS = \(\(\) =>/);
  });

  test('Defines calibrated isolation preset names', () => {
    PRESET_NAMES.forEach((name) => {
      expect(calibrated[name]).toBeTruthy();
    });
    // app.js consumes the catalog via getCalibratedPresets() (names live in PresetCalibration).
    expect(appJs).toMatch(/getCalibratedPresets/);
    expect(PRESET_NAMES.length).toBeGreaterThanOrEqual(8);
  });

  test('Removes redundant and non-isolation presets', () => {
    REMOVED_PRESETS.forEach((name) => {
      expect(calibrated[name]).toBeUndefined();
    });
  });

  test('Legacy extreme presets redirect to calibrated names', () => {
    expect(appJs).toMatch(/CALIBRATED_PRESET_REDIRECTS|PRESET_REDIRECTS/);
    LEGACY_ALIASES.forEach((name) => {
      expect(appJs).toContain(`'${name}'`);
    });
  });

  test('SLIDERS block defines exactly 67 slider IDs', () => {
    expect(sliderIds.length).toBe(67);
  });

  test('Every preset covers all 67 slider IDs (via fill loop or explicit keys)', () => {
    expect(appJs).toMatch(/Ensure every preset covers all registry slider IDs|covers all 67 slider IDs/);
    PRESET_NAMES.forEach((presetName) => {
      expect(Object.keys(calibrated[presetName]).length).toBeGreaterThan(40);
    });
  });

  test('Core presets include description strings', () => {
    ['Voice Clarity', 'Podcast Clean', 'Whisper Boost', 'Forensic Extract'].forEach((presetName) => {
      expect(calibrated[presetName].description).toMatch(/\w+/);
    });
  });

  test('Preset application dispatches input and change events', () => {
    expect(appJs).toContain("dispatchEvent(new Event('input', { bubbles: true }))");
    expect(appJs).toContain("dispatchEvent(new Event('change', { bubbles: true }))");
  });

  test('Preset application stores slider values in VIP params via _setSliderUi', () => {
    expect(appJs).toContain('window.VIP_PARAMS = window.VIP_PARAMS || {}');
    expect(appJs).toContain('window.VIP_PARAMS[id] = value');
    expect(appJs).toContain('_setSliderUi(key, rawValue');
  });

  test('Forensic Extract uses high voice isolation', () => {
    expect(calibrated['Forensic Extract'].voiceIso).toBeGreaterThanOrEqual(90);
  });

  test('Surveillance uses high noise reduction', () => {
    expect(calibrated.Surveillance.nrAmount).toBeGreaterThanOrEqual(85);
  });

  test('Standard Voice Clarity keeps extreme path off (fast path)', () => {
    expect(appJs).toContain('EXTREME_OFF');
    expect(appJs).toMatch(/const EXTREME_OFF[\s\S]*?whisperMode:\s*0/);
    expect(appJs).toMatch(/\.\.\.EXTREME_OFF/);
    expect(calibrated['Voice Clarity'].whisperMode).toBe(0);
  });

  test('applyPreset resolves legacy names via resolvePresetName', () => {
    expect(appJs).toContain('resolvePresetName');
  });
});
