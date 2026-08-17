/**
 * Desktop Engineer Mode slider UX/a11y contracts (static + registry).
 * Complements dsp-slider.test.js (DOM unit) without booting full app.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const mapSrc = fs.readFileSync(path.join(ROOT, 'public/app/slider-map.js'), 'utf8');
const themeCss = fs.readFileSync(path.join(ROOT, 'public/app/slider-theme.css'), 'utf8');
const engCss = fs.readFileSync(path.join(ROOT, 'public/app/engineer-console.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
const dspSliderSrc = fs.readFileSync(path.join(ROOT, 'src/presentation/DspSlider.js'), 'utf8');

describe('DspSlider module present', () => {
  test('src/presentation/DspSlider.js exports factory + helpers', () => {
    expect(dspSliderSrc).toMatch(/export function createDspSliderRow/);
    expect(dspSliderSrc).toMatch(/export function clampSnap/);
    expect(dspSliderSrc).toMatch(/export function buildAriaValueText/);
    expect(dspSliderSrc).toMatch(/export function sliderMatchesQuery/);
    expect(dspSliderSrc).toMatch(/aria-valuetext/);
    expect(dspSliderSrc).toMatch(/PageUp/);
    expect(dspSliderSrc).toMatch(/type = 'number'/);
  });

  test('app.js wires createDspSliderRow into _appendSliderRow', () => {
    expect(appSrc).toMatch(/from '\/src\/presentation\/DspSlider\.js'/);
    expect(appSrc).toMatch(/createDspSliderRow\s*\(/);
    expect(appSrc).toMatch(/_applyControlFilters/);
    expect(appSrc).toMatch(/_resetSliderGroup/);
    expect(appSrc).toMatch(/row\._dspSlider/);
  });
});

describe('registry aliases + lock/reset wiring', () => {
  test('SLIDER_ALIASES exported and includes denoise / de-reverb', () => {
    expect(mapSrc).toMatch(/export const SLIDER_ALIASES/);
    expect(mapSrc).toMatch(/denoise/);
    expect(mapSrc).toMatch(/de-reverb/);
    expect(mapSrc).toMatch(/aliases:/);
  });

  test('lock uses human label not raw id only', () => {
    expect(appSrc).toMatch(/Unlock \$\{labelText\}/);
    expect(appSrc).toMatch(/Lock \$\{labelText\}/);
  });

  test('presets and reset skip locked parameters', () => {
    expect(appSrc).toMatch(/if \(this\._isSliderLocked\(key\)\) return;/);
    expect(appSrc).toMatch(/if \(unlockedOnly && this\._isSliderLocked\(id\)\) return;/);
  });
});

describe('Engineer HTML control browser', () => {
  test('search, clear, All/Changed/Locked filters, status live region', () => {
    expect(indexHtml).toMatch(/id="sliderSearch"/);
    expect(indexHtml).toMatch(/id="sliderSearchClear"/);
    expect(indexHtml).toMatch(/id="sliderFilterAll"/);
    expect(indexHtml).toMatch(/id="sliderFilterChanged"/);
    expect(indexHtml).toMatch(/id="sliderFilterLocked"/);
    expect(indexHtml).toMatch(/id="sliderFilterStatus"/);
    expect(indexHtml).toMatch(/aria-live="polite"/);
    expect(indexHtml).toMatch(/role="search"/);
  });

  test('each major group has Reset group action', () => {
    for (const id of [
      'section-gate',
      'section-eq',
      'section-dynamics',
      'section-spectral',
      'section-advanced',
      'section-output',
      'section-separation',
      'tab-extreme-group',
    ]) {
      expect(indexHtml).toMatch(new RegExp(`data-reset-group="${id}"`));
    }
  });
});

describe('desktop layout CSS root causes fixed', () => {
  test('rack uses single-column slider panel by default (not cramped 2-col)', () => {
    expect(engCss).toMatch(/ec-col-rack \.slider-panel[\s\S]{0,120}flex-direction:\s*column/);
    // dual column only on ultrawide
    expect(engCss).toMatch(/@media \(min-width:\s*1800px\)/);
  });

  test('rack scroll padding keeps last controls usable', () => {
    expect(engCss).toMatch(/padding-bottom:\s*max\(96px/);
    expect(engCss).toMatch(/scroll-padding-bottom:\s*96px/);
  });

  test('hit targets and drag isolation tokens present', () => {
    expect(themeCss).toMatch(/--vip-hit:\s*40px/);
    expect(themeCss).toMatch(/--vip-thumb-size:\s*20px/);
    expect(themeCss).toMatch(/body\.is-slider-dragging/);
    expect(themeCss).toMatch(/\.slider-reset-btn/);
    expect(themeCss).toMatch(/dsp-slider-number/);
    expect(themeCss).toMatch(/touch-action:\s*none/);
  });

  test('focus-visible styles preserved for keyboard users', () => {
    expect(themeCss).toMatch(/:focus-visible/);
  });
});

describe('registry completeness (static parse)', () => {
  test('RAW registry still has 67 id/key pairs', () => {
    const re = /\{\s*id\s*:\s*'([^']+)',\s*key\s*:\s*'([^']+)'/g;
    const ids = [];
    let m;
    while ((m = re.exec(mapSrc)) !== null) ids.push(m[1]);
    expect(ids.length).toBe(67);
    expect(new Set(ids).size).toBe(67);
  });
});
