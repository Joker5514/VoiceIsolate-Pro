'use strict';

/**
 * Engineer stereo re-expansion (audit 2026-10-12, N02). The ML path separates
 * the mid channel once and rebuilds L/R. The old per-sample L·clean/mid ratio,
 * clamped to [0, 1.35], zeroed every sample where the masked clean and the
 * mixture disagree in sign. The real method is lifted out of app.js and run.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');

function extractMethod(src, signature) {
  const start = src.indexOf(`\n  ${signature}`);
  if (start < 0) throw new Error(`missing ${signature}`);
  // The signature ends with its body's '{'; `opts = {}` precedes it.
  let i = start + 3 + signature.length - 1;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

let app;

beforeAll(async () => {
  const { processInChunks } = await import(
    pathToFileURL(path.join(__dirname, '../src/pipeline/ui-yield.js')).href
  );
  const body = extractMethod(appSrc, 'async _expandMonoCleanToStereo(cleanMono, mid, left, right, opts = {}) {');
  const Cls = new Function('processInChunks', `return class {
    _processAbortSignal() { return null; }
    _postMlChunkSamples() { return 4096; }
    ${body}
  }`)(processInChunks);
  app = new Cls();
});

const N = 48000;
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
}
function sisdr(est, ref) {
  let dot = 0; let rr = 0;
  for (let i = 2048; i < N - 2048; i++) { dot += est[i] * ref[i]; rr += ref[i] * ref[i]; }
  const a = dot / rr; let num = 0; let den = 0;
  for (let i = 2048; i < N - 2048; i++) { const t = a * ref[i]; const e = est[i] - t; num += t * t; den += e * e; }
  return 10 * Math.log10(num / den);
}

test('L = R input returns the separated mid on both channels, sample for sample', async () => {
  const r = rng(3);
  const x = Float32Array.from({ length: N }, (_, i) => 0.2 * Math.sin(i / 9) + 0.05 * r());
  // A clean estimate that disagrees in sign with the mixture on many samples.
  const clean = Float32Array.from({ length: N }, (_, i) => 0.2 * Math.sin(i / 9) + 0.01 * r());
  const [L, R] = await app._expandMonoCleanToStereo(clean, x, x, x);
  let maxErr = 0;
  for (let i = 0; i < N; i++) maxErr = Math.max(maxErr, Math.abs(L[i] - clean[i]), Math.abs(R[i] - clean[i]));
  expect(maxErr).toBe(0);
});

test('a panned voice keeps its image and gains over the per-sample ratio', async () => {
  const r = rng(7);
  const voice = Float32Array.from({ length: N }, (_, i) => 0.15 * Math.sin((2 * Math.PI * 180 * i) / 48000) * (0.6 + 0.4 * Math.sin(i / 4000)));
  const sL = voice.map((v) => 1.4 * v); const sR = voice.map((v) => 0.6 * v);
  const L = sL.map((v) => v + 0.02 * r()); const R = sR.map((v) => v + 0.02 * r());
  const mid = L.map((v, i) => 0.5 * (v + R[i]));
  const clean = Float32Array.from({ length: N }, (_, i) => 0.5 * (sL[i] + sR[i]) + 0.004 * r());
  const [oL, oR] = await app._expandMonoCleanToStereo(clean, mid, L, R);
  for (let i = 0; i < N; i++) expect(Number.isFinite(oL[i]) && Number.isFinite(oR[i])).toBe(true);
  // The old ratio on the same inputs, for comparison.
  const old = (ch) => ch.map((v, i) => { let g = Math.abs(mid[i]) > 1e-8 ? clean[i] / mid[i] : 0; g = g < 0 ? 0 : Math.min(g, 1.35); return v * g; });
  expect(sisdr(oL, sL)).toBeGreaterThan(sisdr(old(L), sL));
  expect(sisdr(oR, sR)).toBeGreaterThan(sisdr(old(R), sR));
  expect(sisdr(oL, sL)).toBeGreaterThan(sisdr(L, sL));
});
