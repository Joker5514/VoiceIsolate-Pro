/**
 * VoiceIsolate Pro — MLWorker DSP Correctness Tests
 *
 * MLWorker.js is a classic worker (importScripts), so it is evaluated in a
 * Node `vm` sandbox with `self`/`ort` stubs. Top-level function declarations
 * (fftInPlace, hann, runSpectralMask) become sandbox globals we can call
 * directly — letting us verify the actual shipped DSP, not a copy.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadWorkerSandbox(sessionRun) {
  const src = fs.readFileSync(
    path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8'
  );
  const sandbox = {
    importScripts: () => {},
    console,
    Math,
    self: { postMessage: () => {}, navigator: { hardwareConcurrency: 1 } },
    ort: {
      Tensor: class Tensor {
        constructor(type, data, dims) {
          this.type = type; this.data = data; this.dims = dims;
        }
      },
    },
    Float32Array,
    Uint32Array,
    Uint8Array,
    Object,
    Promise,
    Error,
  };
  sandbox.self.onmessage = null;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'MLWorker.js' });
  // Lexical declarations in strict classic-worker code are not guaranteed to
  // become enumerable properties of a Node vm global.
  sandbox.runSpectralMask = vm.runInContext('runSpectralMask', sandbox);
  sandbox.__session = { run: sessionRun };
  return sandbox;
}

const ENTRY = {
  id: 'test-mask',
  strategy: 'spectral-mask',
  fftSize: 4096,
  hopSize: 1024,
  bins: 2049,
  maxBatchFrames: 8,
  io: { input: 'input', output: 'output' },
};

describe('MLWorker FFT (fftInPlace)', () => {
  test('matches the analytic DFT of a pure cosine', () => {
    const sb = loadWorkerSandbox();
    const n = 64;
    const k0 = 5;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k0 * i) / n);
    sb.fftInPlace(re, im, false);
    // A length-n cosine at bin k0 → spikes of n/2 at bins k0 and n−k0.
    for (let k = 0; k < n; k++) {
      const mag = Math.hypot(re[k], im[k]);
      const expected = (k === k0 || k === n - k0) ? n / 2 : 0;
      expect(mag).toBeCloseTo(expected, 3);
    }
  });

  test('forward → inverse round-trips to the input', () => {
    const sb = loadWorkerSandbox();
    const n = 4096;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    const orig = new Float32Array(n);
    for (let i = 0; i < n; i++) orig[i] = re[i] = Math.sin(i * 0.013) + 0.3 * Math.sin(i * 0.21);
    sb.fftInPlace(re, im, false);
    sb.fftInPlace(re, im, true);
    let maxErr = 0;
    for (let i = 0; i < n; i++) maxErr = Math.max(maxErr, Math.abs(re[i] - orig[i]));
    expect(maxErr).toBeLessThan(1e-4);
  });
});

describe('MLWorker spectral-mask reconstruction (runSpectralMask)', () => {
  test('an all-ones mask reconstructs the input (STFT/iSTFT identity)', async () => {
    const sb = loadWorkerSandbox();
    const session = {
      run: async (feed) => {
        const t = feed.input;
        return { output: { data: new Float32Array(t.data.length).fill(1) } };
      },
    };
    const len = 48000; // 1 s
    const input = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      input[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / 48000)
               + 0.2 * Math.sin((2 * Math.PI * 1300 * i) / 48000);
    }
    const out = await sb.runSpectralMask(ENTRY, session, input, () => {});
    expect(out.length).toBe(len);
    // Mirror-padded framing covers the edges too: check every sample.
    let maxErr = 0;
    for (let i = 0; i < len; i++) {
      maxErr = Math.max(maxErr, Math.abs(out[i] - input[i]));
    }
    expect(maxErr).toBeLessThan(1e-3);
  });

  // F26: frames used to start at sample 0, so the first/last ~1500 samples sat
  // under a window ramp; with the half-peak divisor floor and 8 ms fades a
  // unity mask lost ~2850 samples and boundary impulses came out as 0.
  const unity = {
    run: async (feed) => ({ output: { data: new Float32Array(feed.input.data.length).fill(1) } }),
  };

  test.each([1, 2, 100, 1023, 4096, 4097, 5000, 48001])(
    'unity mask reconstructs a %i-sample input to its edges', async (len) => {
      const sb = loadWorkerSandbox();
      const input = new Float32Array(len);
      for (let i = 0; i < len; i++) input[i] = 0.5 * Math.sin((2 * Math.PI * 50 * i) / 48000 + 0.3);
      const out = await sb.runSpectralMask(ENTRY, unity, input, () => {});
      expect(out.length).toBe(len);
      let maxErr = 0;
      for (let i = 0; i < len; i++) {
        expect(Number.isFinite(out[i])).toBe(true);
        maxErr = Math.max(maxErr, Math.abs(out[i] - input[i]));
      }
      // 50 Hz sits far below the fixed HF taper (bins ≥ 35% of Nyquist), so
      // the only error left is float32 FFT round-off plus the taper's effect
      // on the mirror's slope discontinuity: measured ≤ 3.5e-4 at 0.5 peak.
      expect(maxErr).toBeLessThan(1e-3);
    },
  );

  test('a boundary impulse is treated like an interior one', async () => {
    const sb = loadWorkerSandbox();
    const len = 48000;
    const input = new Float32Array(len);
    input[10] = 1;
    input[24000] = 1;
    input[len - 10] = 1;
    const out = await sb.runSpectralMask(ENTRY, unity, input, () => {});
    // The always-on HF taper shapes every impulse identically (≈0.82 peak);
    // the edges must match the interior instead of collapsing to 0.
    expect(out[24000]).toBeGreaterThan(0.5);
    expect(Math.abs(out[10] - out[24000])).toBeLessThan(0.01);
    expect(Math.abs(out[len - 10] - out[24000])).toBeLessThan(0.01);
  });

  test('the hop-N/2 path reconstructs edges as well', async () => {
    const sb = loadWorkerSandbox();
    const entry = { ...ENTRY, hopSize: 2048 };
    const len = 9001;
    const input = new Float32Array(len);
    for (let i = 0; i < len; i++) input[i] = 0.4 * Math.cos((2 * Math.PI * 80 * i) / 48000);
    const out = await sb.runSpectralMask(entry, unity, input, () => {});
    let maxErr = 0;
    for (let i = 0; i < len; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - input[i]));
    expect(maxErr).toBeLessThan(1e-3);
  });

  test('an all-zeros mask silences the output completely', async () => {
    const sb = loadWorkerSandbox();
    const session = {
      run: async (feed) => ({
        output: { data: new Float32Array(feed.input.data.length).fill(0) },
      }),
    };
    const input = new Float32Array(20000).map(() => Math.random() - 0.5);
    const out = await sb.runSpectralMask(ENTRY, session, input, () => {});
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(peak).toBeLessThan(1e-6);
  });

  test('reports monotonic progress up to 1', async () => {
    const sb = loadWorkerSandbox();
    const session = {
      run: async (feed) => ({
        output: { data: new Float32Array(feed.input.data.length).fill(1) },
      }),
    };
    const ticks = [];
    await sb.runSpectralMask(ENTRY, session, new Float32Array(48000), (p) => ticks.push(p));
    expect(ticks.length).toBeGreaterThan(1);
    expect(ticks.at(-1)).toBe(1);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThanOrEqual(ticks[i - 1]);
  });

  test('malformed model output rejects with a descriptive error', async () => {
    const sb = loadWorkerSandbox();
    const session = { run: async () => ({ output: { data: new Float32Array(3) } }) };
    await expect(
      sb.runSpectralMask(ENTRY, session, new Float32Array(8000), () => {})
    ).rejects.toThrow(/malformed output tensor/);
  });
});
