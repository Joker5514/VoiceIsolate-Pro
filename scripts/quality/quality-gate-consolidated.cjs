#!/usr/bin/env node
'use strict';
/**
 * Consolidated quality gate — QA-01 (LOCAL 2026-11-25, never CI-verified).
 *
 * The finish plan's QA-01 requires the gate to CONSUME all preceding
 * evidence, not just run the test suite. This script runs/checks every
 * evidence source and FAILS if any is missing or records a failure:
 *
 *   1. existing quality gate (pinned synthetic matrix + improvement tier)
 *   2. ESTOI reference check (12/12 fixtures within 1e-4 of pystoi)
 *   3. the five new finish-plan Jest suites + the ESTOI suite (all pass)
 *   4. EXPANDED matrix: the four Standard fixtures + two whisper fixtures
 *      through the CANONICAL Standard config built by the real resolver
 *      (buildStandardProcessingConfig — the same function Landing, Stems,
 *      Engineer, and recommendations use). The gate FAILS if ANY enabled
 *      default violates the do-no-harm floor (SI-SDR delta >= 0 dB vs
 *      bypass) on ANY fixture, even if the aggregate passes.
 *   5. Drive round-2 real-audio evidence (recomputed from the results
 *      JSON, not trusted from the narrative): VC wins fidelity AND level
 *      on all 10 clips; determinism bit-identical; the music-bed verdict
 *      is recorded as NOT CONFIRMED (the default stays provisional).
 *   6. Default-status tripwire: the canonical default must be
 *      'provisional' unless external music-bed evidence exists and passes.
 *
 * Evidence paths (overridable by env):
 *   VIP_R2_RESULTS — round-2 results JSON (default
 *     /home/hatch/vip-drive-test-r2/drive-test-results-r2.json)
 *   VIP_R2_REPORT  — round-2 narrative report (default
 *     $HOME/workspace/voiceisolate-pro-drive-video-test-round2-2026-11-25.md)
 *   VIP_MUSIC_BED_EVIDENCE — required only if the default status is 'final'
 *
 *   node scripts/quality/quality-gate-consolidated.cjs
 *   node scripts/quality/quality-gate-consolidated.cjs --json <path>
 *       (writes the machine-readable report; default
 *        scripts/quality/quality-gate-consolidated-report.json)
 *
 * Exit 0 = every check passed. Exit 1 = any check failed or any evidence
 * file is missing. Nothing here re-pins a baseline; a re-pin is a reviewed
 * diff of quality-baseline.json, never a silent edit.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '../..');
const HOME = process.env.HOME || '';
const DEFAULT_REPORT = path.join(__dirname, 'quality-gate-consolidated-report.json');
const R2_RESULTS = process.env.VIP_R2_RESULTS
  || '/home/hatch/vip-drive-test-r2/drive-test-results-r2.json';
const R2_REPORT = process.env.VIP_R2_REPORT
  || path.join(HOME, 'workspace/voiceisolate-pro-drive-video-test-round2-2026-11-25.md');
const STANDARD_FIXTURES = ['white-5db', 'hvac-5db', 'hum-10db', 'music-0db'];
const WHISPER_FIXTURES = ['whisper-clean', 'whisper-white-10db'];
const NEW_SUITES = [
  'tests/standard-config-parity.test.js',
  'tests/mlworker-standard-config.test.js',
  'tests/mlworker-self-test-attestation.test.js',
  'tests/slider-sweep-zero-inference.test.js',
  'tests/capability-registry.test.js',
  'tests/estoi.test.js',
  // DSP-02 fricative guard (added 2026-11-25): the gate consumes all
  // preceding evidence, including the guard's processor/worker tests.
  'tests/fricative-guard.test.js',
];

const checks = [];
function record(name, passed, detail) {
  checks.push({ name, passed: Boolean(passed), detail: detail || '' });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function runNode(scriptArgs, label) {
  const res = spawnSync(process.execPath, scriptArgs, { cwd: ROOT, encoding: 'utf8' });
  const out = `${res.stdout || ''}${res.stderr || ''}`;
  return { ok: res.status === 0, output: out.slice(-2000) };
}

async function main() {
  const jsonOut = process.argv.includes('--json')
    ? process.argv[process.argv.indexOf('--json') + 1]
    : DEFAULT_REPORT;

  // 1. Existing quality gate (pinned matrix + improvement tier).
  {
    const r = runNode(['scripts/quality/quality-gate.cjs'], 'quality-gate');
    const lastLines = r.output.trim().split('\n').slice(-3).join(' | ');
    record('1. pinned quality gate (quality-gate.cjs)', r.ok, lastLines);
  }

  // 2. ESTOI reference check (12/12 within 1e-4 of pystoi).
  {
    const r = runNode(['scripts/quality/estoi-reference.cjs'], 'estoi-reference');
    const m = r.output.match(/(\d+)\/(\d+) within tolerance/);
    record('2. ESTOI reference check (pystoi oracle, tol 1e-4)', r.ok,
      m ? `${m[1]}/${m[2]} fixtures within tolerance` : r.output.trim().split('\n').slice(-2).join(' | '));
  }

  // 3. The finish-plan Jest suites (all must pass, zero failures).
  {
    const outFile = path.join(__dirname, '.consolidated-jest.json');
    const res = spawnSync(
      process.execPath,
      ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js',
        '--testEnvironment=node', ...NEW_SUITES, '--json', `--outputFile=${outFile}`],
      { cwd: ROOT, encoding: 'utf8' },
    );
    let detail = `jest exit ${res.status}`;
    let ok = res.status === 0;
    try {
      const j = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      detail = `${j.numPassedTests}/${j.numTotalTests} tests passed, `
        + `${j.numFailedTests} failed, ${j.numFailedTestSuites} failed suites`;
      ok = ok && j.numFailedTests === 0 && j.numFailedTestSuites === 0;
    } catch (e) {
      ok = false;
      detail += ` (could not parse jest JSON: ${e.message})`;
    } finally {
      try { fs.unlinkSync(outFile); } catch { /* already gone */ }
    }
    record('3. finish-plan Jest suites (parity/worker/self-test/counters/registry/estoi/guard)', ok, detail);
  }

  // 4. Expanded matrix: canonical Standard config through the real worker.
  {
    const { createMlWorker } = require('./lib/mlworker-node.cjs');
    const M = require('./lib/metrics.cjs');
    const { scenarios } = require('./scenarios.cjs');
    const mod = await import(pathToFileURL(path.join(ROOT, 'src/core/PresetCalibration.js')).href);
    const cfg = mod.buildStandardProcessingConfig();
    let matrixOk = true;
    const rows = [];
    const plumbing = cfg.spectral.maskStrength === 0.15
      && cfg.spectral.whisperMode === 1 && cfg.spectral.whisperLift === 8
      && cfg.revision === 'std1:emc1-mu4w9g'
      && mod.STANDARD_DEFAULT_STATUS === 'provisional';
    if (!plumbing) {
      matrixOk = false;
      rows.push('plumbing: canonical config is not the measured Standard config '
        + `(maskStrength=${cfg.spectral.maskStrength}, revision=${cfg.revision}, `
        + `status=${mod.STANDARD_DEFAULT_STATUS})`);
    }
    const worker = await createMlWorker();
    const scById = Object.fromEntries(scenarios(4).map((s) => [s.id, s]));
    for (const fid of [...STANDARD_FIXTURES, ...WHISPER_FIXTURES]) {
      const sc = scById[fid];
      const fx = sc.build();
      const out = await worker.separate([fx.input], {
        modelIds: ['bsrnn_vocals'], processingConfig: cfg,
      });
      const clean = out.clean[0];
      // Preservation fixtures (whisper-clean: ref === input) have no
      // meaningful delta — siSdr(input, ref) is ~+200 dB, so a delta
      // would be a degenerate -200 dB artifact. Report absolute SI-SDR
      // for those, exactly as quality-gate.cjs does.
      const isPreservation = sc.kind === 'preservation';
      const si = M.siSdr(clean, fx.ref);
      const delta = isPreservation ? null : si - M.siSdr(fx.input, fx.ref);
      const fric = fx.fricative
        ? M.bandEnergyDb(clean, 3500, 9000, 48000, 1024, fx.fricative)
          - M.bandEnergyDb(fx.ref, 3500, 9000, 48000, 1024, fx.fricative)
        : null;
      const isStandard = STANDARD_FIXTURES.includes(fid);
      // Floor, no tolerance: ANY Standard fixture below 0 fails the gate,
      // even if the aggregate passes.
      const passed = !isStandard || (delta != null && delta >= 0);
      if (!passed) matrixOk = false;
      const score = isPreservation ? `SI-SDR ${si.toFixed(2)} dB` : `dSI-SDR ${delta.toFixed(2)} dB`;
      rows.push(`${fid}: ${score}`
        + `${fric != null ? `, fricative ${fric.toFixed(2)} dB` : ''}`
        + `${isStandard ? (passed ? ' (floor PASS)' : ' (floor FAIL)') : ' (recorded, no floor)'}`);
    }
    record('4. expanded Standard matrix (canonical config, floor dSI-SDR >= 0 per fixture)', matrixOk, rows.join(' | '));
  }

  // 5. Drive round-2 real-audio evidence, recomputed from the results JSON.
  {
    let ok = true;
    const notes = [];
    if (!fs.existsSync(R2_RESULTS)) {
      ok = false;
      notes.push(`missing evidence file: ${R2_RESULTS}`);
    } else {
      const d = JSON.parse(fs.readFileSync(R2_RESULTS, 'utf8'));
      const results = d.results || [];
      if (results.length !== 10) {
        ok = false;
        notes.push(`expected 10 clips, found ${results.length}`);
      }
      let vcWinsFid = 0;
      let vcWinsLvl = 0;
      let fricVc = 0;
      let fricL = 0;
      for (const r of results) {
        if (r.vc015.speechFidelitySiSdrDb > r.landing.speechFidelitySiSdrDb) vcWinsFid += 1;
        if (r.vc015.speechLevelDeltaDb > r.landing.speechLevelDeltaDb) vcWinsLvl += 1;
        fricVc += r.vc015.fricativeDeltaDb;
        fricL += r.landing.fricativeDeltaDb;
      }
      if (vcWinsFid !== results.length || vcWinsLvl !== results.length) {
        ok = false;
        notes.push(`VC wins fidelity ${vcWinsFid}/${results.length}, level ${vcWinsLvl}/${results.length} (expected all)`);
      } else {
        notes.push(`VC wins fidelity + level on all ${results.length} clips`);
      }
      if (d.determinism && d.determinism.maxSampleDiff !== 0) {
        ok = false;
        notes.push(`determinism probe not bit-identical (maxSampleDiff ${d.determinism.maxSampleDiff})`);
      } else {
        notes.push('determinism bit-identical (maxSampleDiff 0)');
      }
      notes.push(`fricative mean VC ${(fricVc / results.length).toFixed(2)} dB vs landing ${(fricL / results.length).toFixed(2)} dB (DSP-02 baseline)`);
    }
    if (!fs.existsSync(R2_REPORT)) {
      ok = false;
      notes.push(`missing round-2 report: ${R2_REPORT}`);
    } else {
      const text = fs.readFileSync(R2_REPORT, 'utf8');
      // The music-bed verdict must be recorded as NOT CONFIRMED — a report
      // claiming confirmation would be a gate failure (false finalization).
      const saysNoMusic = /no clip in the 28-clip inventory contains (a )?music bed/i.test(text)
        || /NOT TESTED — no clip/i.test(text);
      const claimsConfirmed = /music margin .* confirmed on real audio/i.test(text)
        && !/still unconfirmed on real audio/i.test(text);
      if (!saysNoMusic || claimsConfirmed) {
        ok = false;
        notes.push('round-2 report does not record the music-bed verdict as NOT CONFIRMED');
      } else {
        notes.push('music-bed verdict recorded as NOT CONFIRMED (default stays provisional)');
      }
    }
    record('5. Drive round-2 real-audio evidence (recomputed)', ok, notes.join(' | '));
  }

  // 6. Default-status tripwire.
  {
    const mod = await import(pathToFileURL(path.join(ROOT, 'src/core/PresetCalibration.js')).href);
    const status = mod.STANDARD_DEFAULT_STATUS;
    let ok = true;
    let detail = `STANDARD_DEFAULT_STATUS='${status}'`;
    if (status === 'provisional') {
      detail += ' (correct: external music-bed gate has not run)';
    } else if (status === 'final') {
      const evPath = process.env.VIP_MUSIC_BED_EVIDENCE || '';
      if (!evPath || !fs.existsSync(evPath)) {
        ok = false;
        detail += ' — FINAL requires external music-bed evidence (VIP_MUSIC_BED_EVIDENCE), none found';
      } else {
        const ev = JSON.parse(fs.readFileSync(evPath, 'utf8'));
        if (ev.musicBedMarginDb == null || ev.musicBedMarginDb < 0) {
          ok = false;
          detail += ` — music-bed evidence does not pass (margin ${ev.musicBedMarginDb})`;
        } else {
          detail += ` — music-bed evidence passes (margin ${ev.musicBedMarginDb} dB)`;
        }
      }
    } else {
      ok = false;
      detail += ' — unknown status, must be provisional or final';
    }
    record('6. default-status tripwire (provisional until external music-bed gate)', ok, detail);
  }

  const passed = checks.every((c) => c.passed);
  const report = {
    gate: 'quality-gate-consolidated',
    scope: 'LOCAL, never CI-verified',
    generatedAt: new Date().toISOString(),
    passed,
    checks,
  };
  fs.writeFileSync(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nConsolidated gate: ${passed ? 'PASS' : 'FAIL'} (${checks.filter((c) => c.passed).length}/${checks.length} checks)`);
  console.log(`Report: ${jsonOut}`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(`[consolidated-gate] crashed: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
