/**
 * Every Process-time spectral control must change what the Engineer frame
 * processor does to a frame sequence somewhere in its declared range, and the
 * two level-referenced controls must honour their stated semantics:
 *
 *   • nrFloor is "the minimum gain any frequency can be reduced to". The NR
 *     term alone never reaches it (its deepest cut is 0.18 ≈ −15 dB, above the
 *     whole −120..−20 dB range), so the floor has to bind on the combined
 *     reduction — before this contract existed the slider was inert.
 *   • breathControl acts on frames that are quiet relative to the surrounding
 *     speech. frameEnergy is in un-normalised STFT units, so the previous fixed
 *     threshold (0.025 ≈ −64 dBFS broadband at fft 4096) only ever matched
 *     digital silence.
 *
 * Runs the real helper (src/workers/EngineerSpectralControls.js) in a vm
 * sandbox on synthetic complex frames; no ONNX Runtime.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let Schema;

beforeAll(async () => {
  Schema = await import('../src/core/ParameterSchema.js');
});

function loadSpectralControlHelper() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src/workers/EngineerSpectralControls.js'),
    'utf8',
  );
  const self = {};
  vm.runInNewContext(source, { self, globalThis: self, Float32Array, Math, Number, Object });
  return self;
}

const GEOMETRY = Object.freeze({ fftSize: 4096, hop: 1024, bins: 2049, sampleRate: 48000 });
const BIN_HZ = GEOMETRY.sampleRate / GEOMETRY.fftSize;
// Un-normalised STFT units (fft 4096 Hann): sine amplitude A → ≈1024·A at its
// bin, white noise of RMS σ → ≈39·σ per bin.
const SINE_GAIN = GEOMETRY.fftSize / 4;
const NOISE_GAIN = Math.sqrt(3 * GEOMETRY.fftSize / 8);

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Speech-like frame sequence: harmonics up to 5 kHz plus a 4–9 kHz fricative
 * band during "on" stretches, broadband noise throughout, with silent gaps.
 * Mirrors MLWorker's contract: `re`/`im` are the model-masked bins (here the
 * speech plus a 0.3 residual of the noise), `source` is the mixture magnitude
 * the noise-floor tracker and confidence terms read.
 * @returns {{ re: Float32Array, im: Float32Array, source: Float32Array }[]}
 */
function synthFrames({
  frames = 120, speechDb = -20, noiseDb = -45, seed = 7, onFrames = 40, period = 60,
  gapNoiseDb = null,
} = {}) {
  const rand = prng(seed);
  const amp = Math.pow(10, speechDb / 20) * SINE_GAIN;
  const out = [];
  for (let f = 0; f < frames; f++) {
    const on = (f % period) < onFrames;
    const sigma = Math.pow(10, (on || gapNoiseDb == null ? noiseDb : gapNoiseDb) / 20) * NOISE_GAIN;
    const env = on ? 0.5 + 0.5 * Math.sin(((f % onFrames) / onFrames) * Math.PI) : 0;
    const f0 = 140 + 40 * Math.sin(f / 9);
    const re = new Float32Array(GEOMETRY.bins);
    const im = new Float32Array(GEOMETRY.bins);
    const source = new Float32Array(GEOMETRY.bins);
    for (let k = 0; k < GEOMETRY.bins; k++) {
      // Approximately Gaussian noise per component.
      const nr = (rand() + rand() + rand() + rand() - 2) * 0.8165 * sigma / Math.SQRT2;
      const ni = (rand() + rand() + rand() + rand() - 2) * 0.8165 * sigma / Math.SQRT2;
      let sr = 0;
      let si = 0;
      if (on) {
        const hz = k * BIN_HZ;
        const h = hz / f0;
        const near = Math.abs(h - Math.round(h));
        const harmonic = near < 0.25 && hz < 5000 ? Math.exp(-near * near * 40) * Math.exp(-hz / 2500) : 0;
        const fricative = hz > 4000 && hz < 9000 ? 0.15 : 0;
        const mag = amp * env * (harmonic + fricative) * (0.3 + 0.7 * rand());
        const phase = rand() * 2 * Math.PI;
        sr = mag * Math.cos(phase);
        si = mag * Math.sin(phase);
      }
      source[k] = Math.hypot(sr + nr, si + ni);
      re[k] = sr + 0.3 * nr;
      im[k] = si + 0.3 * ni;
    }
    out.push({ re, im, source });
  }
  return out;
}

function scaleFrames(frames, factor) {
  return frames.map(({ re, im, source }) => ({
    re: re.map((v) => v * factor),
    im: im.map((v) => v * factor),
    source: source.map((v) => v * factor),
  }));
}

function magnitude(re, im, k) {
  return Math.hypot(re[k], im[k]);
}

/** Run the processor over the frames; returns processed copies. */
function run(helper, values, frames) {
  const config = Schema.buildMlProcessingConfig(values);
  const processor = helper.createEngineerFrameProcessor(config, GEOMETRY);
  expect(processor).not.toBeNull();
  return frames.map((frame) => {
    const re = new Float32Array(frame.re);
    const im = new Float32Array(frame.im);
    processor.applyFrame(re, im, frame.source, 0, false);
    return { re, im };
  });
}

/** Energy of (a − b) relative to a, in dB; −Infinity when identical. */
function differenceDb(a, b) {
  let num = 0;
  let den = 0;
  for (let f = 0; f < a.length; f++) {
    for (let k = 0; k < a[f].re.length; k++) {
      const ma = magnitude(a[f].re, a[f].im, k);
      const mb = magnitude(b[f].re, b[f].im, k);
      num += (ma - mb) * (ma - mb);
      den += ma * ma;
    }
  }
  return 10 * Math.log10(num / Math.max(den, 1e-30));
}

function defaults() {
  const out = {};
  for (const spec of Schema.PARAMETER_SCHEMA) out[spec.id] = spec.default;
  return out;
}

/**
 * Settings that make a dependent control observable: a decay needs its
 * effect enabled, the whisper curve controls need a whisper mode, and the
 * floor needs a chain that cuts deeper than its shallowest value (−20 dB).
 */
const CONTEXT = Object.freeze({
  derevDecay: { derevAmt: 60 },
  harmOrder: { harmRecov: 60 },
  snrFloor: { whisperLift: 20 },
  whisperClarity: { whisperMode: 2 },
  whisperSensitivity: { whisperMode: 2, whisperLift: 20 },
  whisperThreshold: { whisperMode: 2 },
  nrFloor: { nrAmount: 100, nrSpectralSub: 100, whisperMode: 3, whisperClarity: 0 },
});

/** Pinned copy of ML_SPECTRAL_PARAM_IDS so test.each can enumerate before beforeAll. */
const SPECTRAL_IDS = Object.freeze([
  'nrAmount', 'nrSensitivity', 'nrSpectralSub', 'nrFloor', 'nrSmoothing',
  'formantShift', 'derevAmt', 'derevDecay', 'harmRecov', 'harmOrder',
  'voiceFocusLo', 'voiceFocusHi', 'whisperLift', 'crowdNull', 'bassCrush',
  'reverbStrip', 'voiceTunnel', 'musicKill', 'snrFloor', 'whisperMode',
  'whisperClarity', 'whisperSensitivity', 'whisperThreshold', 'transientShaper',
  'breathControl', 'roomCorrection', 'subHarmonic',
]);

describe('Engineer spectral controls — every control changes the output', () => {
  const helper = loadSpectralControlHelper();
  const frames = synthFrames({ frames: 60, onFrames: 20, period: 30 });

  test('the enumerated ids are exactly the schema\'s Process-time spectral ids', () => {
    expect([...SPECTRAL_IDS].sort()).toEqual([...Schema.ML_SPECTRAL_PARAM_IDS].sort());
  });

  test.each([...SPECTRAL_IDS])('%s: min and max produce different frames', (id) => {
    const spec = Schema.PARAMETER_BY_ID.get(id);
    const base = { ...defaults(), ...(CONTEXT[id] || {}) };
    const lo = run(helper, { ...base, [id]: spec.min }, frames);
    const hi = run(helper, { ...base, [id]: spec.max }, frames);
    const diff = differenceDb(lo, hi);
    expect(Number.isFinite(diff)).toBe(true);
    expect(diff).toBeGreaterThan(-60);
  });
});

describe('nrFloor — minimum gain of the Process-time spectral chain', () => {
  const helper = loadSpectralControlHelper();
  const frames = synthFrames({ frames: 60, onFrames: 20, period: 30 });
  const deep = () => ({ ...defaults(), ...CONTEXT.nrFloor });

  /** Smallest output/input magnitude ratio over bins that carry signal. */
  function minimumGain(processed) {
    let min = Infinity;
    for (let f = 0; f < frames.length; f++) {
      for (let k = 0; k < GEOMETRY.bins; k++) {
        const input = magnitude(frames[f].re, frames[f].im, k);
        if (input < 1e-6) continue;
        min = Math.min(min, magnitude(processed[f].re, processed[f].im, k) / input);
      }
    }
    return min;
  }

  test('the chain can cut deeper than −20 dB when the floor is out of the way', () => {
    const gain = minimumGain(run(helper, { ...deep(), nrFloor: -120 }, frames));
    expect(gain).toBeLessThan(Math.pow(10, -20 / 20));
  });

  test.each([-20, -30, -40])('no bin is reduced below the floor at %d dB', (floorDb) => {
    const floor = Math.pow(10, floorDb / 20);
    const openMinimum = minimumGain(run(helper, { ...deep(), nrFloor: -120 }, frames));
    const gain = minimumGain(run(helper, { ...deep(), nrFloor: floorDb }, frames));
    expect(gain).toBeGreaterThanOrEqual(floor * (1 - 1e-5));
    // Where the unfloored chain cuts below the floor, the floor is reached
    // (within smoothing), not merely respected.
    if (openMinimum < floor) expect(gain).toBeLessThan(floor * 1.5);
    else expect(gain).toBeCloseTo(openMinimum, 6);
  });

  test('the floor only ever raises a bin, never lowers it', () => {
    const open = run(helper, { ...deep(), nrFloor: -120 }, frames);
    const floored = run(helper, { ...deep(), nrFloor: -20 }, frames);
    let raised = 0;
    for (let f = 0; f < frames.length; f++) {
      for (let k = 0; k < GEOMETRY.bins; k++) {
        const before = magnitude(open[f].re, open[f].im, k);
        const after = magnitude(floored[f].re, floored[f].im, k);
        expect(after).toBeGreaterThanOrEqual(before * (1 - 1e-6));
        if (after > before * (1 + 1e-6)) raised++;
      }
    }
    expect(raised).toBeGreaterThan(0);
  });
});

describe('breathControl — quiet frames relative to the surrounding speech', () => {
  const helper = loadSpectralControlHelper();
  // 40 speech frames then 20 frames of a breath-like bed 30 dB below speech
  // (−50 dBFS broadband), repeated. Realistic breath levels, not digital silence.
  const frames = synthFrames({ gapNoiseDb: -50, noiseDb: -60 });
  const hiBin = Math.ceil(6000 / BIN_HZ);
  const loBin = Math.floor(2000 / BIN_HZ);

  function meanRatio(processed, reference, bin, frameFilter) {
    let num = 0;
    let den = 0;
    for (let f = 0; f < frames.length; f++) {
      if (!frameFilter(f)) continue;
      num += magnitude(processed[f].re, processed[f].im, bin);
      den += magnitude(reference[f].re, reference[f].im, bin);
    }
    return num / den;
  }

  const isGapTail = (f) => (f % 60) >= 50; // last 10 frames of each 20-frame gap: smoothing settled
  const isSpeechCore = (f) => (f % 60) >= 10 && (f % 60) < 35;

  test('attenuates >4.5 kHz in breath frames, leaves speech frames and low bins alone', () => {
    const off = run(helper, { ...defaults(), breathControl: 0 }, frames);
    const on = run(helper, { ...defaults(), breathControl: 100 }, frames);
    const gapHigh = meanRatio(on, off, hiBin, isGapTail);
    const gapLow = meanRatio(on, off, loBin, isGapTail);
    const speechHigh = meanRatio(on, off, hiBin, isSpeechCore);
    // Full strength multiplies the gain by 0.28 (−11 dB) once smoothing settles.
    expect(gapHigh).toBeLessThan(0.45);
    expect(gapLow).toBeCloseTo(1, 6);
    expect(speechHigh).toBeCloseTo(1, 6);
  });

  test('strength scales the reduction monotonically', () => {
    const off = run(helper, { ...defaults(), breathControl: 0 }, frames);
    const ratios = [25, 50, 100].map((amount) => meanRatio(
      run(helper, { ...defaults(), breathControl: amount }, frames), off, hiBin, isGapTail,
    ));
    expect(ratios[0]).toBeLessThan(1);
    expect(ratios[1]).toBeLessThan(ratios[0]);
    expect(ratios[2]).toBeLessThan(ratios[1]);
  });

  test('detection follows the recording level instead of a fixed STFT-unit threshold', () => {
    const quiet = scaleFrames(frames, Math.pow(10, -30 / 20));
    const loud = scaleFrames(frames, Math.pow(10, 12 / 20));
    for (const input of [quiet, loud]) {
      const off = run(helper, { ...defaults(), breathControl: 0 }, input);
      const on = run(helper, { ...defaults(), breathControl: 100 }, input);
      let num = 0;
      let den = 0;
      for (let f = 0; f < input.length; f++) {
        if (!isGapTail(f)) continue;
        num += magnitude(on[f].re, on[f].im, hiBin);
        den += magnitude(off[f].re, off[f].im, hiBin);
      }
      expect(num / den).toBeLessThan(0.45);
    }
  });
});
