'use strict';

/**
 * DSP-fallback noise bed. The ML quality gate does not run this path.
 *
 * Before: whole-file minimum × 1.25 (app.js _estimateNoiseFloor).
 * After: DSPCore.AdaptiveNoiseFloor, 400 ms window, then the same × 1.25.
 * A bed of 0.02 for 0.5 s then 0.50 for 2 s stays at 0.025 on the minimum
 * and rises with the tracker.
 */
const fs = require('fs');
const path = require('path');
const DSPCore = require('../public/app/dsp-core.js');

const SR = 48000;
const HOP = 512;
const QUIET = 0.02;
const LOUD = 0.50;

function frames(level, seconds) {
  const n = Math.round(seconds * SR / HOP);
  return Array.from({ length: n }, () => new Float32Array([level, level]));
}

function globalMinFloor(mag) {
  let min = Infinity;
  const step = mag.length > 400 ? 4 : mag.length > 150 ? 2 : 1;
  for (let f = 0; f < mag.length; f += step) min = Math.min(min, mag[f][0]);
  return min * 1.25;
}

function trackedFloor(mag) {
  const tracker = new DSPCore.AdaptiveNoiseFloor(2, 400, HOP, SR);
  for (const frame of mag) tracker.update(frame);
  return tracker.getFloor()[0] * 1.25;
}

const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');

test('the DSP fallback spectral stage tracks the noise floor instead of the file minimum', () => {
  const quietThenLoud = frames(QUIET, 0.5).concat(frames(LOUD, 2));
  const before = globalMinFloor(quietThenLoud);
  const after = trackedFloor(quietThenLoud);
  const stationary = trackedFloor(frames(LOUD, 2));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    beforeGlobalMin: Number(before.toFixed(4)),
    afterTracker: Number(after.toFixed(4)),
    stationaryLoud: Number(stationary.toFixed(4)),
    frames: quietThenLoud.length,
  }));
  expect(before).toBeCloseTo(QUIET * 1.25, 5);
  expect(after).toBeGreaterThan(0.2);
  expect(after).toBeGreaterThan(before * 8);
  expect(stationary).toBeGreaterThan(LOUD * 0.5);
  expect(stationary).toBeLessThan(LOUD * 1.25 * 1.2);
  expect(appJs).toMatch(/const noise = this\._trackNoiseFloor\(mag, sr, HOP\)/);
  expect(appJs).toMatch(/new Tracker\(mag\[0\]\.length, 400, hop \|\| 512, sr \|\| 48000\)/);
});
