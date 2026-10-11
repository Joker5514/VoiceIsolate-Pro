'use strict';

/**
 * Runs the production fused STFT/iSTFT from MLWorker.js with a stub ONNX
 * session that returns a unit mask, so any deviation from the input comes from
 * framing, windowing or overlap-add — not from the model.
 *
 * Regression: frames used to start at sample 0 and stop at the last full
 * window, so the first and last ~N/2 samples had partial window² coverage and
 * the OLA floor attenuated them (identity error ≈ -5 dB over 384..2048), and
 * a 50% hop made the floor modulate the steady state at the hop rate.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SR = 48000;
// The fused path applies fixed 8 ms edge fades; exclude them from identity checks.
const FADE = Math.round(0.008 * SR);

function loadWorker(userAgent) {
  class Tensor {
    constructor(type, data, dims) { Object.assign(this, { type, data, dims }); }
  }
  const self = { navigator: { hardwareConcurrency: 8, userAgent }, postMessage() {} };
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
  const code = fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8')
    + '\nself.__fused = runFusedSpectralMaskChain; self.__hop = adaptiveHopSize;';
  vm.runInContext(code, sandbox);
  return self;
}

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

function sessionReturning(value) {
  return {
    async run(feeds) {
      return { out: { data: new Float32Array(feeds.in.data.length).fill(value) } };
    },
  };
}

/** Two tones below the fused path's fixed HF taper (starts ≈ 8.4 kHz). */
function tones(len) {
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    x[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / SR) + 0.2 * Math.sin((2 * Math.PI * 1234.5 * i) / SR);
  }
  return x;
}

function maxAbsErr(x, y, from, to) {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[i] - y[i]));
  return m;
}

describe.each([
  ['desktop 75% overlap', 'node-test X11', 1024],
  ['mobile 50% overlap', 'Android Mobile', 2048],
])('MLWorker fused STFT edges (%s)', (_label, ua, expectedHop) => {
  const worker = loadWorker(ua);
  const run = (x, mask = 1) => worker.__fused(
    [{ entry: ENTRY, session: sessionReturning(mask) }], x, () => {}, null, SR, null,
  );

  test('uses the expected hop', () => {
    expect(worker.__hop(ENTRY, SR, SR)).toBe(expectedHop);
  });

  test.each([SR, SR * 2 + 777, 4096, 3000])('unit mask reconstructs %i samples to float precision', async (len) => {
    const x = tones(len);
    const y = await run(x);
    expect(y.length).toBe(len);
    expect(maxAbsErr(x, y, FADE, len - FADE)).toBeLessThan(1e-5);
  });

  test('the last hop of the file is not silenced', async () => {
    const len = SR + 777; // not a multiple of the hop
    const x = tones(len);
    const y = await run(x);
    let e = 0;
    for (let i = len - 700; i < len - FADE; i++) e += y[i] * y[i];
    expect(e).toBeGreaterThan(1);
    expect(maxAbsErr(x, y, len - 700, len - FADE)).toBeLessThan(1e-5);
  });

  test('zero mask silences, empty and one-sample inputs stay finite', async () => {
    const silent = await run(tones(SR), 0);
    expect(maxAbsErr(silent, new Float32Array(SR), 0, SR)).toBe(0);
    expect((await run(new Float32Array(0))).length).toBe(0);
    const one = await run(Float32Array.of(0.5));
    expect(one.length).toBe(1);
    expect(Number.isFinite(one[0])).toBe(true);
  });

  test('impulse keeps its position (amplitude reflects only the fixed HF taper)', async () => {
    const x = new Float32Array(SR);
    x[12345] = 0.8;
    const y = await run(x);
    let peakAt = 0;
    for (let i = 1; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[peakAt])) peakAt = i;
    expect(peakAt).toBe(12345);
    // The taper removes up to 55% of the bins above ~8.4 kHz from a broadband click.
    expect(y[12345]).toBeGreaterThan(0.6);
    expect(y[12345]).toBeLessThanOrEqual(0.8);
  });
});

describe('MLWorker spectral sample-rate contract', () => {
  test('refuses non-48 kHz input for a 48 kHz spectral model instead of mis-masking', async () => {
    const worker = loadWorker('node-test X11');
    const posted = [];
    worker.postMessage = (m) => posted.push(m);
    await worker.onmessage({ data: { type: 'init', manifest: [{ ...ENTRY, strategy: 'spectral-mask' }] } });
    await worker.onmessage({ data: {
      type: 'process', requestId: 7, modelIds: ['unit-mask'], sampleRate: 44100,
      channelData: [new Float32Array(4410)],
    } });
    const err = posted.find((m) => m.type === 'error' && m.requestId === 7);
    expect(err?.message).toMatch(/expects 48000 Hz input, got 44100 Hz/);
    expect(posted.some((m) => m.type === 'stems')).toBe(false);
  });
});
