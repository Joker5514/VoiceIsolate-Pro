'use strict';

/**
 * Identity and sanitize contracts for the four-fix perf bundle:
 *   • finiteUnitMask / residual / overlap-add normalize still sanitize
 *     NaN and ±Inf exactly as main did (Number.isFinite repair).
 *   • landing and enhance stems are bit-identical to main on corpus fixtures
 *     (max abs 0).
 *   • engineer presets (Whisper Boost, Surveillance) are bit-identical to
 *     main goldens (max abs 0) after keeping |bin| in Float64.
 *   • HfPostFilter output is identical to main's always-log10 path on a
 *     fixture set of frames, and sppFromRatio matches smoothStep(10·log10).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures/perf-bundle');
const SR = 48000;

jest.setTimeout(120000);

function readF32(file) {
  const b = fs.readFileSync(file);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
}

function maxAbs(a, b) {
  const n = Math.min(a.length, b.length);
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return Infinity;
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  if (a.length !== b.length) m = Math.max(m, Infinity);
  return m;
}

describe('maxAbs rejects non-finite values', () => {
  test('matching NaN or Infinity is not treated as zero error', () => {
    expect(maxAbs(new Float32Array([0, 1]), new Float32Array([0, 1]))).toBe(0);
    expect(maxAbs(new Float32Array([1]), new Float32Array([1.5]))).toBe(0.5);
    expect(maxAbs(new Float32Array([NaN]), new Float32Array([NaN]))).toBe(Infinity);
    expect(maxAbs(new Float32Array([Infinity]), new Float32Array([Infinity]))).toBe(Infinity);
    expect(maxAbs(new Float32Array([-Infinity]), new Float32Array([-Infinity]))).toBe(Infinity);
    expect(maxAbs(new Float32Array([NaN]), new Float32Array([0]))).toBe(Infinity);
    expect(maxAbs(new Float32Array([0]), new Float32Array([Infinity]))).toBe(Infinity);
    expect(maxAbs(new Float32Array([1, NaN, 3]), new Float32Array([1, NaN, 3]))).toBe(Infinity);
    // Length mismatch is still infinite error.
    expect(maxAbs(new Float32Array([1]), new Float32Array([1, 2]))).toBe(Infinity);
  });
});

function loadWorkerHooks() {
  class Tensor {
    constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
  }
  const self = {
    navigator: { hardwareConcurrency: 8, userAgent: 'Mozilla/5.0 (Windows NT 10.0)' },
    postMessage() {},
  };
  const sandbox = {
    self,
    ort: { Tensor, env: { wasm: {} } },
    console: { log() {}, warn() {}, info() {}, debug() {}, error() {} },
    performance, setTimeout, clearTimeout, Promise, Math, Object, Array, Set, Map, Error,
    Number, String, JSON, Symbol, Float32Array, Float64Array, Uint32Array, Uint8Array, Int16Array,
    importScripts(...urls) {
      for (const u of urls) {
        if (/ort(\.min)?\.js$/.test(u)) continue;
        const file = path.join(ROOT, u.replace(/^\//, ''));
        vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
      }
    },
  };
  vm.createContext(sandbox);
  const code = fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8')
    + '\nself.__residual = residual; self.__mask = finiteUnitMask; self.__normalize = overlapAddNormalize;';
  vm.runInContext(code, sandbox);
  return self;
}

function loadHf(file) {
  const self = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    self, globalThis: self, Math, Float32Array, Float64Array, Uint8Array, Object, Number,
  });
  return self;
}

function legacyFiniteUnitMask(sample) {
  const n = +sample;
  if (!Number.isFinite(n)) return 1;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function legacyResidual(channelData, cleanChannels) {
  return channelData.map((input, ch) => {
    const clean = cleanChannels[ch];
    const noise = new Float32Array(input.length);
    const n = Math.min(input.length, clean.length);
    for (let i = 0; i < n; i++) {
      const s = Number.isFinite(input[i]) ? input[i] : 0;
      const c = Number.isFinite(clean[i]) ? clean[i] : 0;
      noise[i] = s - c;
    }
    for (let i = n; i < input.length; i++) {
      noise[i] = Number.isFinite(input[i]) ? input[i] : 0;
    }
    return noise;
  });
}

function legacyNormalize(out, norm, samples) {
  const dest = new Float32Array(out);
  for (let i = 0; i < dest.length; i++) {
    const y = dest[i] / Math.max(norm[i], 1e-12);
    dest[i] = Number.isFinite(y) ? y : (Number.isFinite(samples[i]) ? samples[i] : 0);
  }
  return dest;
}

function smoothStep(x, a, b) {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const t = (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

describe('perf-bundle sanitize (NaN/Inf matches main)', () => {
  const w = loadWorkerHooks();

  test('finiteUnitMask matches Number.isFinite sanitize, including ±Inf and NaN', () => {
    const samples = [
      NaN, Infinity, -Infinity, 0, -0, 1, -1, 0.5, 0.25, 2, -2,
      Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, 1e-40, 1 + 1e-16,
      undefined, null, '', '0.5', 'foo', true, false,
    ];
    for (const s of samples) {
      const got = w.__mask(s);
      const exp = legacyFiniteUnitMask(s);
      if (Object.is(got, exp) || got === exp) continue;
      throw new Error(`finiteUnitMask(${String(s)}) = ${got}, expected ${exp}`);
    }
  });

  test('residual happy-path is bit-identical on finite audio and sanitizes like main', () => {
    const N = 32;
    const input = new Float32Array(N);
    const clean = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      input[i] = Math.sin(i * 0.3) * 0.8;
      clean[i] = Math.sin(i * 0.3) * 0.5;
    }
    let got = w.__residual([input], [clean])[0];
    let exp = legacyResidual([input], [clean])[0];
    expect(maxAbs(got, exp)).toBe(0);

    const cases = [
      { at: 3, inp: NaN, cln: 0.2 },
      { at: 5, inp: Infinity, cln: 0.2 },
      { at: 7, inp: -Infinity, cln: 0.2 },
      { at: 9, inp: 0.3, cln: NaN },
      { at: 11, inp: 0.3, cln: Infinity },
      { at: 13, inp: 0.3, cln: -Infinity },
      { at: 15, inp: NaN, cln: NaN },
      { at: 17, inp: Infinity, cln: -Infinity },
    ];
    const dirtyIn = input.slice();
    const dirtyCl = clean.slice();
    for (const c of cases) {
      dirtyIn[c.at] = c.inp;
      dirtyCl[c.at] = c.cln;
    }
    got = w.__residual([dirtyIn], [dirtyCl])[0];
    exp = legacyResidual([dirtyIn], [dirtyCl])[0];
    expect(maxAbs(got, exp)).toBe(0);
    for (const c of cases) {
      expect(Number.isFinite(got[c.at])).toBe(true);
    }

    // Short clean: tail stays in the residual, still sanitized.
    const short = clean.subarray(0, 20).slice();
    short[4] = NaN;
    const longIn = input.slice();
    longIn[25] = Infinity;
    got = w.__residual([longIn], [short])[0];
    exp = legacyResidual([longIn], [short])[0];
    expect(got.length).toBe(N);
    expect(maxAbs(got, exp)).toBe(0);
  });

  test('overlap-add normalize matches main sanitize, including NaN/Inf and silent norm', () => {
    const N = 16;
    const out = new Float32Array(N).fill(0.4);
    const norm = new Float32Array(N).fill(1);
    const samples = new Float32Array(N).fill(0.25);
    const finite = w.__normalize(out.slice(), norm, samples);
    expect(maxAbs(finite, legacyNormalize(out, norm, samples))).toBe(0);

    const dirtyOut = out.slice();
    dirtyOut[1] = NaN;
    dirtyOut[2] = Infinity;
    dirtyOut[3] = -Infinity;
    const dirtyNorm = norm.slice();
    dirtyNorm[4] = 0;
    dirtyNorm[5] = NaN;
    const dirtySamples = samples.slice();
    dirtySamples[2] = NaN;
    dirtySamples[3] = 0.9;
    const got = w.__normalize(dirtyOut.slice(), dirtyNorm, dirtySamples);
    const exp = legacyNormalize(dirtyOut, dirtyNorm, dirtySamples);
    expect(maxAbs(got, exp)).toBe(0);
    expect(Number.isFinite(got[1])).toBe(true);
    expect(got[2]).toBe(0); // sample fallback is NaN → 0
    expect(got[3]).toBe(dirtySamples[3]);
  });
});

describe('HfPostFilter identical to main (always-log10) on a fixture set', () => {
  const neu = loadHf(path.join(ROOT, 'src/workers/HfPostFilter.js'));
  const old = loadHf(path.join(FIX, 'HfPostFilter.main.js'));
  const GEOM = { fftSize: 4096, hop: 1024, bins: 2049, sampleRate: SR };

  test('sppFromRatio matches smoothStep(10·log10) including the 7–14 dB edges', () => {
    const spp = neu.VipHfPostFilter.sppFromRatio;
    expect(typeof spp).toBe('function');
    const ratios = [];
    for (let db = -80; db <= 80; db += 0.25) ratios.push(10 ** (db / 10));
    for (const edge of [7, 14, 7 - 1e-9, 7 + 1e-9, 14 - 1e-9, 14 + 1e-9, 6, 6.999, 14.001]) {
      ratios.push(10 ** (edge / 10));
    }
    ratios.push(0, 1e-12, 1e-20, 1e20, Number.MIN_VALUE, 5.011872336272725 /* 7 dB */, 25.118864315095795 /* 14 dB */);
    let m = 0;
    for (const r of ratios) {
      const got = spp(r);
      const exp = smoothStep(10 * Math.log10(r), 7, 14);
      m = Math.max(m, Math.abs(got - exp) || 0);
      if (!(r > 0) && r !== 0) continue;
    }
    // +0 ratio: log10(0) is -Inf, smoothStep returns 0; early-out also 0.
    expect(spp(0)).toBe(0);
    expect(m).toBe(0);
  });

  test('applyFrame matches origin/main on speech-like, noisy, and onset frames', () => {
    const a = neu.createHfPostFilter(GEOM);
    const b = old.createHfPostFilter(GEOM);
    const bins = GEOM.bins;
    const frames = [];
    // Speech-like harmonics + noise, then a sudden onset, then quiet.
    for (let f = 0; f < 24; f++) {
      const re = new Float32Array(bins);
      const im = new Float32Array(bins);
      const mags = new Float32Array(bins);
      const mask = new Float32Array(bins);
      const onset = f === 8;
      const quiet = f > 16;
      for (let k = 0; k < bins; k++) {
        const hz = k * (SR / GEOM.fftSize);
        const harm = [200, 400, 800, 1600, 3200, 6400, 8000, 10000].some((h) => Math.abs(hz - h) < 20) ? 1 : 0;
        const amp = quiet ? 1e-5 : (onset ? 4 : 0.4) * (0.2 + harm);
        const ph = (k * 0.17 + f * 0.3);
        re[k] = amp * Math.cos(ph);
        im[k] = amp * Math.sin(ph);
        mags[k] = Math.hypot(re[k], im[k]);
        mask[k] = quiet ? 0.1 : harm ? 0.95 : 0.4;
      }
      frames.push({ re, im, mags, mask });
    }
    let m = 0;
    for (const fr of frames) {
      const reA = fr.re.slice();
      const imA = fr.im.slice();
      const reB = fr.re.slice();
      const imB = fr.im.slice();
      a.applyFrame(reA, imA, fr.mags, 0, fr.mask);
      b.applyFrame(reB, imB, fr.mags, 0, fr.mask);
      m = Math.max(m, maxAbs(reA, reB), maxAbs(imA, imB));
    }
    expect(m).toBe(0);
  });
});

describe('landing / enhance / engineer identity on corpus fixtures', () => {
  let worker;
  let engineerConfig;
  let PC;

  beforeAll(async () => {
    const { createMlWorker } = require(path.join(ROOT, 'scripts/quality/lib/mlworker-node.cjs'));
    engineerConfig = require(path.join(ROOT, 'scripts/quality/lib/engineer-config.cjs')).engineerConfig;
    PC = await import(path.join(ROOT, 'src/core/PresetCalibration.js'));
    worker = await createMlWorker();
  });

  async function presetConfig(name) {
    const vals = {};
    for (const [k, v] of Object.entries(PC.CALIBRATED_ENGINEER_PRESETS[name])) {
      if (typeof v === 'number') vals[k] = v;
    }
    return engineerConfig(vals);
  }

  function loadPair(fid, pid) {
    const input = readF32(path.join(FIX, `${fid}.in.f32`));
    const clean = readF32(path.join(FIX, `${fid}.${pid}.clean.f32`));
    const noise = readF32(path.join(FIX, `${fid}.${pid}.noise.f32`));
    return { input, clean, noise };
  }

  const FILES = ['librispeech-clean-001', 'syn-whisper-white-10db'];

  for (const fid of FILES) {
    test(`landing is bit-identical (max abs 0) on ${fid}`, async () => {
      const { input, clean, noise } = loadPair(fid, 'landing');
      const res = await worker.separate([input], { modelIds: ['bsrnn_vocals'], processingConfig: null });
      expect(maxAbs(res.clean[0], clean)).toBe(0);
      expect(maxAbs(res.noise[0], noise)).toBe(0);
    });

    test(`enhance is bit-identical (max abs 0) on ${fid}`, async () => {
      const { input, clean, noise } = loadPair(fid, 'enhance');
      const res = await worker.separate([input], { modelIds: ['deepfilternet3'], processingConfig: null });
      expect(maxAbs(res.clean[0], clean)).toBe(0);
      expect(maxAbs(res.noise[0], noise)).toBe(0);
    });
  }

  for (const name of ['Whisper Boost', 'Surveillance']) {
    const pid = name.replace(/ /g, '-');
    for (const fid of FILES) {
      test(`${name} is bit-identical (max abs 0) on ${fid}`, async () => {
        const { input, clean, noise } = loadPair(fid, pid);
        const processingConfig = await presetConfig(name);
        const res = await worker.separate([input], { modelIds: ['bsrnn_vocals'], processingConfig });
        const mc = maxAbs(res.clean[0], clean);
        const mn = maxAbs(res.noise[0], noise);
        expect(mc).toBe(0);
        expect(mn).toBe(0);
      });
    }
  }
});
