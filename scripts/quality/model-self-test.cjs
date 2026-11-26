#!/usr/bin/env node
'use strict';
/**
 * Model self-test runner (LM Arena fix session 3) — LOCAL (never CI-verified).
 * Scratch script: uncommitted, do not commit, do not ship.
 *
 * Runs each pinned model on a fixed deterministic fixture through the
 * production MLWorker (Node/WASM) and compares the output against the
 * `selfTest` pin in src/core/ModelManifest.js:
 *
 *   fixture: scenarios.cjs white-5db (seed 41), first 1 s (48000 samples)
 *   pin:     selfTest.expectedOutputSha256 = sha256 of the clean-output
 *            Float32Array bytes; selfTest.wasmMaxAbsDiff = run-to-run
 *            tolerance on this provider (measured; two deterministic runs).
 *
 * No webgpu tolerance is pinned: this VM has no WebGPU provider, so a
 * WebGPU reference value cannot be measured here. The pin is the WASM
 * reference; a WebGPU run must be measured on a WebGPU host before a
 * webgpuMaxAbsDiff is added — do NOT invent one.
 *
 *   node scripts/quality/model-self-test.cjs --measure   # print pins
 *   node scripts/quality/model-self-test.cjs             # check pins
 */
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { createMlWorker } = require('./lib/mlworker-node.cjs');
const { scenarios } = require('./scenarios.cjs');

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ID = 'selftest-white-1s-v1';
const FIXTURE_SECONDS = 1;
const MODEL_IDS = ['bsrnn_vocals', 'rnnoise', 'deepfilternet3'];

function sha256Float32(arr) {
  return crypto.createHash('sha256')
    .update(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength))
    .digest('hex');
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

async function main() {
  const measure = process.argv.includes('--measure');
  const worker = await createMlWorker();
  console.log(`[selftest] MLWorker backend: ${worker.backend}`);
  const manifestMod = await import(pathToFileURL(path.join(ROOT, 'src/core/ModelManifest.js')).href);
  const manifest = manifestMod.MODEL_MANIFEST;

  const sc = scenarios(4).find((s) => s.id === 'white-5db');
  const fx = sc.build();
  const fixture = fx.input.slice(0, FIXTURE_SECONDS * 48000);
  console.log(`[selftest] fixture ${FIXTURE_ID}: white-5db first ${FIXTURE_SECONDS}s, ${fixture.length} samples`);

  let failures = 0;
  for (const id of MODEL_IDS) {
    const entry = manifest[id];
    if (!entry) { console.log(`[selftest] ${id}: MISSING from manifest`); failures++; continue; }
    const out1 = await worker.separate([fixture], { modelIds: [id], processingConfig: null });
    const out2 = await worker.separate([fixture], { modelIds: [id], processingConfig: null });
    const clean1 = out1.clean[0];
    const clean2 = out2.clean[0];
    const hash = sha256Float32(clean1);
    const diff = maxAbsDiff(clean1, clean2);
    if (measure) {
      console.log(`[selftest] ${id}: expectedOutputSha256=${hash} wasmMaxAbsDiff(measured run-to-run)=${diff} peak=${Math.max(...clean1.map(Math.abs)).toExponential(2)} len=${clean1.length}`);
      continue;
    }
    const pin = entry.selfTest;
    if (!pin || pin.fixtureId !== FIXTURE_ID || !pin.expectedOutputSha256) {
      console.log(`[selftest] ${id}: NO PIN in manifest (fixtureId/expectedOutputSha256 missing)`);
      failures++;
      continue;
    }
    const hashOk = hash === pin.expectedOutputSha256;
    const diffOk = diff <= (pin.wasmMaxAbsDiff ?? 0);
    console.log(`[selftest] ${id}: hash ${hashOk ? 'MATCH' : `MISMATCH (got ${hash}, want ${pin.expectedOutputSha256})`} | run-to-run maxAbsDiff ${diff.toExponential(2)} <= ${pin.wasmMaxAbsDiff} ${diffOk ? 'OK' : 'FAIL'}`);
    if (!hashOk || !diffOk) failures++;
  }
  if (!measure) {
    console.log(failures === 0 ? '[selftest] ALL PASS' : `[selftest] ${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
