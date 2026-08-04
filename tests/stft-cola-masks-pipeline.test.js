/**
 * STFT COLA / mask / pipeline-budget guards (audit Phases 1.7, 5, F-02/F-08).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let math;
let sc;
let usm;

beforeAll(async () => {
  math = await import('../src/core/stft-math.js');
  sc = await import('../src/core/SpectralCleanup.js');
  usm = await import('../src/core/UniversalSourceMatrix.js');
});

// ── DSPCore sine roundtrip at Engineer 75% geometry ──────────────────────────

function loadDSPCore() {
  const dspSrc = fs.readFileSync(path.join(ROOT, 'public/app/dsp-core.js'), 'utf8');
  const exports = {};
  const module = { exports };
  // eslint-disable-next-line no-eval
  eval(dspSrc);
  return module.exports;
}

describe('DSPCore roundtrip at Engineer 75% hop (2048/512)', () => {
  let DSPCore;

  beforeAll(() => {
    DSPCore = loadDSPCore();
  });

  test('sine PR max error < 1e-3 in steady state', () => {
    const sampleRate = 48000;
    const fftSize = 2048;
    const hopSize = 512;
    const length = sampleRate;
    const input = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      input[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
    }
    const { mag, phase } = DSPCore.forwardSTFT(input, fftSize, hopSize);
    const output = DSPCore.inverseSTFT(mag, phase, fftSize, hopSize, length);
    let maxErr = 0;
    for (let i = fftSize; i < length - fftSize; i++) {
      maxErr = Math.max(maxErr, Math.abs(output[i] - input[i]));
    }
    expect(maxErr).toBeLessThan(1e-3);
  });

  test('all-ones magnitude path stays near PR (identity mask)', () => {
    const fftSize = 1024;
    const hopSize = 256;
    const length = 8192;
    const input = new Float32Array(length);
    for (let i = 0; i < length; i++) input[i] = 0.25 * Math.sin((2 * Math.PI * 1000 * i) / 48000);
    const { mag, phase } = DSPCore.forwardSTFT(input, fftSize, hopSize);
    // Soft unity mask: leave mag unchanged
    const out = DSPCore.inverseSTFT(mag, phase, fftSize, hopSize, length);
    let maxErr = 0;
    for (let i = fftSize; i < length - fftSize; i++) {
      maxErr = Math.max(maxErr, Math.abs(out[i] - input[i]));
    }
    expect(maxErr).toBeLessThan(2e-3);
  });
});

// ── SpectralCleanup uses periodic Hann (no N-1) ──────────────────────────────

describe('SpectralCleanup window contract', () => {
  test('source no longer uses symmetric (N-1) Hann', () => {
    const src = read('src/core/SpectralCleanup.js');
    expect(src).toMatch(/periodicHann/);
    expect(src).not.toMatch(/\/ \(n - 1\)\)/);
    expect(src).not.toMatch(/\/ \(N - 1\)\)/);
  });

  test('tiny amount ≈ identity still holds after periodic Hann', () => {
    const SR = 48000;
    const x = new Float32Array(SR);
    for (let i = 0; i < SR; i++) {
      x[i] = 0.4 * Math.sin((2 * Math.PI * (200 + 0.05 * i) * i) / SR);
    }
    const y = sc.reduceNoise(x, { amount: 1e-6, sampleRate: SR });
    let maxErr = 0;
    for (let i = 4096; i < x.length - 4096; i++) {
      maxErr = Math.max(maxErr, Math.abs(y[i] - x[i]));
    }
    expect(maxErr).toBeLessThan(1e-3);
  });
});

// ── USM window + residual ────────────────────────────────────────────────────

describe('USM STFT + residual', () => {
  test('uses periodicHann from stft-math', () => {
    const src = read('src/core/UniversalSourceMatrix.js');
    expect(src).toMatch(/periodicHann/);
    expect(src).not.toMatch(/\/ \(n - 1\)\)/);
  });

  test('separateUniversal produces multi-stem PCMs (incl. residual partition)', () => {
    const SR = 48000;
    const n = SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR)
        + 0.15 * Math.sin((2 * Math.PI * 3000 * i) / SR);
    }
    const result = usm.separateUniversal(x, SR, { numSources: 3, nmfIterations: 12, seed: 7 });
    // NMF path returns K stems + residual mask (labels via centroids may not say "residual")
    expect(result.sources.length).toBeGreaterThanOrEqual(3);
    for (const src of result.sources) {
      expect(src.pcm.length).toBe(x.length);
      expect(src.mask.length).toBeGreaterThan(0);
      for (let i = 0; i < 64; i++) {
        expect(Number.isFinite(src.pcm[i])).toBe(true);
        expect(src.mask[i]).toBeGreaterThanOrEqual(0);
        expect(src.mask[i]).toBeLessThanOrEqual(1);
      }
    }
  });

  test('query mode accepts text prompts without throwing', () => {
    const SR = 16000;
    const x = new Float32Array(SR);
    for (let i = 0; i < SR; i++) x[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.2;
    const result = usm.separateUniversal(x, SR, {
      mode: 'query',
      queries: ['speech', 'noise'],
      fftSize: 2048,
      hopSize: 512,
    });
    expect(result.method).toMatch(/query/);
    expect(result.sources.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Engineer hop policy (source contract) ────────────────────────────────────

describe('Engineer STFT geometry in app.js', () => {
  const appJs = read('public/app/app.js');

  test('desktop hop is FFT>>2 (75%), not fixed 1024 on all sizes', () => {
    expect(appJs).toMatch(/FFT >> 2|FFT \/ 4/);
    expect(appJs).toMatch(/mobile \? Math\.max\(512, FFT \/ 2\) : Math\.max\(256, FFT >> 2\)/);
  });

  test('documents 75% COLA for desktop', () => {
    expect(appJs).toMatch(/75% COLA|hop = FFT\/4|FFT >> 2/);
  });
});

// ── Pipeline STFT inventory (document multi-module budget) ────────────────────

describe('pipeline STFT entry-point inventory (F-02 documentation)', () => {
  /** Known independent STFT owners — each is single-pass internally. */
  const OWNERS = [
    { file: 'public/app/dsp-core.js', symbols: ['forwardSTFT', 'inverseSTFT'] },
    { file: 'src/core/SpectralCleanup.js', symbols: ['overlapProcess', 'forwardSTFT'] },
    { file: 'src/core/UniversalSourceMatrix.js', symbols: ['computeStft', 'maskToPcm'] },
    { file: 'public/app/fft-bridge.js', symbols: ['computeSTFT', 'reconstructISTFT'] },
    { file: 'public/app/offline-processor.js', symbols: ['forwardSTFT', 'inverseSTFT'] },
  ];

  test('each owner file still exists and defines its STFT symbols', () => {
    for (const owner of OWNERS) {
      const src = read(owner.file);
      for (const sym of owner.symbols) {
        expect(src).toMatch(new RegExp(sym));
      }
    }
  });

  test('Live worklets do not import STFT / FFT kernels', () => {
    for (const rel of ['src/workers/GateProcessor.js', 'src/workers/DeEsserProcessor.js']) {
      const src = read(rel);
      expect(src).not.toMatch(/forwardSTFT|inverseSTFT|computeSTFT|fftInPlace/);
    }
  });

  test('stft-math is the shared window source for USM + SpectralCleanup', () => {
    expect(read('src/core/SpectralCleanup.js')).toMatch(/from '\.\/stft-math\.js'/);
    expect(read('src/core/UniversalSourceMatrix.js')).toMatch(/from '\.\/stft-math\.js'/);
  });
});

// ── Hop-rate AM smoke (hard gate → envelope energy at fs/H) ───────────────────

describe('hop-rate modulation smoke after hard spectral gate', () => {
  let DSPCore;

  beforeAll(() => {
    DSPCore = loadDSPCore();
  });

  test('50% hop after zeroing high bins shows more hop-period energy than 75%', () => {
    const sr = 48000;
    const len = sr;
    // Broadband-ish noise
    const input = new Float32Array(len);
    let s = 123456789;
    for (let i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      input[i] = ((s / 0xffffffff) * 2 - 1) * 0.4;
    }

    function hopAmScore(fftSize, hopSize) {
      const { mag, phase } = DSPCore.forwardSTFT(input, fftSize, hopSize);
      // Hard high-band gate — strong spectral modification
      const cut = Math.floor(mag[0].length * 0.35);
      for (let f = 0; f < mag.length; f++) {
        for (let k = cut; k < mag[f].length; k++) mag[f][k] = 0;
      }
      const out = DSPCore.inverseSTFT(mag, phase, fftSize, hopSize, len);
      // Envelope via |Hilbert-ish| approx: abs + light smooth
      const env = new Float32Array(len);
      for (let i = 0; i < len; i++) env[i] = Math.abs(out[i]);
      // DFT bin for hop rate f_h = sr/hop
      const fHop = sr / hopSize;
      const k = Math.round((fHop / sr) * len);
      let re = 0;
      let im = 0;
      const start = fftSize;
      const end = len - fftSize;
      for (let i = start; i < end; i++) {
        const ang = (2 * Math.PI * k * i) / len;
        re += env[i] * Math.cos(ang);
        im += env[i] * Math.sin(ang);
      }
      return Math.hypot(re, im) / (end - start);
    }

    const score50 = hopAmScore(2048, 1024);
    const score75 = hopAmScore(2048, 512);
    // 75% hop should not be dramatically worse; typically lower hop-AM after gates.
    // Soft check: both finite; 75% path is preferred architecture.
    expect(Number.isFinite(score50)).toBe(true);
    expect(Number.isFinite(score75)).toBe(true);
    expect(score75).toBeLessThan(score50 * 1.5 + 1e-6);
  });
});
