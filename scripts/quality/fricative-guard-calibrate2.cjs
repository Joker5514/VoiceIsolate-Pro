#!/usr/bin/env node
/**
 * DSP-02 guard calibration, part 2 (LOCAL 2026-11-25).
 *
 * Drives every fricative fixture's MIX through the real engineer frame
 * processor (worker geometry: N=4096, hop=1024, Hann window) and logs the
 * per-frame guard diagnostics during annotated fricative frames, vowel
 * frames, and control frames. Question: does the processor's mean
 * noiseRatio in the fricative HF band separate strong sibilants (/s/, high
 * band SNR) from weak fricatives (/th/, band dominated by the white-noise
 * interferer)? If it does, the guard blend can be scaled by it so weak
 * fricatives are not over-restored (band-energy overshoot on /f/ /v/
 * /th/ /dh/ in the first guard measurement).
 *
 * Usage: node scripts/quality/fricative-guard-calibrate2.cjs
 * (runs in-repo; prints a per-fixture table, no files written)
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

const { buildFricativeFixtures } = require('./fricative-fixtures.cjs');
const { buildStandardProcessingConfig } = require(
  path.join(ROOT, 'src/core/PresetCalibration.js'),
);

const N = 4096;
const HOP = 1024;
const SAMPLE_RATE = 48000;

function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}
const WIN = hannWindow(N);

// Minimal forward DFT magnitude per bin via the repo's fft (real input).
const { fft } = require('./lib/metrics.cjs');

function frameMags(x, start) {
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const s = start + i;
    const v = s >= 0 && s < x.length ? x[s] * WIN[i] : 0;
    re[i] = v;
  }
  fft(re, im);
  const mags = new Float32Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) mags[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
  return mags;
}

function main() {
  // Load the real processor in a vm sandbox (same shape as mlworker-node).
  const sandbox = { console, Math, Object, Array, Float32Array, Float64Array, Uint8Array, Number, JSON, Error, TypeError };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'src/workers/EngineerSpectralControls.js'), 'utf8'),
    sandbox, { filename: 'EngineerSpectralControls.js' },
  );
  const config = buildStandardProcessingConfig();
  const fixtures = buildFricativeFixtures();

  console.log('fixture              | fric frames: conf hfRatio peak nrHf | vowel frames: conf nrHf | control: conf nrHf');
  for (const fx of fixtures) {
    const proc = sandbox.self.createEngineerFrameProcessor(config, {
      bins: N / 2 + 1, fftSize: N, hop: HOP, sampleRate: SAMPLE_RATE,
    });
    if (!proc) { console.log(`${fx.id} processor null`); continue; }
    const nFrames = Math.floor((fx.mix.length - N) / HOP) + 1;
    const buckets = { fric: [], vowel: [], other: [] };
    for (let f = 0; f < nFrames; f++) {
      const start = f * HOP;
      const mags = frameMags(fx.mix, start);
      // applyFrame needs re/im arrays sized N; magnitudes suffice for the
      // guard diagnostics (it reads sourceMagnitude + frameMag from re/im).
      const re = new Float32Array(N);
      const im = new Float32Array(N);
      for (let k = 0; k <= N / 2; k++) { re[k] = mags[k]; }
      proc.applyFrame(re, im, mags, 0, false);
      const d = proc.getGuardDiagnostics();
      const center = start + N / 2;
      let bucket = 'other';
      if (fx.kind === 'speech') {
        if (fx.fricMask[center]) bucket = 'fric';
        else if (fx.speechMask[center]) bucket = 'vowel';
      } else {
        bucket = 'fric'; // whole control is the "event"
      }
      buckets[bucket].push(d);
    }
    const mean = (rows, key) => rows.length
      ? (rows.reduce((a, r) => a + r[key], 0) / rows.length).toFixed(3)
      : '  -  ';
    const fric = buckets.fric;
    const vowel = buckets.vowel;
    console.log(
      `${fx.id.padEnd(20)} | fric n=${String(fric.length).padStart(2)}: conf ${mean(fric, 'confidence')} hfR ${mean(fric, 'hfRatio')} peak ${mean(fric, 'peakiness')} nrHf ${mean(fric, 'meanNoiseRatioHf')} | vowel: conf ${mean(vowel, 'confidence')} nrHf ${mean(vowel, 'meanNoiseRatioHf')}`,
    );
  }
}

main();
