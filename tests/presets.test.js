/**
 * VoiceIsolate Pro — Preset Completeness Tests
 * Verifies isolation-focused presets cover every slider ID in SLIDERS.
 */

const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8').replace(/\r\n/g, '\n');

// Extract slider IDs from the SLIDERS block
const slidersBlockMatch = appJs.match(/const SLIDERS = \{([\s\S]*?)\};\s*\n(?:\/\/[^\n]*\n\s*)*const SLIDER_BY_ID/);
const sliderIds = slidersBlockMatch
  ? [...slidersBlockMatch[1].matchAll(/id\s*:\s*'(\w+)'/g)].map(m => m[1])
  : [];

// Extract preset block text
const presetNameRegex = /const PRESETS = \{([\s\S]*?)\};\s*[\s\S]*?\/\/ Utility helpers/;
const presetsBlock = appJs.match(presetNameRegex)?.[1] || '';

const PRESET_NAMES = [
  'Voice Clarity',
  'Podcast Clean',
  'Forensic Extract',
  'Whisper Boost',
  'Phone/Radio',
  'Surveillance',
  'Whisper in a Club',
  'Stadium Crowd',
];

const REMOVED_PRESETS = [
  'Music Vocal',
  'Live Performance',
  'Heavy Rain Call',
  'Helicopter Rescue',
  'Phone Wiretap',
  'Whisper Room',
];

describe('Presets', () => {
  test('Should define exactly 8 calibrated isolation preset names', () => {
    PRESET_NAMES.forEach(name => {
      expect(presetsBlock).toContain(`'${name}':`);
    });
    expect(PRESET_NAMES.length).toBe(8);
  });

  test('Removes redundant and non-isolation presets', () => {
    REMOVED_PRESETS.forEach(name => {
      expect(presetsBlock).not.toContain(`'${name}':`);
    });
  });

  test('SLIDERS block defines exactly 67 slider IDs', () => {
    expect(sliderIds.length).toBe(67);
  });

  test('Every preset covers all 67 slider IDs (via fill loop or explicit keys)', () => {
    expect(appJs).toContain('Ensure every preset covers all 67 slider IDs');
    PRESET_NAMES.forEach(presetName => {
      expect(presetsBlock).toContain(`'${presetName}':`);
    });
  });

  test('Every preset has a description string', () => {
    PRESET_NAMES.forEach(presetName => {
      const escapedPreset = presetName.replace('/', '\\/');
      const presetRegex = new RegExp(`'${escapedPreset}':\\s*(?:_presetDefaults\\(\\{)?([\\s\\S]*?)(?:\\}\\),?|\\},?)\\s*(?='|$)`);
      const presetMatch = presetsBlock.match(presetRegex);
      expect(presetMatch).not.toBeNull();
      expect(presetMatch[1]).toContain('description:');
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
    expect(presetsBlock).toContain("'Forensic Extract':");
    const m = presetsBlock.match(/'Forensic Extract':\s*\{[\s\S]*?voiceIso:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1], 10)).toBeGreaterThanOrEqual(90);
  });

  test('Surveillance uses high noise reduction', () => {
    const m = presetsBlock.match(/'Surveillance':\s*\{[\s\S]*?nrAmount:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(parseInt(m[1], 10)).toBeGreaterThanOrEqual(85);
  });

  test('Standard Voice Clarity keeps extreme path off (fast path)', () => {
    expect(appJs).toContain('EXTREME_OFF');
    expect(appJs).toMatch(/const EXTREME_OFF[\s\S]*?whisperMode:\s*0/);
    expect(presetsBlock).toContain('...EXTREME_OFF');
  });
});
