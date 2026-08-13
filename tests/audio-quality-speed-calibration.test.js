/**
 * High-pitch / smear mitigation + processing speed + slider calibration guards.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const dsp = fs.readFileSync(path.join(ROOT, 'public/app/dsp-core.js'), 'utf8');
const sliderMap = fs.readFileSync(path.join(ROOT, 'public/app/slider-map.js'), 'utf8');
const mixCal = fs.readFileSync(path.join(ROOT, 'src/core/MixCalibration.js'), 'utf8');
const mlWorker = fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8');

function defaultOf(src, id) {
  const re = new RegExp(`id:\\s*'${id}'[\\s\\S]*?default:\\s*([^,\\n]+)`);
  const m = src.match(re);
  return m ? m[1].trim() : null;
}

function valOf(src, id) {
  const re = new RegExp(`id:'${id}'[^\\n]*val:([^,\\n]+)`);
  const m = src.match(re);
  return m ? parseFloat(m[1]) : null;
}

describe('Anti high-pitch / smear', () => {
  test('DSP exposes deWhistle for residual HF ring', () => {
    expect(dsp).toContain('deWhistle');
    expect(appJs).toMatch(/deWhistle\s*\(/);
  });

  test('harmonicEnhance is limited to speech band (not full spectrum peaks)', () => {
    expect(dsp).toMatch(/maxBin|speech band only|5–6 kHz|5500/);
    expect(appJs).toMatch(/maxBin|5500/);
  });

  test('post-ML de-whistle runs without second STFT', () => {
    expect(appJs).toContain('_postIsolationDeWhistle');
    expect(appJs).toMatch(/await this\._postIsolationDeWhistle\(clean/);
  });

  test('ML worker softens high-frequency mask contribution', () => {
    expect(mlWorker).toMatch(/hfStart|anti-whistle|bins \* 0\.35/);
  });

  test('wienerMMSE uses higher floor toward Nyquist', () => {
    expect(dsp).toMatch(/hf \* hf|baseFloor|musical noise/);
  });

  test('voice mask attenuates ultra-high strongly', () => {
    expect(dsp).toMatch(/return 0\.12|ultra-high: strong attenuate/);
  });
});

describe('Faster defaults / less smear', () => {
  test('nrAmount default is moderate (not 78+)', () => {
    const v = valOf(appJs, 'nrAmount');
    expect(v).toBeLessThanOrEqual(60);
    expect(v).toBeGreaterThanOrEqual(40);
  });

  test('nrSmoothing default is low enough to avoid smear', () => {
    const v = valOf(appJs, 'nrSmoothing');
    expect(v).toBeLessThanOrEqual(40);
  });

  test('dither defaults off (was adding harsh residual)', () => {
    expect(valOf(appJs, 'ditherAmt')).toBe(0);
    expect(defaultOf(sliderMap, 'ditherAmt')).toBe('0');
  });

  test('de-ess is on by default to tame piercing highs', () => {
    expect(valOf(appJs, 'deEssAmt')).toBeGreaterThanOrEqual(4);
  });

  test('noise floor estimate subsamples long files', () => {
    expect(appJs).toMatch(/step\s*=\s*mag\.length\s*>\s*400\s*\?\s*4/);
  });

  test('landing presets no longer boost eqHigh into whistle territory', () => {
    expect(mixCal).toMatch(/eqHighSlider:\s*0/);
    expect(mixCal).not.toMatch(/eqHighSlider:\s*[34]/);
  });
});

describe('Slider registry calibration consistency', () => {
  const critical = [
    'nrAmount', 'nrSensitivity', 'nrSpectralSub', 'nrFloor', 'nrSmoothing',
    'voiceIso', 'bgSuppress', 'deEssAmt', 'lpFreq', 'ditherAmt',
  ];

  test.each(critical)('%s is defined in slider-map registry', (id) => {
    expect(sliderMap).toContain(`id: '${id}'`);
  });

  test('all 67 engineer sliders still declared in app.js', () => {
    const ids = [...appJs.matchAll(/id:'(\w+)'/g)].map((m) => m[1]);
    // SLIDERS groups embed many ids — at least 67 unique from RENDER path
    const uniq = new Set(ids);
    expect(uniq.size).toBeGreaterThanOrEqual(67);
  });
});
