/**
 * VoiceIsolate Pro — slider-map.js Module Tests
 *
 * Validates the SLIDER_REGISTRY and STAGES exports in the new dedicated module.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const sliderMapSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/slider-map.js'),
  'utf8'
);

// ── SLIDER_REGISTRY ────────────────────────────────────────────────────────────
describe('SLIDER_REGISTRY', () => {
  // Parse entries by extracting each { id, key, transform, target } object block
  const entries = [];
  const re = /\{\s*id\s*:\s*'([^']+)',\s*key\s*:\s*'([^']+)',\s*transform\s*:\s*[^,]+,\s*target\s*:\s*'([^']+)'\s*\}/g;
  let m;
  while ((m = re.exec(sliderMapSrc)) !== null) {
    entries.push({ id: m[1], key: m[2], target: m[3] });
  }

  test('slider-map.js exports SLIDER_REGISTRY', () => {
    expect(sliderMapSrc).toContain('export const SLIDER_REGISTRY');
  });

  test('SLIDER_REGISTRY contains exactly 52 entries', () => {
    expect(entries.length).toBe(52);
  });

  test('all entries have unique IDs', () => {
    const ids = entries.map(e => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('all entries have matching id and key', () => {
    for (const e of entries) {
      expect(e.key).toBe(e.id);
    }
  });

  test('all target values are valid (worklet | worker | both)', () => {
    const valid = new Set(['worklet', 'worker', 'both']);
    for (const e of entries) {
      expect(valid.has(e.target)).toBe(true);
    }
  });

  test('includes expected worklet slider: gateThresh', () => {
    const entry = entries.find(e => e.id === 'gateThresh');
    expect(entry).toBeDefined();
    expect(entry.target).toBe('worklet');
  });

  test('includes expected worker slider: nrAmount', () => {
    const entry = entries.find(e => e.id === 'nrAmount');
    expect(entry).toBeDefined();
    expect(entry.target).toBe('worker');
  });

  test('all 52 slider IDs match the SLIDERS definition in app.js', () => {
    const appJs = fs.readFileSync(
      path.join(__dirname, '../public/app/app.js'), 'utf8'
    );
    const slidersBlockMatch = appJs.match(/const SLIDERS = \{([\s\S]*?)\};\s*\nconst SLIDER_MAP/);
    expect(slidersBlockMatch).not.toBeNull();
    const appIds = [...slidersBlockMatch[1].matchAll(/id\s*:\s*'([^']+)'/g)].map(x => x[1]);
    const registryIds = entries.map(e => e.id);
    expect(registryIds).toEqual(appIds);
  });
});

// ── STAGES ────────────────────────────────────────────────────────────────────
describe('STAGES', () => {
  test('slider-map.js exports STAGES', () => {
    expect(sliderMapSrc).toContain('export const STAGES');
  });

  test('contains exactly 32 stage entries', () => {
    const stagesMatch = sliderMapSrc.match(/export const STAGES = \[([\s\S]*?)\];/);
    expect(stagesMatch).not.toBeNull();
    const items = stagesMatch[1].match(/'[^']+'/g) || [];
    expect(items.length).toBe(32);
  });

  test('first stage is S01: Input Decode', () => {
    expect(sliderMapSrc).toContain("'S01: Input Decode'");
  });

  test('last stage is S32: Final Export Ready', () => {
    expect(sliderMapSrc).toContain("'S32: Final Export Ready'");
  });

  test('includes the forward STFT stage (S10)', () => {
    expect(sliderMapSrc).toContain("'S10: Forward STFT'");
  });

  test('includes the inverse STFT stage (S20)', () => {
    expect(sliderMapSrc).toContain("'S20: Inverse STFT'");
  });
});

// ── app.js import ─────────────────────────────────────────────────────────────
describe('app.js integration', () => {
  const appSrc = fs.readFileSync(
    path.join(__dirname, '../public/app/app.js'), 'utf8'
  );

  test('app.js imports SLIDER_REGISTRY and STAGES from slider-map.js', () => {
    expect(appSrc).toMatch(/import\s+\{[^}]*SLIDER_REGISTRY[^}]*\}\s+from\s+'\.\/slider-map\.js'/);
    expect(appSrc).toMatch(/import\s+\{[^}]*STAGES[^}]*\}\s+from\s+'\.\/slider-map\.js'/);
  });

  test('app.js no longer contains an inline STAGES definition', () => {
    expect(appSrc).not.toMatch(/^const STAGES\s*=/m);
  });

  test('app.js contains no duplicate STAGES definition', () => {
    // The only `const STAGES` should be in slider-map.js, not app.js
    const inApp = (appSrc.match(/const STAGES\s*=/g) || []).length;
    expect(inApp).toBe(0);
  });
});
