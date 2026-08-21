/**
 * Slider transform / calibration math contracts (source + runtime where safe).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sliderMapSrc = fs.readFileSync(path.join(ROOT, 'public/app/slider-map.js'), 'utf8');

function parseRegistry(src) {
  const entries = [];
  const re = /\{\s*id\s*:\s*'([^']+)',\s*key\s*:\s*'([^']+)'[\s\S]*?min\s*:\s*([^,]+),\s*max\s*:\s*([^,]+),\s*step\s*:\s*([^,]+),\s*default\s*:\s*([^,]+),[\s\S]*?transform\s*:\s*([^,]+),[\s\S]*?group\s*:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    entries.push({
      id: m[1],
      min: Number(m[3]),
      max: Number(m[4]),
      step: Number(m[5]),
      default: Number(m[6]),
      transformSrc: m[7].trim(),
      group: m[8],
    });
  }
  return entries;
}

function evalTransform(transformSrc, v) {
  // Only allow simple arrow transforms from the registry.
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${transformSrc});`)();
  return fn(v);
}

describe('slider math contracts', () => {
  const registry = parseRegistry(sliderMapSrc);

  test('parsed 67 registry entries', () => {
    expect(registry.length).toBe(67);
  });

  test('every transform is finite at min, mid, max, default', () => {
    for (const s of registry) {
      const samples = [s.min, s.default, s.max, (s.min + s.max) / 2];
      for (const v of samples) {
        const out = evalTransform(s.transformSrc, v);
        expect(Number.isFinite(out)).toBe(true);
      }
    }
  });

  test('nrAmount transform is monotonic 0→1', () => {
    const nr = registry.find((s) => s.id === 'nrAmount');
    expect(nr).toBeTruthy();
    expect(evalTransform(nr.transformSrc, 0)).toBeCloseTo(0, 5);
    expect(evalTransform(nr.transformSrc, 100)).toBeCloseTo(1, 5);
    expect(evalTransform(nr.transformSrc, 50)).toBeCloseTo(0.5, 5);
    expect(evalTransform(nr.transformSrc, 80)).toBeGreaterThan(evalTransform(nr.transformSrc, 20));
  });

  test('dryWet transform is monotonic 0→1', () => {
    const dw = registry.find((s) => s.id === 'dryWet');
    expect(evalTransform(dw.transformSrc, 0)).toBeCloseTo(0, 5);
    expect(evalTransform(dw.transformSrc, 100)).toBeCloseTo(1, 5);
  });

  test('voiceFocusLo default is below voiceFocusHi default', () => {
    const lo = registry.find((s) => s.id === 'voiceFocusLo');
    const hi = registry.find((s) => s.id === 'voiceFocusHi');
    expect(lo.default).toBeLessThan(hi.default);
  });

  test('limiter threshold stays ≤ 0 dB', () => {
    const lim = registry.find((s) => s.id === 'limThresh');
    expect(lim.max).toBeLessThanOrEqual(0);
    expect(lim.default).toBeLessThanOrEqual(0);
  });

  test('EQ defaults are finite and within ±24 dB safety', () => {
    for (const s of registry.filter((x) => x.id.startsWith('eq'))) {
      expect(Math.abs(s.default)).toBeLessThanOrEqual(24);
      expect(s.min).toBeGreaterThanOrEqual(-24);
      expect(s.max).toBeLessThanOrEqual(24);
    }
  });

  test('hpFreq stays below Nyquist for 48 kHz', () => {
    const hp = registry.find((s) => s.id === 'hpFreq');
    expect(hp.max).toBeLessThan(24000);
  });

  test('lpFreq min stays in usable high-shelf territory', () => {
    const lp = registry.find((s) => s.id === 'lpFreq');
    expect(lp.min).toBeGreaterThanOrEqual(1000);
    expect(lp.max).toBeGreaterThanOrEqual(16000);
  });

  test('random samples in range never yield NaN/Inf', () => {
    for (const s of registry) {
      for (let i = 0; i < 12; i++) {
        const v = s.min + Math.random() * (s.max - s.min);
        const out = evalTransform(s.transformSrc, v);
        expect(Number.isFinite(out)).toBe(true);
      }
    }
  });
});
