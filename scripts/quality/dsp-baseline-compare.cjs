/**
 * Before/after measurements for the DSP fixes on fix/processing-remediation.
 *
 * Baseline is git a320eb7f (main before those commits). The candidate is the
 * working tree. Inputs are synthetic. Where a ground-truth stem does not
 * exist, the report says so and does not emit an SDR claim.
 *
 *   node --experimental-vm-modules scripts/quality/dsp-baseline-compare.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');
const { siSdr, sdr, rmsDb, peak, nonFinite, dcOffset } = require('./lib/metrics.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const BASELINE = 'a320eb7f67b46e53d3f6b75669230bda93108fbf';
const SR = 48000;
const FADE = Math.round(0.008 * SR);
const GEOMETRY = Object.freeze({ fftSize: 4096, hop: 1024, bins: 2049, sampleRate: SR });
const BIN_HZ = SR / GEOMETRY.fftSize;
const SINE_GAIN = GEOMETRY.fftSize / 4;
const NOISE_GAIN = Math.sqrt(3 * GEOMETRY.fftSize / 8);

const ENTRY = {
  id: 'unit-mask',
  fftSize: 4096,
  hopSize: 1024,
  bins: 2049,
  sampleRate: SR,
  io: { input: 'in', output: 'out' },
  inputNormalization: 'frame-max',
  maskExponent: 0.5,
};

function gitShow(rev, file) {
  return execFileSync('git', ['show', `${rev}:${file}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function loadSpectral(source) {
  const self = {};
  vm.runInNewContext(source, { self, globalThis: self, Float32Array, Math, Number, Object });
  return self;
}

function loadWorker(source) {
  class Tensor {
    constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
  }
  const self = { navigator: { hardwareConcurrency: 8, userAgent: 'node-test X11' }, postMessage() {} };
  const sandbox = {
    self,
    ort: { Tensor, env: { wasm: {} } },
    console: { log() {}, warn() {}, info() {}, debug() {}, error() {} },
    performance, setTimeout, clearTimeout, Promise, Math, Object, Array, Set, Map, Error,
    Number, String, JSON, Symbol,
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
  vm.runInContext(
    `${source}\nself.__fused = runFusedSpectralMaskChain; self.__residual = residual;`,
    sandbox,
  );
  return self;
}

function sessionReturning(value) {
  return {
    async run(feeds) {
      return { out: { data: new Float32Array(feeds.in.data.length).fill(value) } };
    },
  };
}

function tones(len) {
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR)
      + 0.2 * Math.sin((2 * Math.PI * 1234.5 * i) / SR);
  }
  return x;
}

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function synthFrames({ frames = 2, speechDb = -18, noiseDb = -36, seed = 3 } = {}) {
  const rand = prng(seed);
  const amp = 10 ** (speechDb / 20) * SINE_GAIN;
  const out = [];
  for (let f = 0; f < frames; f++) {
    const sigma = 10 ** (noiseDb / 20) * NOISE_GAIN;
    const f0 = 140 + 40 * Math.sin(f / 9);
    const re = new Float32Array(GEOMETRY.bins);
    const im = new Float32Array(GEOMETRY.bins);
    const source = new Float32Array(GEOMETRY.bins);
    for (let k = 0; k < GEOMETRY.bins; k++) {
      const nr = (rand() + rand() + rand() + rand() - 2) * 0.8165 * sigma / Math.SQRT2;
      const ni = (rand() + rand() + rand() + rand() - 2) * 0.8165 * sigma / Math.SQRT2;
      const hz = k * BIN_HZ;
      const h = hz / f0;
      const near = Math.abs(h - Math.round(h));
      const harmonic = near < 0.25 && hz < 5000 ? Math.exp(-near * near * 40) * Math.exp(-hz / 2500) : 0;
      const fricative = hz > 4000 && hz < 9000 ? 0.15 : 0;
      const mag = amp * (harmonic + fricative) * (0.3 + 0.7 * rand());
      const phase = rand() * 2 * Math.PI;
      const sr = mag * Math.cos(phase);
      const si = mag * Math.sin(phase);
      source[k] = Math.hypot(sr + nr, si + ni);
      re[k] = sr + 0.3 * nr;
      im[k] = si + 0.3 * ni;
    }
    out.push({ re, im, source });
  }
  return out;
}

function bandEnergy(frame, from, to) {
  let e = 0;
  for (let k = from; k < to; k++) e += frame.re[k] ** 2 + frame.im[k] ** 2;
  return e;
}

function bandDiffDb(a, b, from, to) {
  let num = 0;
  let den = 0;
  for (let k = from; k < to; k++) {
    const ma = Math.hypot(a.re[k], a.im[k]);
    const mb = Math.hypot(b.re[k], b.im[k]);
    num += (ma - mb) ** 2;
    den += ma * ma;
  }
  return 10 * Math.log10(num / Math.max(den, 1e-30));
}

function signalStats(x) {
  const bad = nonFinite(x);
  if (bad > 0) {
    return { samples: x.length, nonFinite: bad, peak: null, rmsDbFs: null, dc: null };
  }
  return {
    samples: x.length,
    nonFinite: 0,
    peak: Number(peak(x).toFixed(6)),
    rmsDbFs: Number(rmsDb(x).toFixed(3)),
    dc: Number(dcOffset(x).toFixed(8)),
  };
}

function finiteMetrics(est, ref) {
  if (nonFinite(est) || nonFinite(ref)) {
    return { siSdrDb: null, sdrDb: null, reason: 'undefined because a signal is non-finite' };
  }
  const slice = (v) => v.subarray(FADE, v.length - FADE);
  const e = slice(est);
  const r = slice(ref);
  return {
    siSdrDb: Number(siSdr(e, r).toFixed(3)),
    sdrDb: Number(sdr(e, r).toFixed(3)),
    reason: 'synthetic reference is the input tone, not a ground-truth stem',
  };
}

function median(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function timeCalls(fn, n = 5) {
  await fn();
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return Number(median(samples).toFixed(3));
}

function formantCase(helper, Schema, frames) {
  const base = {
    nrAmount: 0, nrSpectralSub: 0, whisperMode: 0, whisperLift: 0,
    breathControl: 0, derevAmt: 0, roomCorrection: 0, reverbStrip: 0,
    musicKill: 0, crowdNull: 0, bassCrush: 0, voiceTunnel: 0,
    harmRecov: 0, transientShaper: 0, subHarmonic: 0, formantShift: 0,
  };
  const run = (values) => {
    const config = Schema.buildMlProcessingConfig(values);
    const processor = helper.createEngineerFrameProcessor(config, GEOMETRY);
    const frame = frames[0];
    const re = new Float32Array(frame.re);
    const im = new Float32Array(frame.im);
    processor.applyFrame(re, im, frame.source, 0, false);
    return { re, im, revision: config.revision };
  };
  const flat = run(base);
  const down = run({ ...base, formantShift: -12 });
  const upperOriginal = bandEnergy(flat, 1025, GEOMETRY.bins);
  const upperKept = bandEnergy(down, 1025, GEOMETRY.bins);
  return {
    configuration: { ...base, formantShift: -12, geometry: GEOMETRY },
    revision: down.revision,
    upperEnergyRatio: upperKept / Math.max(upperOriginal, 1e-30),
    lowerEnvelopeChangeDb: bandDiffDb(flat, down, 1, 1025),
    upperOriginalEnergy: upperOriginal,
    upperShiftedEnergy: upperKept,
  };
}

async function maskCase(worker, maskValue, input) {
  const run = () => worker.__fused(
    [{ entry: ENTRY, session: sessionReturning(maskValue) }],
    input, () => {}, null, SR, null,
  );
  const output = await run();
  return {
    input: signalStats(input),
    output: signalStats(output),
    versusInput: finiteMetrics(output, input),
    peakRatio: peak(output) / Math.max(peak(input), 1e-30),
    durationMs: await timeCalls(run),
    outputSamples: output,
  };
}

function round(n, digits = 6) {
  if (!Number.isFinite(n)) return n;
  return Number(n.toFixed(digits));
}

async function compare() {
  const Schema = await import(pathToFileURL(path.join(ROOT, 'src/core/ParameterSchema.js')).href);
  const baselineSpectral = loadSpectral(gitShow(BASELINE, 'src/workers/EngineerSpectralControls.js'));
  const currentSpectral = loadSpectral(fs.readFileSync(path.join(ROOT, 'src/workers/EngineerSpectralControls.js'), 'utf8'));
  const frames = synthFrames();
  const formantBaseline = formantCase(baselineSpectral, Schema, frames);
  const formantCurrent = formantCase(currentSpectral, Schema, frames);

  const baselineWorker = loadWorker(gitShow(BASELINE, 'src/workers/MLWorker.js'));
  const currentWorker = loadWorker(fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8'));
  const tone = tones(SR);
  const nanBaseline = await maskCase(baselineWorker, NaN, tone);
  const nanCurrent = await maskCase(currentWorker, NaN, tone);
  const ampBaseline = await maskCase(baselineWorker, 4, tone);
  const ampCurrent = await maskCase(currentWorker, 4, tone);
  const unityBaseline = await maskCase(baselineWorker, 1, tone);
  const unityCurrent = await maskCase(currentWorker, 1, tone);

  const input = Float32Array.of(0.5, -0.25, 0.125, 0.0625);
  const clean = Float32Array.of(0.5, NaN);
  const residualOf = (worker) => Array.from(worker.__residual([input], [clean])[0]);
  const residualBaseline = residualOf(baselineWorker);
  const residualCurrent = residualOf(currentWorker);
  const showSample = (v) => (Number.isFinite(v) ? v : 'NaN');

  const strip = (mask) => {
    const copy = { ...mask };
    delete copy.outputSamples;
    copy.peakRatio = round(copy.peakRatio, 6);
    return copy;
  };

  return {
    baselineCommit: BASELINE,
    candidate: 'working tree',
    note: 'No ground-truth isolated stems. SDR figures are proxies against the synthetic input and are omitted when a buffer is non-finite.',
    operations: {
      formantShiftDown12: {
        kind: 'proxy: upper-bin energy versus the same processor at formantShift 0. Not SI-SDR.',
        baseline: {
          upperEnergyRatio: round(formantBaseline.upperEnergyRatio, 6),
          lowerEnvelopeChangeDb: round(formantBaseline.lowerEnvelopeChangeDb, 3),
        },
        candidate: {
          upperEnergyRatio: round(formantCurrent.upperEnergyRatio, 6),
          lowerEnvelopeChangeDb: round(formantCurrent.lowerEnvelopeChangeDb, 3),
        },
      },
      nonFiniteMask: {
        kind: 'synthetic tones. Reference for a finite result is the input, because a non-finite mask is not a separation decision.',
        baseline: strip(nanBaseline),
        candidate: strip(nanCurrent),
      },
      maskAboveOne: {
        kind: 'synthetic tones. A mask of 4 is outside the sigmoid contract. Reference is the input.',
        baseline: strip(ampBaseline),
        candidate: strip(ampCurrent),
      },
      shortCleanResidual: {
        kind: 'exact samples. No SDR. Input [0.5, -0.25, 0.125, 0.0625], clean [0.5, NaN].',
        baseline: residualBaseline.map(showSample),
        candidate: residualCurrent.map(showSample),
        baselineNonFinite: residualBaseline.filter((v) => !Number.isFinite(v)).length,
        candidateNonFinite: residualCurrent.filter((v) => !Number.isFinite(v)).length,
      },
      unityMaskControl: {
        kind: 'reconstruction guard. Reference is the input. This is not a separation-quality score.',
        baseline: strip(unityBaseline),
        candidate: strip(unityCurrent),
      },
    },
  };
}

function verdict(report) {
  const f = report.operations.formantShiftDown12;
  const n = report.operations.nonFiniteMask;
  const a = report.operations.maskAboveOne;
  const r = report.operations.shortCleanResidual;
  const u = report.operations.unityMaskControl;
  return {
    formantDefectEliminated: f.baseline.upperEnergyRatio < 0.05 && f.candidate.upperEnergyRatio > 0.9,
    formantControlStillMovesLowerSpectrum: f.candidate.lowerEnvelopeChangeDb > -40,
    nonFiniteMaskNoLongerPoisons: n.baseline.output.nonFinite > 0 && n.candidate.output.nonFinite === 0,
    nonFiniteMaskPreservesInput: n.candidate.versusInput.sdrDb > 60,
    overrangeMaskNoLongerAmplifies: a.baseline.peakRatio > 1.5 && a.candidate.peakRatio > 0.99 && a.candidate.peakRatio < 1.01,
    residualNaNEliminated: r.baselineNonFinite > 0 && r.candidateNonFinite === 0,
    unityReconstructionHeld: u.baseline.versusInput.sdrDb > 60 && u.candidate.versusInput.sdrDb > 60,
    noiseReduction: 'unverified — these diffs do not change a noise estimator',
    perceptual: 'unverified — no listening test was run',
    performance: 'vm harness only. Production worker JIT and on-device timing were not measured.',
  };
}

async function main() {
  const report = await compare();
  const judged = verdict(report);
  const out = { ...report, verdict: judged };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  return out;
}

module.exports = { compare, verdict, BASELINE };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
