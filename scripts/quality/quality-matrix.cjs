#!/usr/bin/env node
'use strict';
/**
 * Audio-quality matrix: runs the production MLWorker (real ONNX models, WASM)
 * over deterministic synthetic fixtures and prints objective metrics.
 *
 *   node scripts/quality/quality-matrix.cjs [--secs 6] [--json out.json] [--only id,id]
 *
 * Profiles: landing (bsrnn_vocals, no Engineer snapshot), engineer (registry
 * defaults through the real calibration + ParameterSchema snapshot), maximum
 * (bsrnn_vocals + rnnoise fused). Metrics are explained in docs/guides/AUDIO_QUALITY.md.
 */
const fs = require('fs');
const { createMlWorker } = require('./lib/mlworker-node.cjs');
const { profiles: loadProfiles } = require('./lib/profiles.cjs');
const M = require('./lib/metrics.cjs');
const { scenarios } = require('./scenarios.cjs');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

/** Metrics for one (scenario, output) pair. */
function measure(fx, out) {
  const clean = out.clean[0];
  const noise = out.noise[0];
  const r = {
    nonFinite: M.nonFinite(clean) + M.nonFinite(noise),
    peakOut: M.peak(clean),
    dcOut: M.dcOffset(clean),
  };
  if (fx.ref) {
    r.siSdrIn = M.siSdr(fx.input, fx.ref);
    r.siSdrOut = M.siSdr(clean, fx.ref);
    r.siSdrDelta = r.siSdrOut - r.siSdrIn;
    r.levelDeltaDb = M.rmsDb(clean, fx.active) - M.rmsDb(fx.ref, fx.active);
    r.hfDeltaDb = M.bandEnergyDb(clean, 4000, 12000, 48000, 2048, fx.active)
      - M.bandEnergyDb(fx.ref, 4000, 12000, 48000, 2048, fx.active);
    if (fx.fricative) {
      r.fricDeltaDb = M.bandEnergyDb(clean, 3500, 9000, 48000, 1024, fx.fricative)
        - M.bandEnergyDb(fx.ref, 3500, 9000, 48000, 1024, fx.fricative);
    }
    if (fx.active) {
      const gap = fx.active.map((a) => (a ? 0 : 1));
      r.gapLeakDb = M.rmsDb(clean, gap) - M.rmsDb(fx.input, gap);
    }
  } else {
    r.inDb = M.rmsDb(fx.input);
    r.outDb = M.rmsDb(clean);
    r.reductionDb = r.inDb - r.outDb;
  }
  return r;
}

async function main() {
  const secs = Number(arg('secs', 6));
  if (!Number.isFinite(secs) || secs <= 0) throw new Error(`--secs must be a positive number (got ${arg('secs', 6)})`);
  const only = arg('only', '');
  const all = scenarios(secs);
  const wanted = only ? only.split(',').filter(Boolean) : [];
  const unknown = wanted.filter((id) => !all.some((s) => s.id === id));
  if (unknown.length) throw new Error(`unknown --only scenario(s): ${unknown.join(', ')}`);
  const worker = await createMlWorker();
  const profiles = await loadProfiles();
  const list = all.filter((s) => !wanted.length || wanted.includes(s.id));
  const rows = [];
  for (const sc of list) {
    const fx = sc.build();
    for (const p of profiles) {
      const out = await worker.separate([fx.input], p);
      const m = measure(fx, out);
      rows.push({ scenario: sc.id, kind: sc.kind, profile: p.id, rtf: out.elapsedMs / 1000 / secs, ...m });
    }
  }
  const f = (v, d = 1) => (v == null || Number.isNaN(v) ? '-' : v.toFixed(d));
  console.log(`backend=${worker.backend} secs=${secs} node=${process.version}`);
  console.log('| scenario | profile | SI-SDR in | SI-SDR out | delta | level dB | HF 4-12k dB | fricative dB | gap leak dB | reduction dB | peak | RTF |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.scenario} | ${r.profile} | ${f(r.siSdrIn)} | ${f(r.siSdrOut)} | ${f(r.siSdrDelta)} | ${f(r.levelDeltaDb)} | ${f(r.hfDeltaDb)} | ${f(r.fricDeltaDb)} | ${f(r.gapLeakDb)} | ${f(r.reductionDb)} | ${f(r.peakOut, 3)} | ${f(r.rtf, 3)} |`);
    if (r.nonFinite) console.log(`  !! ${r.nonFinite} non-finite samples`);
  }
  const json = arg('json', '');
  if (json) fs.writeFileSync(json, JSON.stringify({ secs, backend: worker.backend, rows }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
