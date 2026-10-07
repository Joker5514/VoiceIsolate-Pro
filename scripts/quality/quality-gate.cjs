#!/usr/bin/env node
'use strict';
/**
 * Audio-quality regression gate (prod:verify step `audio-quality`).
 *
 * Runs the production MLWorker with the shipped ONNX models (WASM, one thread,
 * deterministic) over a fixed subset of the synthetic fixture matrix and
 * checks:
 *   1. hard invariants: finite output, length preserved, silence in → silence
 *      out, no output above full scale;
 *   2. regressions: every pinned metric in quality-baseline.json (SI-SDR,
 *      speech level, noise reduction) must not drop by more than its
 *      toleranceDb.
 *
 *   node scripts/quality/quality-gate.cjs            # check
 *   node scripts/quality/quality-gate.cjs --update   # re-pin after an intended change
 *
 * A re-pin is a reviewed diff of quality-baseline.json, never a silent edit.
 * Fixtures are speech-like synthesis, not recorded speech: they catch
 * regressions in the shipped path; they do not certify absolute quality.
 */
const fs = require('fs');
const path = require('path');
const { createMlWorker } = require('./lib/mlworker-node.cjs');
const { profiles: loadProfiles, GATE_SCENARIOS } = require('./lib/profiles.cjs');
const M = require('./lib/metrics.cjs');
const { scenarios } = require('./scenarios.cjs');

const BASELINE = path.join(__dirname, 'quality-baseline.json');
const SECS = 4;
const DEFAULT_TOLERANCE_DB = 0.5;

async function measureAll() {
  const worker = await createMlWorker();
  const profiles = await loadProfiles();
  const metrics = {};
  const failures = [];
  for (const sc of scenarios(SECS).filter((s) => GATE_SCENARIOS.includes(s.id))) {
    const fx = sc.build();
    for (const p of profiles) {
      const out = await worker.separate([fx.input], p);
      const clean = out.clean[0];
      const key = `${sc.id}/${p.id}`;
      const bad = M.nonFinite(clean) + M.nonFinite(out.noise[0]);
      if (bad) failures.push(`${key}: ${bad} non-finite samples`);
      for (const [name, stem] of [['clean', clean], ['noise', out.noise[0]]]) {
        if (stem.length !== fx.input.length) failures.push(`${key}: ${name} length ${stem.length} != ${fx.input.length}`);
      }
      for (const [name, stem] of [['clean', clean], ['noise', out.noise[0]]]) {
        if (M.peak(stem) > 1) failures.push(`${key}: ${name} peak ${M.peak(stem).toFixed(3)} > 1`);
      }
      if (sc.id === 'silence') {
        if (M.peak(clean) > 1e-6) failures.push(`${key}: silence produced peak ${M.peak(clean)}`);
        continue;
      }
      if (fx.ref) {
        // Noisy scenarios pin the improvement; clean ones pin preservation.
        metrics[`${key}/si-sdr${sc.kind === 'preservation' ? '' : '-delta'}`] = sc.kind === 'preservation'
          ? M.siSdr(clean, fx.ref)
          : M.siSdr(clean, fx.ref) - M.siSdr(fx.input, fx.ref);
        // SI-SDR ignores gain and noise-reduction rewards attenuation, so pin
        // the speech level too: a quieter clean stem must fail.
        metrics[`${key}/speech-level`] = M.rmsDb(clean, fx.active) - M.rmsDb(fx.ref, fx.active);
      } else {
        metrics[`${key}/noise-reduction`] = M.rmsDb(fx.input) - M.rmsDb(clean);
      }
    }
  }
  return { metrics, failures };
}

async function main() {
  const update = process.argv.includes('--update');
  const { metrics, failures } = await measureAll();
  const rounded = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  const base = update ? null : JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const tolerance = Number(base?.toleranceDb) > 0 ? Number(base.toleranceDb) : DEFAULT_TOLERANCE_DB;
  if (update) {
    fs.writeFileSync(BASELINE, `${JSON.stringify({
      note: 'dB; pinned by scripts/quality/quality-gate.cjs --update. Lower is a regression beyond the tolerance.',
      toleranceDb: DEFAULT_TOLERANCE_DB,
      metrics: rounded,
    }, null, 2)}\n`);
    console.log(`[quality] baseline written: ${Object.keys(rounded).length} metrics`);
  } else {
    for (const [k, pinned] of Object.entries(base.metrics)) {
      const now = rounded[k];
      if (now == null) failures.push(`${k}: not measured`);
      else if (now < pinned - tolerance) failures.push(`${k}: ${now} dB < pinned ${pinned} dB - ${tolerance}`);
    }
  }
  for (const [k, v] of Object.entries(rounded)) console.log(`  ${k.padEnd(42)} ${v.toFixed(2)} dB`);
  if (failures.length) {
    console.error(`[quality] FAIL\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('[quality] PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
