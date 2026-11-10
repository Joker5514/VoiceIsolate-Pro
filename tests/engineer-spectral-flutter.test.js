/**
 * Musical-noise / flutter fix in the Engineer frame processor
 * (src/workers/EngineerSpectralControls.js):
 *   • the SNR-floor cut and the whisper lift fade in over a soft knee instead
 *     of switching per bin per frame;
 *   • Crowd Null confidence reads a per-bin power smoothed over frames, and
 *     Music Kill a smoothed stability, instead of the Rayleigh-random
 *     instantaneous magnitude of noise;
 *   • the whisper confidence blends toward that smoothed power by the Crowd
 *     Null strength, so Surveillance (Crowd Null 75) flutters less while
 *     presets without Crowd Null keep the instantaneous confidence (smoothing
 *     it everywhere cost Whisper Boost 0.07 dB SI-SDR).
 * Measured as the mean frame-to-frame change of each bin's applied gain on
 * stationary noise. Values before the fix (main ff1f009), same frames:
 *   Whisper Boost −50 dB 1.50, Forensic Extract −50 dB 1.48,
 *   Aggressive Isolate −60 dB 1.35, Surveillance −60 dB 2.15, Voice Clarity 0.40.
 * Round 2 (vs main 6e60541): Surveillance −60 dB 2.09 → 1.67, −50 dB 3.06 → 2.67;
 *   Whisper Boost 1.285 and Forensic Extract 1.222 unchanged.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let Schema;
let Presets;
beforeAll(async () => {
  Schema = await import('../src/core/ParameterSchema.js');
  Presets = await import('../src/core/PresetCalibration.js');
});

const G = Object.freeze({ fftSize: 4096, hop: 1024, bins: 2049, sampleRate: 48000 });
function helper() {
  const self = {};
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/workers/EngineerSpectralControls.js'), 'utf8');
  vm.runInNewContext(src, { self, globalThis: self, Float32Array, Math, Number, Object });
  return self;
}
function prng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function noiseFrames(levelDb, n = 160, seed = 5) {
  const r = prng(seed); const amp = 10 ** (levelDb / 20); const out = [];
  for (let f = 0; f < n; f++) {
    const re = new Float32Array(G.bins); const im = new Float32Array(G.bins); const src = new Float32Array(G.bins);
    for (let k = 0; k < G.bins; k++) {
      const g = () => (r() + r() + r() + r() - 2) * 0.8165 / Math.SQRT2 * amp;
      const a = g(); const b = g();
      src[k] = Math.hypot(a, b); re[k] = 0.3 * a; im[k] = 0.3 * b;
    }
    out.push({ re, im, src });
  }
  return out;
}
function values(preset) {
  const v = {};
  for (const spec of Schema.PARAMETER_SCHEMA) v[spec.id] = spec.default;
  return Object.assign(v, Presets.CALIBRATED_ENGINEER_PRESETS[preset]);
}
/** Mean |Δ gain dB| between consecutive frames, over bins 40..1700, after warm-up. */
function flutterDb(preset, levelDb) {
  const p = helper().createEngineerFrameProcessor(Schema.buildMlProcessingConfig(values(preset)), G);
  const gains = [];
  for (const f of noiseFrames(levelDb)) {
    const re = new Float32Array(f.re); const im = new Float32Array(f.im);
    p.applyFrame(re, im, f.src, 0, false);
    const g = new Float32Array(G.bins);
    for (let k = 0; k < G.bins; k++) g[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / (Math.hypot(f.re[k], f.im[k]) + 1e-30) + 1e-12);
    gains.push(g);
  }
  let acc = 0; let count = 0;
  for (let k = 40; k < 1700; k++) {
    let d = 0;
    for (let f = 21; f < gains.length; f++) d += Math.abs(gains[f][k] - gains[f - 1][k]);
    acc += d / (gains.length - 21); count++;
  }
  return acc / count;
}

test.each([
  ['Whisper Boost', -50, 1.35],
  ['Forensic Extract', -50, 1.35],
  ['Aggressive Isolate', -60, 1.0],
  ['Surveillance', -60, 1.85],
  ['Surveillance', -50, 2.85],
])('%s on noise at %d dB flutters less than %s dB per frame', (preset, db, limit) => {
  expect(flutterDb(preset, db)).toBeLessThan(limit);
});

test('a preset without the extreme controls is unchanged (Voice Clarity)', () => {
  expect(flutterDb('Voice Clarity', -50)).toBeCloseTo(0.40, 1);
});

test('the SNR-floor cut is continuous in level (no step at the floor)', () => {
  const h = helper();
  const v = values('Aggressive Isolate');
  const floorAmp = 10 ** (v.snrFloor / 20);
  // One bin, one frame, swept across the floor: neighbouring levels 0.25 dB
  // apart must give gains within 0.5 dB of each other.
  let prev = null; let worst = 0;
  for (let db = -12; db <= 12; db += 0.25) {
    const p = h.createEngineerFrameProcessor(Schema.buildMlProcessingConfig(v), G);
    const mag = floorAmp * 10 ** (db / 20);
    const re = new Float32Array(G.bins).fill(mag); const im = new Float32Array(G.bins);
    const src = new Float32Array(G.bins).fill(mag);
    p.applyFrame(re, im, src, 0, false);
    const g = 20 * Math.log10(re[400] / mag);
    if (prev != null) worst = Math.max(worst, Math.abs(g - prev));
    prev = g;
  }
  expect(worst).toBeLessThan(0.5);
});

// Presets without Crowd Null keep the instantaneous whisper confidence.
test.each([
  ['Whisper Boost', 1.285],
  ['Forensic Extract', 1.222],
])('%s whisper confidence is not smoothed (flutter stays %s dB)', (preset, value) => {
  expect(flutterDb(preset, -50)).toBeCloseTo(value, 2);
});
