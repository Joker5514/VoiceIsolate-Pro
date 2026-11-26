/**
 * DSP-02 fricative guard (LOCAL 2026-11-25).
 *
 * The guard lives in src/workers/EngineerSpectralControls.js
 * (createEngineerFrameProcessor). It detects likely speech fricatives from
 * the INPUT magnitudes — HF ratio + harmonic-vowel context (peakiness) +
 * temporal continuity — and blends the per-bin gain toward a 0.8 floor in
 * the 2.5-9 kHz band, proportional to confidence.
 *
 * These tests prove, through the REAL processor and the REAL worker +
 * shipped bsrnn_vocals.onnx:
 *   1. the guard fires on fricatives that follow a vowel;
 *   2. it never fires on the non-speech controls (no vowel context);
 *   3. it never fires on vowels alone;
 *   4. fricativeGuard: 0 disables it (output identical to guard-off);
 *   5. through the worker, guard-on improves fricative-band preservation
 *      vs guard-off on real fixtures while control suppression is unchanged;
 *   6. the guard is deterministic (same input, bit-identical output).
 *
 * The guard is ON by default (the builder never emits the id; the
 * processor's sanitize defaults it to 1). The off-config used here is
 * hand-built from the canonical config, exactly as measure-fricatives.cjs
 * --guard off does it.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const { fft } = require('./../scripts/quality/lib/metrics.cjs');
const { buildFricativeFixtures } = require('./../scripts/quality/fricative-fixtures.cjs');
const { bandEnergyDb } = require('./../scripts/quality/lib/metrics.cjs');

const N = 4096;
const HOP = 1024;
const SAMPLE_RATE = 48000;

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}
const WIN = hannWindow(N);

function frameMags(x, start) {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = start + i;
    re[i] = s >= 0 && s < x.length ? x[s] * WIN[i] : 0;
  }
  fft(re, im);
  const mags = new Float32Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) mags[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  return mags;
}

function loadProcessorFactory() {
  const sandbox = { console, Math, Object, Array, Float32Array, Float64Array, Uint8Array, Number, JSON, Error, TypeError };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'src/workers/EngineerSpectralControls.js'), 'utf8'),
    sandbox, { filename: 'EngineerSpectralControls.js' },
  );
  return sandbox.self.createEngineerFrameProcessor;
}

/** Drive a whole signal through the processor; return per-frame diagnostics. */
function driveThrough(factory, config, x) {
  const proc = factory(config, {
    bins: N / 2 + 1, fftSize: N, hop: HOP, sampleRate: SAMPLE_RATE,
  });
  expect(proc).not.toBeNull();
  const nFrames = Math.floor((x.length - N) / HOP) + 1;
  const diags = [];
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let f = 0; f < nFrames; f++) {
    const mags = frameMags(x, f * HOP);
    re.fill(0);
    im.fill(0);
    for (let k = 0; k <= N / 2; k++) re[k] = mags[k];
    proc.applyFrame(re, im, mags, 0, false);
    diags.push(proc.getGuardDiagnostics());
  }
  return diags;
}

describe('DSP-02 fricative guard — processor level', () => {
  let factory;
  let canonical;
  let fixtures;

  beforeAll(async () => {
    factory = loadProcessorFactory();
    const { buildStandardProcessingConfig } = await import('../src/core/PresetCalibration.js');
    canonical = buildStandardProcessingConfig();
    fixtures = buildFricativeFixtures();
  });

  test('guard fires on a fricative that follows a vowel', () => {
    const fx = fixtures.find((f) => f.id === 's-loud-f150');
    const diags = driveThrough(factory, canonical, fx.mix);
    // Fricative frames are the annotated samples; frame centre decides.
    const fricConfs = [];
    for (let f = 0; f < diags.length; f++) {
      const centre = f * HOP + N / 2;
      if (fx.fricMask[centre]) fricConfs.push(diags[f].confidence);
    }
    expect(fricConfs.length).toBeGreaterThan(5);
    const maxFric = Math.max(...fricConfs);
    expect(maxFric).toBeGreaterThan(0.5);
    // Guard is essentially off during the vowels themselves. The release
    // decay (x0.6/frame) legitimately lingers ~4 frames after a fricative
    // ends to cover its decay tail, so exclude those tail frames.
    const tailFrames = new Set();
    for (let f = 0; f < diags.length; f++) {
      const centre = f * HOP + N / 2;
      if (fx.fricMask[centre]) for (let t = 1; t <= 4; t++) tailFrames.add(f + t);
    }
    const steadyVowelConfs = [];
    for (let f = 0; f < diags.length; f++) {
      const start = f * HOP;
      const centre = start + N / 2;
      if (fx.speechMask[centre] && !fx.fricMask[centre] && !tailFrames.has(f)) {
        let pure = true;
        for (let i = start; i < start + N; i++) {
          if (!fx.speechMask[i] || fx.fricMask[i]) { pure = false; break; }
        }
        if (pure) steadyVowelConfs.push(diags[f].confidence);
      }
    }
    expect(steadyVowelConfs.length).toBeGreaterThan(5);
    expect(Math.max(...steadyVowelConfs)).toBeLessThan(0.2);
  });

  test('guard never fires on any non-speech control', () => {
    for (const fx of fixtures.filter((f) => f.kind === 'control')) {
      const diags = driveThrough(factory, canonical, fx.mix);
      const maxConf = Math.max(...diags.map((d) => d.confidence));
      expect(maxConf).toBe(0);
    }
  });

  test('guard never fires on vowels alone (no HF event)', () => {
    const fx = fixtures.find((f) => f.id === 's-loud-f150');
    // Vowel-only: first 0.7 s of the fixture (before the first fricative).
    const vowelOnly = fx.mix.slice(0, Math.round(0.7 * SAMPLE_RATE));
    const diags = driveThrough(factory, canonical, vowelOnly);
    expect(Math.max(...diags.map((d) => d.confidence))).toBeLessThan(0.2);
  });

  test('fricativeGuard: 0 disables the guard entirely', () => {
    const off = {
      ...canonical,
      spectral: { ...canonical.spectral, fricativeGuard: 0 },
      revision: `${canonical.revision}+noguard`,
    };
    const fx = fixtures.find((f) => f.id === 's-loud-f150');
    const diags = driveThrough(factory, off, fx.mix);
    expect(Math.max(...diags.map((d) => d.confidence))).toBe(0);
  });

  test('guard is scoped to the Voice Clarity profile (regression: perf-bundle-identity goldens)', () => {
    // The guard was measured on Voice Clarity only. With no explicit
    // fricativeGuard, it must stay OFF for other presets — otherwise it
    // changes Whisper Boost / Surveillance output and breaks their pinned
    // bit-identical goldens (tests/perf-bundle-identity.test.js).
    const fx = fixtures.find((f) => f.id === 's-loud-f150');
    const whisperBoost = {
      ...canonical,
      standard: { ...canonical.standard, profileId: 'whisper-boost', profile: 'Whisper Boost', status: 'preset' },
    };
    const diags = driveThrough(factory, whisperBoost, fx.mix);
    expect(Math.max(...diags.map((d) => d.confidence))).toBe(0);
    // An unprofiled config (no standard block — e.g. engineerConfig
    // snapshots) also gets the guard off.
    const unprofiled = { ...canonical, standard: undefined };
    delete unprofiled.standard;
    const diagsUnprofiled = driveThrough(factory, unprofiled, fx.mix);
    expect(Math.max(...diagsUnprofiled.map((d) => d.confidence))).toBe(0);
    // A diverged Voice Clarity config keeps the guard (same profile).
    const diverged = {
      ...canonical,
      standard: { ...canonical.standard, status: 'diverged' },
    };
    const diagsDiverged = driveThrough(factory, diverged, fx.mix);
    expect(Math.max(...diagsDiverged.map((d) => d.confidence))).toBeGreaterThan(0.5);
    // Explicit fricativeGuard: 1 re-enables it even for another preset.
    const forced = {
      ...whisperBoost,
      spectral: { ...whisperBoost.spectral, fricativeGuard: 1 },
    };
    const diagsForced = driveThrough(factory, forced, fx.mix);
    expect(Math.max(...diagsForced.map((d) => d.confidence))).toBeGreaterThan(0.5);
  });
});

describe('DSP-02 fricative guard — worker level (real model)', () => {
  jest.setTimeout(180000);
  let createMlWorker;
  let canonical;
  let fixtures;

  beforeAll(async () => {
    ({ createMlWorker } = require('../scripts/quality/lib/mlworker-node.cjs'));
    const { buildStandardProcessingConfig } = await import('../src/core/PresetCalibration.js');
    canonical = buildStandardProcessingConfig();
    fixtures = buildFricativeFixtures();
  });

  test('guard-on improves fricative preservation, control suppression unchanged', async () => {
    const off = {
      ...canonical,
      spectral: { ...canonical.spectral, fricativeGuard: 0 },
      revision: `${canonical.revision}+noguard`,
    };
    const worker = await createMlWorker();
    expect(worker.backend).toBe('wasm');

    const speech = fixtures.find((f) => f.id === 's-loud-f150');
    const control = fixtures.find((f) => f.id === 'control-hiss-s');

    const outOn = await worker.separate([speech.mix], {
      modelIds: ['bsrnn_vocals'], processingConfig: canonical,
    });
    const outOff = await worker.separate([speech.mix], {
      modelIds: ['bsrnn_vocals'], processingConfig: off,
    });
    const presOn = bandEnergyDb(outOn.clean[0], 3500, 9000, SAMPLE_RATE, 1024, speech.fricMask)
      - bandEnergyDb(speech.clean, 3500, 9000, SAMPLE_RATE, 1024, speech.fricMask);
    const presOff = bandEnergyDb(outOff.clean[0], 3500, 9000, SAMPLE_RATE, 1024, speech.fricMask)
      - bandEnergyDb(speech.clean, 3500, 9000, SAMPLE_RATE, 1024, speech.fricMask);
    // Guard restores the /s/ band by several dB (measured +3.85 dB on this
    // fixture); require at least +2 dB so the test fails if the guard stops
    // firing, without pinning the exact number.
    expect(presOn - presOff).toBeGreaterThan(2);

    const ctlOn = await worker.separate([control.mix], {
      modelIds: ['bsrnn_vocals'], processingConfig: canonical,
    });
    const ctlOff = await worker.separate([control.mix], {
      modelIds: ['bsrnn_vocals'], processingConfig: off,
    });
    const attOn = bandEnergyDb(ctlOn.clean[0], 3500, 9000, SAMPLE_RATE, 1024, control.fricMask)
      - bandEnergyDb(control.mix, 3500, 9000, SAMPLE_RATE, 1024, control.fricMask);
    const attOff = bandEnergyDb(ctlOff.clean[0], 3500, 9000, SAMPLE_RATE, 1024, control.fricMask)
      - bandEnergyDb(control.mix, 3500, 9000, SAMPLE_RATE, 1024, control.fricMask);
    // Control suppression must be identical: the guard must not protect noise.
    expect(Math.abs(attOn - attOff)).toBeLessThan(0.01);
    expect(attOn).toBeLessThan(-5);
  });

  test('guard is deterministic: same input, bit-identical output', async () => {
    const worker = await createMlWorker();
    const fx = fixtures.find((f) => f.id === 'sh-loud-f150');
    const a = await worker.separate([fx.mix], {
      modelIds: ['bsrnn_vocals'], processingConfig: canonical,
    });
    const b = await worker.separate([fx.mix], {
      modelIds: ['bsrnn_vocals'], processingConfig: canonical,
    });
    const ca = a.clean[0];
    const cb = b.clean[0];
    expect(ca.length).toBe(cb.length);
    let maxDiff = 0;
    for (let i = 0; i < ca.length; i++) maxDiff = Math.max(maxDiff, Math.abs(ca[i] - cb[i]));
    expect(maxDiff).toBe(0);
  });
});
