/**
 * Mask-aware HF post-filter (src/workers/HfPostFilter.js) inside the fused
 * STFT chain: it must leave a unity / confident mask bit-identical, keep the
 * band below 7 kHz untouched, cut stationary HF noise under an uncertain
 * mask, pass HF bursts well above the tracked noise floor, and not leave
 * isolated pass-through bins (musical noise).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { siSdr, sdr, bandEnergyDb } = require('../scripts/quality/lib/metrics.cjs');

const ROOT = path.join(__dirname, '..');
const SR = 48000;
const IMPORT = "importScripts('/src/workers/HfPostFilter.js');";

function loadWorker({ withFilter = true } = {}) {
  class Tensor {
    constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
  }
  const self = { navigator: { hardwareConcurrency: 8, userAgent: 'node-test X11' }, postMessage() {} };
  const sandbox = {
    self,
    ort: { Tensor, env: { wasm: {} } },
    console: { log() {}, warn() {}, info() {}, debug() {}, error() {} },
    performance, setTimeout, clearTimeout, Promise, Math, Object, Array, Set, Map, Error, Number, String, JSON, Symbol,
    Float32Array, Float64Array, Uint32Array, Uint8Array, Int16Array,
    importScripts(...urls) {
      for (const u of urls) {
        if (/ort(\.min)?\.js$/.test(u)) continue;
        const file = path.join(ROOT, u.replace(/^\//, ''));
        vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
      }
    },
  };
  vm.createContext(sandbox);
  let code = fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8');
  expect(code).toContain(IMPORT);
  if (!withFilter) code = code.replace(IMPORT, '');
  code += '\nself.__fused = runFusedSpectralMaskChain; self.__stft = getStftCounters; self.__resetStft = resetStftCounters;';
  vm.runInContext(code, sandbox);
  return self;
}

const ENTRY = {
  id: 'unit-mask', fftSize: 4096, hopSize: 1024, bins: 2049, sampleRate: SR,
  io: { input: 'in', output: 'out' }, inputNormalization: 'frame-max', maskExponent: 0.5,
};
// maskExponent 0.5: a model output v gives a fused mask sqrt(v).
const session = (v) => ({ async run(feeds) { return { out: { data: new Float32Array(feeds.in.data.length).fill(v) } }; } });

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
function white(len, amp, seed) {
  const r = rng(seed); const x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = amp * (r() * 2 - 1);
  return x;
}
function tone(len, f, a = 0.5) {
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = a * Math.sin((2 * Math.PI * f * i) / SR);
  return x;
}
const dbBand = (x, lo, hi, from = 0, to = x.length) => bandEnergyDb(x.subarray(from, to), lo, hi, SR, 2048);

const on = loadWorker();
const off = loadWorker({ withFilter: false });
const run = (w, x, v) => w.__fused([{ entry: ENTRY, session: session(v) }], x, () => {}, null, SR, null);

describe('HF post-filter: confident masks are untouched', () => {
  test.each([12000, 16000])('unity mask keeps a %i Hz tone (SDR > 130 dB, identical to no filter)', async (f) => {
    const x = tone(SR, f);
    const y = await run(on, x, 1);
    const z = await run(off, x, 1);
    expect(sdr(y, x)).toBeGreaterThan(130);
    expect(siSdr(y, x)).toBeGreaterThan(130);
    for (let i = 0; i < y.length; i++) if (y[i] !== z[i]) throw new Error(`sample ${i} differs`);
  });

  test.each([1, 0.995 * 0.995])('mask %f keeps broadband 16-24 kHz content within 0.01 dB', async (v) => {
    const x = white(2 * SR, 0.1, 7);
    const y = await run(on, x, v);
    const z = await run(off, x, v);
    expect(Math.abs(dbBand(y, 16000, 24000) - dbBand(z, 16000, 24000))).toBeLessThan(0.01);
    expect(Math.abs(dbBand(y, 8000, 16000) - dbBand(z, 8000, 16000))).toBeLessThan(0.01);
  });

  test('one forward and one inverse STFT per pass', async () => {
    on.__resetStft();
    await run(on, white(SR, 0.1, 3), 0.64);
    expect(on.__stft()).toEqual({ forward: 1, inverse: 1 });
  });
});

describe('HF post-filter: uncertain mask (fused 0.8)', () => {
  const V = 0.64;
  test('stationary HF noise is cut >= 10 dB above 9 kHz; below 7 kHz is unchanged', async () => {
    const x = white(4 * SR, 0.03, 11);
    const y = await run(on, x, V);
    const z = await run(off, x, V);
    const from = SR; // after the warm-up
    expect(dbBand(z, 10000, 24000, from) - dbBand(y, 10000, 24000, from)).toBeGreaterThan(10);
    expect(Math.abs(dbBand(z, 100, 6500, from) - dbBand(y, 100, 6500, from))).toBeLessThan(0.05);
  });

  test('HF bursts 20 dB above the noise floor keep their level (within 1.5 dB)', async () => {
    const len = 5 * SR;
    const x = white(len, 0.003, 5);
    const b = white(len, 0.03, 9);
    const burst = [];
    for (let t = 1.5; t < 4.6; t += 0.5) {
      const s = Math.round(t * SR); const e = s + Math.round(0.12 * SR);
      for (let i = s; i < e; i++) x[i] += b[i];
      burst.push([s, e]);
    }
    const y = await run(on, x, V);
    const z = await run(off, x, V);
    for (const [s, e] of burst) {
      expect(dbBand(z, 9000, 24000, s, e) - dbBand(y, 9000, 24000, s, e)).toBeLessThan(1.5);
    }
  });

  test('opening on HF content is not treated as noise during warm-up', async () => {
    const x = white(2 * SR, 0.03, 13);
    const y = await run(on, x, V);
    const z = await run(off, x, V);
    // First 100 ms: the depth ramps in over ~0.75 s, so < 1.5 dB cut.
    expect(dbBand(z, 9000, 24000, 0, 4800) - dbBand(y, 9000, 24000, 0, 4800)).toBeLessThan(1.5);
  });
});

describe('HF post-filter gain field (module level, no musical noise)', () => {
  function frames(maskValue, count = 300, bins = 2049) {
    const scope = {};
    vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'src/workers/HfPostFilter.js'), 'utf8'), { self: scope, Math, Float32Array, Float64Array, Uint8Array, Object });
    const f = scope.createHfPostFilter({ fftSize: 4096, hop: 1024, bins, sampleRate: SR });
    const r = rng(21);
    const gains = [];
    const mask = new Float32Array(bins).fill(maskValue);
    for (let t = 0; t < count; t++) {
      const re = new Float32Array(bins); const im = new Float32Array(bins); const mags = new Float32Array(bins);
      for (let k = 0; k < bins; k++) {
        // Complex Gaussian noise (Box-Muller), unit power per bin.
        const u = Math.max(1e-12, r()); const ph = 2 * Math.PI * r();
        const m = Math.sqrt(-Math.log(u));
        re[k] = m * Math.cos(ph); im[k] = m * Math.sin(ph); mags[k] = m;
      }
      const r0 = Float32Array.from(re);
      f.applyFrame(re, im, mags, 0, mask);
      gains.push(Float32Array.from(re, (v, k) => (r0[k] === 0 ? 1 : v / r0[k])));
    }
    return { gains, k0: f.firstBin };
  }

  test('unity mask leaves every gain at exactly 1', () => {
    const { gains } = frames(1, 60);
    for (const g of gains) for (const v of g) expect(v).toBe(1);
  });

  test('stationary noise: few isolated peaks and little frame-to-frame flutter', () => {
    const { gains } = frames(0.8);
    const k9 = Math.ceil(9500 / (SR / 4096));
    let peaks = 0; let cells = 0; let flutter = 0; let fc = 0;
    for (let t = 100; t < gains.length; t++) {
      const g = gains[t]; const p = gains[t - 1];
      for (let k = k9 + 1; k < g.length - 1; k++) {
        cells++;
        // An isolated pass-through bin: 6 dB above both neighbours.
        if (g[k] > 2 * g[k - 1] && g[k] > 2 * g[k + 1]) peaks++;
        flutter += Math.abs(20 * Math.log10(g[k] / p[k])); fc++;
      }
    }
    expect(peaks / cells).toBeLessThan(0.002);
    expect(flutter / fc).toBeLessThan(1.5); // mean |delta gain| per frame, dB
  });
});
