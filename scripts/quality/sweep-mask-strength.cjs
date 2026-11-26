#!/usr/bin/env node
'use strict';
/**
 * Mask-strength sweep (LM Arena fix session 1) — LOCAL (never CI-verified).
 * Scratch script: uncommitted, do not commit, do not ship.
 *
 * Runs the Voice Clarity preset (with the session-4 changes in place:
 * whisperMode 1, whisperLift 8, gateThresh −58) over the four Standard
 * fixtures plus the two whisper fixtures, at each s in the grid, and picks
 * the largest s passing all four Standard fixtures at SI-SDR delta ≥ 0 dB
 * (no tolerance). Synthetic fixtures only; no personal audio.
 *
 *   node scripts/quality/sweep-mask-strength.cjs [--json <path>]
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createMlWorker } = require('./lib/mlworker-node.cjs');
const { engineerConfig } = require('./lib/engineer-config.cjs');
const M = require('./lib/metrics.cjs');
const { scenarios } = require('./scenarios.cjs');

const SECS = 4;
const SR = 48000;
const ROOT = path.resolve(__dirname, '../..');
const GRID = [1.0, 0.75, 0.5, 0.35, 0.25, 0.15];
const STANDARD = ['white-5db', 'hvac-5db', 'hum-10db', 'music-0db'];
const WHISPER = ['whisper-clean', 'whisper-white-10db'];
const FIXTURES = [...STANDARD, ...WHISPER];

function fmt(v, d = 2) { return Number.isFinite(v) ? v.toFixed(d) : String(v); }

async function presetOverrides(name) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/core/PresetCalibration.js')).href);
  const preset = mod.CALIBRATED_ENGINEER_PRESETS[name];
  if (!preset) throw new Error(`preset not found: ${name}`);
  const out = {};
  for (const [k, v] of Object.entries(preset)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

async function main() {
  const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
  const worker = await createMlWorker();
  console.log(`[sweep] MLWorker backend: ${worker.backend}`);
  const allSc = scenarios(SECS);
  const scById = Object.fromEntries(allSc.map((s) => [s.id, s]));
  const base = await presetOverrides('Voice Clarity');
  console.log(`[sweep] Voice Clarity base overrides: whisperMode=${base.whisperMode} whisperLift=${base.whisperLift} gateThresh=${base.gateThresh} maskStrength=${base.maskStrength}`);

  const rows = [];
  for (const s of GRID) {
    const cfg = await engineerConfig({ ...base, maskStrength: s });
    if (cfg.spectral.maskStrength !== s) {
      throw new Error(`plumbing failure: spectral.maskStrength is ${cfg.spectral.maskStrength}, expected ${s} — the preset value is not reaching the worker`);
    }
    for (const fid of FIXTURES) {
      const sc = scById[fid];
      const fx = sc.build();
      const out = await worker.separate([fx.input], { modelIds: ['bsrnn_vocals'], processingConfig: cfg });
      const clean = out.clean[0];
      const si = M.siSdr(clean, fx.ref);
      const d = sc.kind !== 'preservation' ? si - M.siSdr(fx.input, fx.ref) : null;
      const row = {
        s, fixture: fid, kind: sc.kind,
        siSdr: si, siSdrDelta: d,
        speechLevel: M.rmsDb(clean, fx.active) - M.rmsDb(fx.ref, fx.active),
        fricativeLevel: fx.fricative
          ? M.bandEnergyDb(clean, 3500, 9000, 48000, 1024, fx.fricative) - M.bandEnergyDb(fx.ref, 3500, 9000, 48000, 1024, fx.fricative)
          : null,
      };
      rows.push(row);
      const score = d != null ? `dSI ${fmt(d)}` : `SI ${fmt(si)}`;
      console.log(`  s=${s.toFixed(2)}  ${fid.padEnd(18)} ${score} | speech-lvl ${fmt(row.speechLevel)} | fric ${row.fricativeLevel != null ? fmt(row.fricativeLevel) : 'n/a'}`);
    }
  }

  // Pick the largest s passing all four Standard fixtures at ΔSI-SDR ≥ 0 dB.
  let winner = null;
  for (const s of GRID) {
    const std = rows.filter((r) => r.s === s && STANDARD.includes(r.fixture));
    const pass = std.every((r) => r.siSdrDelta != null && r.siSdrDelta >= 0);
    console.log(`[sweep] s=${s.toFixed(2)}: Standard ${pass ? 'PASS' : 'FAIL'} (${std.map((r) => `${r.fixture.split('-')[0]} ${fmt(r.siSdrDelta)}`).join(', ')})`);
    if (pass && winner === null) winner = s;
  }
  console.log(`[sweep] WINNER: ${winner === null ? 'NONE — no s passes all four Standard fixtures' : `s=${winner} (largest passing)`}`);
  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify({ label: 'LOCAL — never CI-verified', grid: GRID, winner, rows }, null, 2));
    console.log(`[sweep] results written to ${jsonOut}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
