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
 *   2. regressions: every pinned metric in quality-baseline.json must not drop
 *      by more than TOLERANCE_DB.
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
const { engineerConfig } = require('./lib/engineer-config.cjs');
const M = require('./lib/metrics.cjs');
const { scenarios } = require('./scenarios.cjs');

const BASELINE = path.join(__dirname, 'quality-baseline.json');
const SECS = 4;
const TOLERANCE_DB = 0.5;
const GATE_SCENARIOS = [
  'clean-speech', 'white-5db', 'hvac-5db', 'hum-10db', 'music-0db',
  'whisper-clean', 'whisper-white-10db', 'silence', 'noise-only',
];

async function measureAll() {
  const worker = await createMlWorker();
  const profiles = [
    { id: 'landing', modelIds: ['bsrnn_vocals'], processingConfig: null },
    { id: 'engineer', modelIds: ['bsrnn_vocals'], processingConfig: await engineerConfig() },
    { id: 'maximum', modelIds: ['bsrnn_vocals', 'rnnoise'], processingConfig: null },
  ];
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
      if (clean.length !== fx.input.length) failures.push(`${key}: length ${clean.length} != ${fx.input.length}`);
      if (M.peak(clean) > 1) failures.push(`${key}: output peak ${M.peak(clean).toFixed(3)} > 1`);
      if (sc.id === 'silence') {
        if (M.peak(clean) > 1e-6) failures.push(`${key}: silence produced peak ${M.peak(clean)}`);
        continue;
      }
      if (fx.ref) {
        // Noisy scenarios pin the improvement; clean ones pin preservation.
        metrics[`${key}/si-sdr${sc.kind === 'preservation' ? '' : '-delta'}`] = sc.kind === 'preservation'
          ? M.siSdr(clean, fx.ref)
          : M.siSdr(clean, fx.ref) - M.siSdr(fx.input, fx.ref);
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
  if (update) {
    fs.writeFileSync(BASELINE, `${JSON.stringify({
      note: 'dB; pinned by scripts/quality/quality-gate.cjs --update. Lower is a regression beyond the tolerance.',
      toleranceDb: TOLERANCE_DB,
      metrics: rounded,
    }, null, 2)}\n`);
    console.log(`[quality] baseline written: ${Object.keys(rounded).length} metrics`);
  } else {
    const base = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    for (const [k, pinned] of Object.entries(base.metrics)) {
      const now = rounded[k];
      if (now == null) failures.push(`${k}: not measured`);
      else if (now < pinned - TOLERANCE_DB) failures.push(`${k}: ${now} dB < pinned ${pinned} dB - ${TOLERANCE_DB}`);
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
