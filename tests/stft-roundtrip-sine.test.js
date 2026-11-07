'use strict';

const fs = require('fs');
const path = require('path');

const dspSrc = fs.readFileSync(path.join(__dirname, '../public/app/dsp-core.js'), 'utf8');
const DSPCore = (() => {
  const exports = {};
  const module = { exports };
  const window = undefined;
  const self = undefined;
  // eslint-disable-next-line no-eval
  eval(dspSrc);
  return module.exports;
})();

describe('Single-pass STFT → iSTFT sine roundtrip', () => {
  test('reconstructs a pure sine wave within floating-point epsilon tolerance', () => {
    const sampleRate = 48000;
    const fftSize = 1024;
    const hopSize = 256;
    const length = sampleRate;
    const freq = 440;
    const input = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      input[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }

    const { mag, phase } = DSPCore.forwardSTFT(input, fftSize, hopSize);
    const output = DSPCore.inverseSTFT(mag, phase, fftSize, hopSize, length);

    let maxErr = 0;
    const start = fftSize;
    const end = length - fftSize;
    for (let i = start; i < end; i++) {
      maxErr = Math.max(maxErr, Math.abs(output[i] - input[i]));
    }
    expect(maxErr).toBeLessThan(1e-3);
  });
});

/**
 * Full-buffer identity. The interior-only score above stays green even when
 * the first and last window are attenuated by the half-peak overlap-add
 * floor. These cases require the whole buffer, including a click on sample 0
 * and on the last sample, at every stft-math preset (75% and 50% hop).
 */
const vm = require('vm');
const { siSdr } = require('../scripts/quality/lib/metrics.cjs');

const ROOT = path.join(__dirname, '..');
const SR = 48000;

// Kept in lockstep with STFT_PRESETS; the parity test fails if a preset is added.
const PRESETS = [
  ['engineer', 2048, 512],
  ['forensic', 4096, 1024],
  ['engineerMobile', 1024, 512],
  ['usm', 4096, 1024],
  ['cleanup', 2048, 512],
  ['live', 1024, 512],
];

function sine(length, amp = 0.8, freq = 440) {
  const x = new Float32Array(length);
  for (let i = 0; i < length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

function whiteNoise(length) {
  const x = new Float32Array(length);
  let s = 0x12345678;
  for (let i = 0; i < length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    x[i] = (s / 4294967296) * 2 - 1;
  }
  return x;
}

function edgeClicks(length) {
  const x = new Float32Array(length);
  x[0] = 0.8;
  x[length - 1] = -0.7;
  return x;
}

function maxAbsErr(a, b) {
  let m = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  if (a.length !== b.length) m = Math.max(m, 1);
  return m;
}

function expectIdentity(out, input, label) {
  expect(out.length).toBe(input.length);
  const err = maxAbsErr(out, input);
  const si = siSdr(out, input);
  if (!(err < 1e-5 && si > 100)) {
    throw new Error(`${label}: max|err|=${err} SI-SDR=${si} length=${out.length}`);
  }
  expect(err).toBeLessThan(1e-5);
  expect(si).toBeGreaterThan(100);
}

function loadFftBridge() {
  const src = fs.readFileSync(path.join(ROOT, 'public/app/fft-bridge.js'), 'utf8').replace(/^export\s+/gm, '');
  return new Function(`${src}\nreturn { computeSTFT, reconstructISTFT };`)();
}

function loadOffline() {
  const src = fs.readFileSync(path.join(ROOT, 'public/app/offline-processor.js'), 'utf8').replace(/^export\s+/gm, '');
  return new Function(`${src}\nreturn { forwardSTFT, inverseSTFT, configureProcessingResolution };`)();
}

function loadBootstrap() {
  const src = fs.readFileSync(path.join(ROOT, 'public/app/dsp-bootstrap.js'), 'utf8');
  const sandbox = {
    console: { info() {}, warn() {}, error() {}, log() {} },
    Math, Float32Array, Int32Array, Array, Object, Number, String, Error,
    setTimeout() { return 0; },
    clearTimeout() {},
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector() { return null; },
      head: { appendChild() {} },
      body: {},
      documentElement: {},
    },
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'dsp-bootstrap.js' });
  return sandbox.DSP;
}

function loadWorkerRoundtrip() {
  const sandbox = {
    console: { info() {}, warn() {}, error() {}, log() {} },
    Math, Float32Array, Float64Array, ArrayBuffer, Uint8Array, Int32Array,
    Map, Object, Array, Error, Number, String, JSON, Infinity, isFinite, NaN,
    setTimeout, clearTimeout, performance,
    importScripts() {
      vm.runInContext(
        fs.readFileSync(path.join(ROOT, 'public/app/dsp-core.js'), 'utf8'),
        sandbox,
        { filename: 'dsp-core.js' },
      );
    },
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  const src = `${fs.readFileSync(path.join(ROOT, 'public/app/dsp-worker.js'), 'utf8')}
    self.__roundtrip = async function (pcm) {
      dspCore = DSPCoreLocal;
      isInitialized = true;
      const result = await handleProcess({
        audioData: pcm.buffer,
        sampleRate: ${SR},
        params: null,
        enabledModels: [],
      });
      return new Float32Array(result.processedData);
    };
  `;
  vm.runInContext(src, sandbox, { filename: 'dsp-worker.js' });
  return sandbox.__roundtrip;
}

describe('full-buffer STFT identity, including the file edges', () => {
  let bridge;
  let offline;
  let bootstrap;
  let workerRoundtrip;
  let reconstructPassThrough;
  let presets;

  beforeAll(async () => {
    bridge = loadFftBridge();
    offline = loadOffline();
    bootstrap = loadBootstrap();
    workerRoundtrip = loadWorkerRoundtrip();
    ({ reconstructPassThrough } = await import('../src/core/OverlapAddAccumulator.js'));
    ({ STFT_PRESETS: presets } = await import('../src/core/stft-math.js'));
  });

  test('covers every stft-math preset, including the 50% hops', () => {
    expect(Object.keys(presets).sort()).toEqual(PRESETS.map((p) => p[0]).sort());
    for (const [name, fftSize, hopSize] of PRESETS) {
      expect(presets[name].fftSize).toBe(fftSize);
      expect(presets[name].hopSize).toBe(hopSize);
      expect(hopSize).toBeLessThan(fftSize);
    }
    expect(PRESETS.some(([, n, h]) => h === n / 2)).toBe(true);
  });

  const signals = [
    ['440 Hz 0.8 sine', () => sine(SR)],
    ['white noise', () => whiteNoise(SR)],
    ['clicks at sample 0 and the last sample', () => edgeClicks(SR)],
  ];

  describe.each(PRESETS)('DSPCore %s (%i / %i)', (name, fftSize, hopSize) => {
    test.each(signals)('%s round-trips the whole buffer', (_label, make) => {
      const input = make();
      const { mag, phase } = DSPCore.forwardSTFT(input, fftSize, hopSize);
      const out = DSPCore.inverseSTFT(mag, phase, fftSize, hopSize, input.length);
      expectIdentity(out, input, `DSPCore ${name} ${_label}`);
    });

    test('async pair matches the sync pair on the audit sine', async () => {
      const input = sine(SR);
      const spec = await DSPCore.forwardSTFTAsync(input, fftSize, hopSize, { yieldEvery: 100000 });
      const out = await DSPCore.inverseSTFTAsync(spec.mag, spec.phase, fftSize, hopSize, input.length, { yieldEvery: 100000 });
      expectIdentity(out, input, `DSPCore async ${name}`);
    });
  });

  describe.each(PRESETS)('fft-bridge %s (%i / %i)', (name, fftSize, hopSize) => {
    test.each(signals)('%s round-trips the whole buffer', (_label, make) => {
      const input = make();
      const { magnitudes, phases } = bridge.computeSTFT(input, fftSize, hopSize, SR);
      const out = bridge.reconstructISTFT(magnitudes, phases, fftSize, hopSize);
      expectIdentity(out, input, `fft-bridge ${name} ${_label}`);
    });
  });

  describe.each(PRESETS)('bootstrap DSP %s (%i / %i)', (name, fftSize, hopSize) => {
    test.each(signals)('%s round-trips the whole buffer', (_label, make) => {
      const input = make();
      const spec = bootstrap.forwardSTFT(input, fftSize, hopSize);
      const out = bootstrap.inverseSTFT(spec.mag, spec.phase, fftSize, hopSize, input.length);
      expectIdentity(out, input, `bootstrap ${name} ${_label}`);
    });
  });

  describe.each(PRESETS)('reconstructPassThrough %s (%i / %i)', (name, fftSize, hopSize) => {
    test.each(signals)('%s round-trips the whole buffer', (_label, make) => {
      const input = make();
      const out = reconstructPassThrough(input, { fftSize, hopSize });
      expectIdentity(out, input, `OLA ${name} ${_label}`);
    });
  });

  test.each(signals)('dsp-worker handleProcess %s keeps the input length and the edges', async (_label, make) => {
    const input = make();
    const out = await workerRoundtrip(input);
    expectIdentity(out, input, `dsp-worker ${_label}`);
  });

  const offlineModes = [
    ['live', 1024, 256],
    ['creator', 2048, 512],
    ['forensic', 4096, 1024],
  ];

  describe.each(offlineModes)('offline-processor %s (%i / %i)', (mode, fftSize, hopSize) => {
    test.each(signals)('%s round-trips the whole buffer', (_label, make) => {
      offline.configureProcessingResolution({ mode });
      const input = make();
      const spec = offline.forwardSTFT(input);
      const out = offline.inverseSTFT(spec);
      expect(spec.hopCount).toBeGreaterThan(0);
      expect(fftSize).toBeGreaterThan(hopSize);
      expectIdentity(out, input, `offline ${mode} ${_label}`);
    });
  });

  test('lengths that are not a multiple of the hop, and clips shorter than the window, still round-trip', () => {
    const cases = [
      ['DSPCore forensic odd', sine(SR + 777), (x) => {
        const { mag, phase } = DSPCore.forwardSTFT(x, 4096, 1024);
        return DSPCore.inverseSTFT(mag, phase, 4096, 1024, x.length);
      }],
      ['DSPCore 50% short', edgeClicks(1000), (x) => {
        const { mag, phase } = DSPCore.forwardSTFT(x, 1024, 512);
        return DSPCore.inverseSTFT(mag, phase, 1024, 512, x.length);
      }],
      ['fft-bridge odd', whiteNoise(SR + 777), (x) => {
        const { magnitudes, phases } = bridge.computeSTFT(x, 2048, 512, SR);
        return bridge.reconstructISTFT(magnitudes, phases, 2048, 512);
      }],
      ['OLA odd', sine(9000), (x) => reconstructPassThrough(x, { fftSize: 2048, hopSize: 512 })],
      ['bootstrap short', edgeClicks(3000), (x) => {
        const spec = bootstrap.forwardSTFT(x, 4096, 1024);
        return bootstrap.inverseSTFT(spec.mag, spec.phase, 4096, 1024, x.length);
      }],
    ];
    for (const [label, input, run] of cases) {
      expectIdentity(run(input), input, label);
    }
    offline.configureProcessingResolution({ mode: 'forensic' });
    const short = edgeClicks(3000);
    const spec = offline.forwardSTFT(short);
    expectIdentity(offline.inverseSTFT(spec), short, 'offline forensic short');
  });

  test('a non-overlapping analysis frame (spectrogram hop = fft) is still one window', () => {
    const fftSize = 1024;
    const input = sine(fftSize, 0.5, 1000);
    const spec = DSPCore.forwardSTFT(input, fftSize, fftSize);
    expect(spec.frameCount).toBe(1);
    expect(spec.mag).toHaveLength(1);
    expect(spec.mag[0]).toHaveLength(fftSize / 2 + 1);
    for (let k = 0; k < spec.mag[0].length; k++) expect(Number.isFinite(spec.mag[0][k])).toBe(true);
  });
});
