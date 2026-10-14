'use strict';
/**
 * MainsHumFilter: offline 50/60 Hz hum notch MLWorker runs once per Process.
 */
const fs = require('fs');
const path = require('path');
const S = require('../scripts/quality/lib/signals.cjs');
const M = require('../scripts/quality/lib/metrics.cjs');
const { scenarios } = require('../scripts/quality/scenarios.cjs');

const SR = 48000;
// Classic-worker script (package type is module, so it cannot be require()d):
// run it with `self` bound to a plain scope, as importScripts would.
const scope = {};
new Function('self', fs.readFileSync(path.join(__dirname, '../src/workers/MainsHumFilter.js'), 'utf8'))(scope);
const { detectMainsHum, removeMainsHum } = scope;

function tones(seconds, parts) {
  const n = Math.round(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const [f, a] of parts) v += a * Math.sin((2 * Math.PI * f * i) / SR);
    x[i] = v;
  }
  return x;
}

/** Steady-state amplitude of a sinusoid at f (projection over the middle second). */
function amplitudeAt(x, f) {
  const start = Math.floor(x.length / 2 - SR / 2);
  let re = 0;
  let im = 0;
  for (let i = 0; i < SR; i++) {
    re += x[start + i] * Math.cos((2 * Math.PI * f * (start + i)) / SR);
    im += x[start + i] * Math.sin((2 * Math.PI * f * (start + i)) / SR);
  }
  return (2 * Math.hypot(re, im)) / SR;
}

describe('MainsHumFilter', () => {
  it('detects a 50 Hz series and notches every harmonic by >= 30 dB', () => {
    const x = tones(4, [[50, 0.3], [100, 0.15], [150, 0.1], [1030, 0.2]]);
    const { samples, hum } = removeMainsHum(x, SR);
    expect(hum.fundamental).toBe(50);
    for (const f of [50, 100, 150]) {
      expect(hum.harmonics.some((h) => Math.abs(h - f) < 0.2)).toBe(true);
      expect(20 * Math.log10(amplitudeAt(samples, f) / amplitudeAt(x, f))).toBeLessThan(-30);
    }
    // A tone between notches is untouched.
    expect(Math.abs(20 * Math.log10(amplitudeAt(samples, 1030) / amplitudeAt(x, 1030)))).toBeLessThan(0.05);
    expect(samples.length).toBe(x.length);
  });

  it('follows off-nominal mains (60.3 Hz) and a missing fundamental (120/180 Hz buzz)', () => {
    const drift = removeMainsHum(tones(4, [[60.3, 0.3], [120.6, 0.2]]), SR);
    expect(drift.hum.fundamental).toBe(60);
    expect(Math.abs(drift.hum.harmonics[0] - 60.3)).toBeLessThan(0.1);

    const buzz = tones(4, [[120, 0.3], [180, 0.2], [240, 0.1]]);
    const out = removeMainsHum(buzz, SR);
    expect(out.hum.fundamental).toBe(60);
    expect(20 * Math.log10(amplitudeAt(out.samples, 120) / amplitudeAt(buzz, 120))).toBeLessThan(-30);
  });

  // Speech synthesis is slow under Jest (~2 s per second of talker), so this
  // samples one fixture per noise family; the quality gate covers the rest.
  it('leaves speech, noise and music fixtures alone (returns the same array)', () => {
    for (const sc of scenarios(2)) {
      if (!['clean-speech', 'hvac-5db', 'music-0db', 'noise-only'].includes(sc.id)) continue;
      const { input } = sc.build();
      const r = removeMainsHum(input, SR);
      expect({ id: sc.id, hum: r.hum }).toEqual({ id: sc.id, hum: null });
      expect(r.samples).toBe(input);
    }
  });

  it('raises SI-SDR of the 10 dB hum fixture by more than 10 dB', () => {
    const fx = scenarios(2).find((s) => s.id === 'hum-10db').build();
    const { samples } = removeMainsHum(fx.input, SR);
    expect(M.siSdr(samples, fx.ref) - M.siSdr(fx.input, fx.ref)).toBeGreaterThan(10);
  });

  it('skips input shorter than one analysis window and digital silence', () => {
    expect(detectMainsHum(tones(0.5, [[60, 0.5]]), SR)).toBeNull();
    expect(detectMainsHum(new Float32Array(SR * 2), SR)).toBeNull();
    expect(detectMainsHum(S.whiteNoise(SR * 2, 7), SR)).toBeNull();
  });
});
