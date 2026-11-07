/**
 * Bandlimited resampling (Kaiser windowed-sinc).
 *
 * The long-file path used to be linear interpolation. These checks are the
 * gate from the resample audit: alias rejection, passband flatness, chunk
 * continuity, and agreement with scipy.signal.resample_poly.
 *
 * scipy is invoked as `python3` (measured with scipy 1.18.1). The comparison
 * is scale-invariant SDR on the middle 80% of a 2 s speech-like signal,
 * lag-checked, with resample_poly's default window ('kaiser', 5.0).
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

jest.setTimeout(120000);

const ROOT = path.join(__dirname, '..');

let core;
let windows;
let chunked;
let budget;

beforeAll(async () => {
  core = await import('../src/core/BandlimitedResampler.js');
  windows = await import('../src/pipeline/resample-window.js');
  chunked = await import('../src/pipeline/ChunkedExtraction.js');
  budget = await import('../src/core/IngestionBudget.js');
});

function goertzel(x, freq, sampleRate) {
  const n = x.length;
  const w = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const real = s1 - s2 * Math.cos(w);
  const imag = s2 * Math.sin(w);
  return (Math.hypot(real, imag) * 2) / n;
}

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}

function db(amplitude) {
  return 20 * Math.log10(amplitude + 1e-20);
}

function tone(sampleRate, freq, n, amp = 1) {
  const x = new Float32Array(n);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(w * i);
  return x;
}

/** Steady-state slice whose length is an integer number of cycles. */
function steady(x, sampleRate, freq) {
  const start = Math.round(sampleRate * 0.15);
  const cycles = Math.max(1, Math.round((sampleRate * 0.6) / (sampleRate / freq)));
  const n = Math.round(cycles * (sampleRate / freq));
  return x.subarray(start, start + n);
}

function legacyLinear(samples, fromRate, toRate) {
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

function siSdr(reference, estimate) {
  const n = Math.min(reference.length, estimate.length);
  let dot = 0;
  let rr = 0;
  for (let i = 0; i < n; i++) {
    dot += estimate[i] * reference[i];
    rr += reference[i] * reference[i];
  }
  if (rr === 0) return -Infinity;
  const scale = dot / rr;
  let noise = 0;
  let signal = 0;
  for (let i = 0; i < n; i++) {
    const s = scale * reference[i];
    const err = estimate[i] - s;
    noise += err * err;
    signal += s * s;
  }
  if (noise === 0) return Infinity;
  return 10 * Math.log10(signal / noise);
}

function chunkedResample(samples, fromRate, toRate, chunk) {
  const one = core.resampleMono(samples, fromRate, toRate);
  const out = new Float32Array(one.length);
  for (let start = 0; start < one.length; start += chunk) {
    const frames = Math.min(chunk, one.length - start);
    const span = core.sourceSpan(start, frames, fromRate, toRate);
    const srcStart = Math.max(0, span.srcStart);
    const srcEnd = Math.min(samples.length, span.srcEnd);
    const slice = samples.subarray(srcStart, srcEnd);
    out.set(core.resampleWindow([slice], srcStart, fromRate, start, frames, toRate)[0], start);
  }
  return { one, out };
}

/** Voiced pulse train through three parallel formant resonators. Deterministic. */
function speechLike(n, sampleRate) {
  const x = new Float32Array(n);
  const period = Math.round(sampleRate / 124);
  const resonator = (freq, bw) => {
    const r = Math.exp((-Math.PI * bw) / sampleRate);
    const theta = (2 * Math.PI * freq) / sampleRate;
    return { a1: 2 * r * Math.cos(theta), a2: -(r * r), z1: 0, z2: 0 };
  };
  const formants = [resonator(700, 80), resonator(1220, 90), resonator(2600, 140)];
  let noise = 12345;
  for (let i = 0; i < n; i++) {
    const pulse = (i % period) === 0 ? 0.8 : 0;
    noise = (Math.imul(noise, 1103515245) + 12345) & 0x7fffffff;
    const breath = (noise / 0x7fffffff - 0.5) * 0.03;
    const excitation = pulse + breath;
    let mixed = 0;
    for (const f of formants) {
      const y = excitation + f.a1 * f.z1 + f.a2 * f.z2;
      f.z2 = f.z1;
      f.z1 = y;
      mixed += y;
    }
    x[i] = mixed;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(x[i]));
  const gain = peak > 0 ? 0.5 / peak : 1;
  for (let i = 0; i < n; i++) x[i] *= gain;
  return x;
}

function logMeasure(tag, value) {
  const text = JSON.stringify(value, (_key, item) => (item === Infinity ? 'Infinity' : item));
  console.log(`[${tag}] ${text}`);
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

test('alias rejection, passband flatness, and the linear-interpolation baseline', () => {
  const high = tone(96000, 30000, 96000);
  const folded = core.resampleMono(high, 96000, 48000);
  const foldedLegacy = legacyLinear(high, 96000, 48000);
  const foldedSlice = steady(folded, 48000, 18000);
  const legacySlice = steady(foldedLegacy, 48000, 18000);
  const aliasAmp = goertzel(foldedSlice, 18000, 48000);
  const aliasDb = db(aliasAmp);
  const aliasRmsDb = db(rms(foldedSlice));
  const legacyAliasAmp = goertzel(legacySlice, 18000, 48000);

  const mid = tone(44100, 18000, 44100);
  const up = core.resampleMono(mid, 44100, 48000);
  const upLegacy = legacyLinear(mid, 44100, 48000);
  const inAmp = goertzel(steady(mid, 44100, 18000), 18000, 44100);
  const outAmp = goertzel(steady(up, 48000, 18000), 18000, 48000);
  const legacyOutAmp = goertzel(steady(upLegacy, 48000, 18000), 18000, 48000);
  const gainErrorDb = db(outAmp) - db(inAmp);
  const legacyGainErrorDb = db(legacyOutAmp) - db(inAmp);

  const probeHz = [100, 1000, 4000, 8000, 12000, 15000, 16000, 17000, 18000];
  const gains = probeHz.map((freq) => {
    const input = tone(44100, freq, 44100);
    const output = core.resampleMono(input, 44100, 48000);
    const a = goertzel(steady(input, 44100, freq), freq, 44100);
    const b = goertzel(steady(output, 48000, freq), freq, 48000);
    return db(b) - db(a);
  });
  const rippleDb = Math.max(...gains) - Math.min(...gains);
  const maxAbsGainDb = Math.max(...gains.map((g) => Math.abs(g)));

  const down = core.resampleMono(tone(48000, 20000, 48000), 48000, 16000);
  const downLegacy = legacyLinear(tone(48000, 20000, 48000), 48000, 16000);
  const downSlice = steady(down, 16000, 4000);
  const downAliasDb = db(goertzel(downSlice, 4000, 16000));
  const legacyDownAlias = goertzel(steady(downLegacy, 16000, 4000), 4000, 16000);

  const metrics = {
    legacy96to48AliasAmplitudeAt18kHz: legacyAliasAmp,
    legacy44to48GainErrorDbAt18kHz: legacyGainErrorDb,
    legacy48to16AliasAmplitudeAt4kHz: legacyDownAlias,
    alias96to48At18kHzDb: aliasDb,
    alias96to48RmsDb: aliasRmsDb,
    gainError44to48At18kHzDb: gainErrorDb,
    passbandRipple44to48Db: rippleDb,
    passbandMaxAbsGainDb: maxAbsGainDb,
    passbandGainsDb: Object.fromEntries(probeHz.map((f, i) => [f, gains[i]])),
    alias48to16At4kHzDb: downAliasDb,
    kernelRadius96to48: core.kernelRadius(96000, 48000),
    kernelRadius44to48: core.kernelRadius(44100, 48000),
  };
  logMeasure('resample-metrics', metrics);

  expect(legacyAliasAmp).toBeGreaterThan(0.9);
  expect(legacyGainErrorDb).toBeLessThan(-4);
  expect(aliasDb).toBeLessThan(-80);
  expect(aliasRmsDb).toBeLessThan(-80);
  expect(Math.abs(gainErrorDb)).toBeLessThan(0.2);
  expect(rippleDb).toBeLessThan(0.2);
  expect(downAliasDb).toBeLessThan(-80);
});

test('chunked windows match a one-shot resample', () => {
  const cases = [
    { from: 96000, to: 48000, n: 50000, chunk: 777 },
    { from: 44100, to: 48000, n: 44100, chunk: 1024 },
    { from: 48000, to: 16000, n: 48000, chunk: 3000 },
  ];
  const reported = [];
  for (const c of cases) {
    const x = new Float32Array(c.n);
    for (let i = 0; i < c.n; i++) {
      x[i] = 0.4 * Math.sin(i * 0.013) + 0.25 * Math.sin(i * 0.157 + 0.4) + ((i % 97) - 48) / 480;
    }
    const { one, out } = chunkedResample(x, c.from, c.to, c.chunk);
    let maxAbs = 0;
    for (let i = 0; i < one.length; i++) maxAbs = Math.max(maxAbs, Math.abs(one[i] - out[i]));
    const score = siSdr(one, out);
    reported.push({ ...c, maxAbs, siSdrDb: score });
    expect(score).toBeGreaterThan(60);
  }

  const overlapFrom = 44100;
  const overlapTo = 48000;
  const signal = speechLike(22050, overlapFrom);
  const spanA = core.sourceSpan(1000, 4000, overlapFrom, overlapTo);
  const spanB = core.sourceSpan(3000, 4000, overlapFrom, overlapTo);
  const sliceOf = (span) => {
    const srcStart = Math.max(0, span.srcStart);
    const srcEnd = Math.min(signal.length, span.srcEnd);
    return { srcStart, slice: signal.subarray(srcStart, srcEnd) };
  };
  const a = sliceOf(spanA);
  const b = sliceOf(spanB);
  const winA = core.resampleWindow([a.slice], a.srcStart, overlapFrom, 1000, 4000, overlapTo)[0];
  const winB = core.resampleWindow([b.slice], b.srcStart, overlapFrom, 3000, 4000, overlapTo)[0];
  let overlapMax = 0;
  for (let i = 0; i < 2000; i++) overlapMax = Math.max(overlapMax, Math.abs(winA[2000 + i] - winB[i]));
  reported.push({ overlapMaxAbs: overlapMax });
  logMeasure('resample-chunks', reported);
  expect(overlapMax).toBe(0);
});

test('a 96 kHz WAV read in canonical windows matches one resample of the file', async () => {
  const srcRate = 96000;
  const srcFrames = 24000;
  const pcm = new Int16Array(srcFrames);
  for (let i = 0; i < srcFrames; i++) {
    const s = 0.6 * Math.sin((2 * Math.PI * 1000 * i) / srcRate) + 0.2 * Math.sin((2 * Math.PI * 7000 * i) / srcRate);
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round(s * 32767)));
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(srcRate, 24);
  header.writeUInt32LE(srcRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.byteLength, 40);
  const body = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const file = new Blob([header, body], { type: 'audio/wav' });
  const meta = budget.parseWavMetadata(header);
  const plan = { wav: meta, outputChannels: 1 };
  const decoded = chunked.decodeInterleavedPcm(new DataView(body.buffer, body.byteOffset, body.byteLength), srcFrames, meta);
  const canonFrames = core.resampleMono(decoded[0], srcRate, 48000).length;
  const whole = await chunked.readCanonicalWindow(file, plan, 0, canonFrames);
  const pieced = new Float32Array(canonFrames);
  const chunk = 1000;
  for (let start = 0; start < canonFrames; start += chunk) {
    const n = Math.min(chunk, canonFrames - start);
    const part = await chunked.readCanonicalWindow(file, plan, start, n);
    pieced.set(part[0], start);
  }
  const reference = core.resampleMono(decoded[0], srcRate, 48000);
  const score = siSdr(reference, pieced);
  let maxAbs = 0;
  for (let i = 0; i < canonFrames; i++) maxAbs = Math.max(maxAbs, Math.abs(reference[i] - pieced[i]), Math.abs(whole[0][i] - pieced[i]));
  logMeasure('resample-wav', { canonFrames, maxAbs, siSdrDb: score });
  expect(score).toBeGreaterThan(60);
  expect(windows.sourceMargin(srcRate)).toBe(core.kernelRadius(srcRate, 48000));
});

test('the classic worker copy matches the core module', async () => {
  const { classicSource } = await import('../scripts/quality/wrap-bandlimited-resampler.mjs');
  const esm = fs.readFileSync(path.join(ROOT, 'src/core/BandlimitedResampler.js'), 'utf8');
  const classic = fs.readFileSync(path.join(ROOT, 'src/workers/BandlimitedResampler.js'), 'utf8');
  expect(classic).toBe(classicSource(esm));
  expect(fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8'))
    .toContain("importScripts('/src/workers/BandlimitedResampler.js')");

  const sandbox = {
    self: {},
    Math,
    Float32Array,
    Float64Array,
    Map,
    Array,
    Error,
    TypeError,
    Number,
  };
  vm.createContext(sandbox);
  vm.runInContext(classic, sandbox, { filename: 'BandlimitedResampler.js' });
  const x = speechLike(8000, 44100);
  const fromCore = core.resampleMono(x, 44100, 48000);
  const fromWorker = sandbox.self.vipResampleMono(x, 44100, 48000);
  expect(fromWorker.length).toBe(fromCore.length);
  let maxAbs = 0;
  for (let i = 0; i < fromCore.length; i++) maxAbs = Math.max(maxAbs, Math.abs(fromCore[i] - fromWorker[i]));
  expect(maxAbs).toBe(0);
});

test('speech-like SI-SDR against scipy.signal.resample_poly', () => {
  const fromRate = 44100;
  const toRate = 48000;
  const input = speechLike(fromRate * 2, fromRate);
  const output = core.resampleMono(input, fromRate, toRate);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-resample-'));
  const inPath = path.join(dir, 'in.f32');
  const outPath = path.join(dir, 'out.f32');
  fs.writeFileSync(inPath, Buffer.from(input.buffer, input.byteOffset, input.byteLength));
  fs.writeFileSync(outPath, Buffer.from(output.buffer, output.byteOffset, output.byteLength));
  const g = gcd(fromRate, toRate);
  const py = `
import json, sys
import numpy as np
from scipy.signal import resample_poly
import scipy
x = np.fromfile(sys.argv[1], dtype=np.float32).astype(np.float64)
y = np.fromfile(sys.argv[2], dtype=np.float32).astype(np.float64)
up, down = int(sys.argv[3]), int(sys.argv[4])
ref = resample_poly(x, up, down, window=("kaiser", 5.0))
n = min(len(ref), len(y))
m = n // 10
a = ref[m:n - m]
b = y[m:n - m]
rr = float(np.dot(a, a))
alpha = float(np.dot(b, a) / rr)
err = b - alpha * a
noise = float(np.dot(err, err))
sig = float(np.dot(alpha * a, alpha * a))
cc = np.fft.irfft(np.fft.rfft(a) * np.conj(np.fft.rfft(b)))
lag = int(np.argmax(cc))
if lag > len(cc) // 2:
    lag -= len(cc)
print(json.dumps({
    "siSdrDb": 10 * np.log10(sig / noise),
    "lagSamples": lag,
    "scipy": scipy.__version__,
    "samples": int(n),
    "up": up,
    "down": down,
    "window": ["kaiser", 5.0],
}))
`;
  const run = spawnSync('python3', ['-c', py, inPath, outPath, String(toRate / g), String(fromRate / g)], {
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  expect(run.status).toBe(0);
  const measured = JSON.parse(run.stdout);
  logMeasure('resample-scipy', measured);
  expect(measured.siSdrDb).toBeGreaterThan(40);
  expect(measured.lagSamples).toBe(0);
});
