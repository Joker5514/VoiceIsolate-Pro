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
 *      toleranceDb;
 *   3. improvement tier: on fixtures tagged improvementExpected, every
 *      scenario/profile pair listed in the baseline's improvementRequired
 *      must keep an SI-SDR delta >= 0 dB (no tolerance). --update lists every
 *      tagged pair that measures >= 0 and refuses to drop a listed pair that
 *      no longer does, so the list only grows. Tagged pairs still below 0 dB
 *      are printed as open gaps on every run.
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
  const improvementKeys = [];
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
        if (sc.improvementExpected) improvementKeys.push(`${key}/si-sdr-delta`);
        metrics[`${key}/si-sdr${sc.kind === 'preservation' ? '' : '-delta'}`] = sc.kind === 'preservation'
          ? M.siSdr(clean, fx.ref)
          : M.siSdr(clean, fx.ref) - M.siSdr(fx.input, fx.ref);
        // SI-SDR ignores gain and noise-reduction rewards attenuation, so pin
        // the speech level too: a quieter clean stem must fail.
        metrics[`${key}/speech-level`] = M.rmsDb(clean, fx.active) - M.rmsDb(fx.ref, fx.active);
        // Fricative onsets (3.5-9 kHz) are where the masks do the most damage
        // (Maximum chain: about -30 dB); aggregate SI-SDR barely sees them.
        if (fx.fricative) {
          metrics[`${key}/fricative-level`] = M.bandEnergyDb(clean, 3500, 9000, 48000, 1024, fx.fricative)
            - M.bandEnergyDb(fx.ref, 3500, 9000, 48000, 1024, fx.fricative);
        }
      } else {
        metrics[`${key}/noise-reduction`] = M.rmsDb(fx.input) - M.rmsDb(clean);
      }
    }
  }
  return { metrics, failures, improvementKeys };
}

async function main() {
  const update = process.argv.includes('--update');
  const { metrics, failures, improvementKeys } = await measureAll();
  const rounded = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  const previous = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
  const base = update ? null : previous;
  const required = new Set(previous?.improvementRequired || []);
  for (const k of required) {
    if (!improvementKeys.includes(k)) failures.push(`${k}: listed in improvementRequired but not a tagged improvement metric`);
    else if (rounded[k] < 0) failures.push(`${k}: ${rounded[k]} dB < 0 dB (improvement tier)`);
  }
  const gaps = improvementKeys.filter((k) => !required.has(k) && rounded[k] < 0);
  const toleranceValue = Number(base?.toleranceDb);
  // A non-finite tolerance (e.g. 1e999 → Infinity) would disable every check.
  const tolerance = Number.isFinite(toleranceValue) && toleranceValue > 0 ? toleranceValue : DEFAULT_TOLERANCE_DB;
  for (const [k, v] of Object.entries(metrics)) {
    if (!Number.isFinite(v)) failures.push(`${k}: non-finite metric ${v}`);
  }
  if (update && failures.length) {
    // Never pin a baseline from a run that broke a hard invariant.
    console.error(`[quality] FAIL: baseline not written\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  if (update) {
    fs.writeFileSync(BASELINE, `${JSON.stringify({
      note: 'dB; pinned by scripts/quality/quality-gate.cjs --update. Lower is a regression beyond the tolerance.',
      toleranceDb: DEFAULT_TOLERANCE_DB,
      improvementNote: 'SI-SDR delta must stay >= 0 dB for these pairs; the list only grows.',
      improvementRequired: improvementKeys.filter((k) => rounded[k] >= 0),
      metrics: rounded,
    }, null, 2)}\n`);
    console.log(`[quality] baseline written: ${Object.keys(rounded).length} metrics`);
  } else {
    // Key sets must match exactly, so a new metric cannot run unpinned.
    for (const k of Object.keys(rounded)) {
      if (!(k in base.metrics)) failures.push(`${k}: measured but not pinned (re-pin with --update)`);
    }
    for (const [k, pinned] of Object.entries(base.metrics)) {
      const now = rounded[k];
      if (now == null) failures.push(`${k}: not measured`);
      else if (now < pinned - tolerance) failures.push(`${k}: ${now} dB < pinned ${pinned} dB - ${tolerance}`);
    }
  }
  for (const [k, v] of Object.entries(rounded)) console.log(`  ${k.padEnd(42)} ${v.toFixed(2)} dB`);
  for (const k of gaps) console.log(`  improvement gap (not yet >= 0 dB): ${k} ${rounded[k].toFixed(2)} dB`);
  if (failures.length) {
    console.error(`[quality] FAIL\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('[quality] PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
