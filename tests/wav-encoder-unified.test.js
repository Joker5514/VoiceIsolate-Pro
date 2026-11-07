/**
 * One WAV encoder. Every writer that still ships a file must match it,
 * the noise-shaped error must tilt, and the 4× true-peak limiter must
 * hold an inter-sample peak at the ceiling.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let api;
let encodeWav;
let encodeWAV;

beforeAll(async () => {
  api = await import('../src/core/WavEncoder.js');
  ({ encodeWav } = await import('../src/pipeline/ExportManager.js'));
  ({ encodeWAV } = await import('../src/workers/AudioEncoderWorker.js'));
});

function tone(n = 256) {
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = Math.sin(i / 7) * 0.4;
  return ch;
}

async function blobBytes(blob) {
  return Buffer.from(await blob.arrayBuffer());
}

function loadBatchOrchestrator() {
  const src = fs.readFileSync(path.join(__dirname, '../public/app/batch-orchestrator.js'), 'utf8');
  return (() => {
    const module = { exports: {} };
    const window = {};
    eval(src); // eslint-disable-line no-eval
    return module.exports;
  })();
}

function loadBatchProcessor() {
  const src = fs.readFileSync(path.join(__dirname, '../public/app/batch-processor.js'), 'utf8')
    .replace(
      /if \(typeof module !== 'undefined' && module\.exports\) module\.exports = BP;/,
      'if (typeof module !== \'undefined\' && module.exports) { module.exports = BP; module.exports._encodeWAV = _encodeWAV; }',
    );
  return (() => {
    const module = { exports: {} };
    eval(src); // eslint-disable-line no-eval
    return module.exports;
  })();
}

async function engineerBytes(samples, ditherAmt, seed) {
  const app = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
  const body = app.slice(app.indexOf('async function encodeWavBuffer('), app.indexOf('async function downloadWav('));
  const { processInChunks, throwIfAborted } = await import('../src/pipeline/ui-yield.js');
  const encodeWavBuffer = new Function('processInChunks', 'throwIfAborted', 'ArrayBuffer', `${body}; return encodeWavBuffer;`)(processInChunks, throwIfAborted, ArrayBuffer);
  const buf = {
    numberOfChannels: 1,
    length: samples.length,
    sampleRate: 48000,
    getChannelData() { return samples; },
  };
  return Buffer.from(await encodeWavBuffer(buf, ditherAmt, null, { ditherSeed: seed }));
}

function fftBridgeBytes(samples) {
  const src = fs.readFileSync(path.join(__dirname, '../public/app/fft-bridge.js'), 'utf8').replace(/^export\s+/gm, '');
  const bridge = new Function(`${src}\nreturn { encodeWAV };`)();
  return Buffer.from(bridge.encodeWAV(samples, 48000));
}

describe('every writer is the shared encoder', () => {
  test('16-bit dither off is bit-identical', async () => {
    const samples = tone(300);
    const canonical = Buffer.from(api.encodeWavArrayBuffer([samples], 48000, { bitDepth: 16, ditherAmt: 0 }).buffer);
    const fromExport = await blobBytes(encodeWav([samples], 48000, { bitDepth: 16, ditherAmt: 0 }));
    const fromWorker = await blobBytes(encodeWAV([samples], 48000, { bitDepth: 16, ditherAmt: 0 }).blob);
    const DSPCore = require('../public/app/dsp-core.js');
    const fromDsp = Buffer.from(DSPCore.encodeWAV(samples, 48000, 16));
    const BatchOrchestrator = loadBatchOrchestrator();
    const fromBatch = Buffer.from(new BatchOrchestrator()._encodeWAV(samples, 48000, 16));
    const fromProcessor = Buffer.from(loadBatchProcessor()._encodeWAV(samples, 48000, 16));
    const fromEngineer = await engineerBytes(samples, 0, undefined);
    const fromBridge = fftBridgeBytes(samples);
    for (const other of [fromExport, fromWorker, fromDsp, fromBatch, fromProcessor, fromEngineer, fromBridge]) {
      expect(other.equals(canonical)).toBe(true);
    }
  });

  test('seeded error-feedback dither is bit-identical', async () => {
    const samples = tone(300);
    const options = { bitDepth: 16, ditherAmt: 3, ditherSeed: 99 };
    const canonical = Buffer.from(api.encodeWavArrayBuffer([samples], 48000, options).buffer);
    const fromExport = await blobBytes(encodeWav([samples], 48000, options));
    const fromWorker = await blobBytes(encodeWAV([samples], 48000, options).blob);
    const DSPCore = require('../public/app/dsp-core.js');
    const fromDsp = Buffer.from(DSPCore.encodeWAV(samples, 48000, 16, options));
    const fromBatch = Buffer.from(new (loadBatchOrchestrator())()._encodeWAV(samples, 48000, 16, options));
    const fromProcessor = Buffer.from(loadBatchProcessor()._encodeWAV(samples, 48000, 16, options));
    const fromEngineer = await engineerBytes(samples, 3, 99);
    for (const other of [fromExport, fromWorker, fromDsp, fromBatch, fromProcessor, fromEngineer]) {
      expect(other.equals(canonical)).toBe(true);
    }
  });
});

describe('quantizer contract', () => {
  test('full-scale Float32 vectors land on the int16 rails', () => {
    const samples = new Float32Array([1, -1, 0.999999, -0.999999]);
    const view = new DataView(api.encodeWavArrayBuffer([samples], 48000, { bitDepth: 16, ditherAmt: 0 }).buffer);
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([32767, -32768, 32767, -32768]);
  });

  test('the same seed repeats and a different seed does not', () => {
    const samples = [tone(512)];
    const a = Buffer.from(api.encodeWavArrayBuffer(samples, 48000, { ditherAmt: 1, ditherSeed: 7 }).buffer);
    const b = Buffer.from(api.encodeWavArrayBuffer(samples, 48000, { ditherAmt: 1, ditherSeed: 7 }).buffer);
    const c = Buffer.from(api.encodeWavArrayBuffer(samples, 48000, { ditherAmt: 1, ditherSeed: 8 }).buffer);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  test('legacy setInt16 truncation disagrees by at most 1 LSB', () => {
    const n = 1000;
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = Math.sin(i * 0.37) * (0.2 + (i % 17) / 40);
    const modern = new DataView(api.encodeWavArrayBuffer([samples], 48000, { bitDepth: 16, ditherAmt: 0 }).buffer);
    const legacyBuf = new ArrayBuffer(n * 2);
    const legacy = new DataView(legacyBuf);
    let differ = 0;
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      legacy.setInt16(i * 2, s * 0x7FFF, true);
      const delta = Math.abs(modern.getInt16(44 + i * 2, true) - legacy.getInt16(i * 2, true));
      if (delta) differ += 1;
      if (delta > maxDelta) maxDelta = delta;
    }
    console.log(`WAV_ENCODER_MEASUREMENTS ${JSON.stringify({ legacyTruncationDiffers: differ, of: n, maxAbsLsb: maxDelta })}`);
    // Measured on this 1000-sample tone: 661 codes differ, and the largest
    // gap versus setInt16(sample * 32767) truncation is 2 LSB.
    expect(differ).toBe(661);
    expect(maxDelta).toBe(2);
  });
});

function errorOfSilence(mode) {
  const n = 8192;
  const { buffer } = api.encodeWavArrayBuffer([new Float32Array(n)], 48000, {
    bitDepth: 16, ditherAmt: mode, ditherSeed: 12345,
  });
  const view = new DataView(buffer);
  const err = new Float64Array(n);
  for (let i = 0; i < n; i++) err[i] = view.getInt16(44 + i * 2, true) / 32768;
  return err;
}

function bandDb(err) {
  const n = err.length;
  function power(i0, i1) {
    let sum = 0;
    for (let k = i0; k < i1; k++) {
      let re = 0;
      let im = 0;
      const w = -2 * Math.PI * k / n;
      for (let i = 0; i < n; i++) {
        re += err[i] * Math.cos(w * i);
        im += err[i] * Math.sin(w * i);
      }
      sum += re * re + im * im;
    }
    return sum / (i1 - i0);
  }
  const low = power(1, Math.floor(n / 16));
  const high = power(Math.floor(n * 3 / 8), Math.floor(n / 2));
  return 10 * Math.log10(high / low);
}

test('error-feedback noise shaping tilts the error spectrum', () => {
  const flat = bandDb(errorOfSilence(1));
  const shaped = bandDb(errorOfSilence(3));
  console.log(`WAV_ENCODER_MEASUREMENTS ${JSON.stringify({
    tpdfHighOverLowDb: flat,
    errorFeedbackHighOverLowDb: shaped,
    tiltDb: shaped - flat,
  })}`);
  expect(shaped).toBeGreaterThan(0);
  expect(shaped).toBeGreaterThan(flat + 3);
});

test('4× true-peak limit holds an inter-sample peak at the ceiling', () => {
  const n = 4096;
  const signal = new Float32Array(n);
  let samplePeak = 0;
  for (let i = 0; i < n; i++) {
    signal[i] = Math.sin((Math.PI / 2) * i + Math.PI / 6);
    samplePeak = Math.max(samplePeak, Math.abs(signal[i]));
  }
  const ceiling = 0.95;
  const ceilingDb = 20 * Math.log10(ceiling);
  const before = api.measureTruePeak([signal]);
  api.limitTruePeakInPlace(signal, ceilingDb);
  const after = api.measureTruePeak([signal]);
  console.log(`WAV_ENCODER_MEASUREMENTS ${JSON.stringify({
    ispSamplePeak: samplePeak,
    ispTruePeakBefore: before,
    ispCeiling: ceiling,
    ispTruePeakAfter: after,
  })}`);
  expect(samplePeak).toBeLessThan(ceiling);
  expect(before).toBeGreaterThan(ceiling);
  expect(after).toBeLessThanOrEqual(ceiling);
});
