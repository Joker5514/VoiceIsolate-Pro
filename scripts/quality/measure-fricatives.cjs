#!/usr/bin/env node
'use strict';
/**
 * DSP-02 fricative measurement (LOCAL 2026-11-25).
 *
 * Runs the fricative fixture set (scripts/quality/fricative-fixtures.cjs)
 * through the production MLWorker + shipped bsrnn_vocals.onnx with the
 * canonical Standard config, and measures fricatives SEPARATELY from
 * overall speech level:
 *   - fricative-band preservation (3.5-9 kHz energy, out vs clean ref,
 *     on the annotated fricative samples)
 *   - fricative segment SI-SDR (out vs ref, fricative samples only)
 *   - ESTOI (clean reference exists for every fixture)
 *   - speech-band level change (300-3400 Hz, vowel samples)
 *   - overall SI-SDR delta vs the noisy mix
 *   - controls: attenuation of non-speech HF energy (must stay suppressed
 *     — a guard that protects the controls is over-protecting)
 *
 * Ablation variants (via the harness patchSource — measurement only, no
 * product change) localize where the fricative loss happens:
 *   full     — the shipped chain (mask + HfPostFilter + Engineer processor)
 *   no-hf    — HfPostFilter disabled
 *   no-eng   — Engineer frame processor disabled
 *   neither  — both disabled (mask alone)
 *
 *   node scripts/quality/measure-fricatives.cjs [--variant full|no-hf|no-eng|neither|all]
 *     [--fixtures <id,...>|all] [--json <path>] [--config <canonical|landing|s1>]
 *     [--guard <on|off>]
 *
 * --config s1 runs the same fixtures with maskStrength 1 (the pre-sweep
 * default) to show the s=0.15 improvement on the same set. --guard off
 * hand-builds the canonical config with fricativeGuard: 0 (the builder
 * never emits the id; sanitize defaults it to 1 = on).
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createMlWorker } = require('./lib/mlworker-node.cjs');
const M = require('./lib/metrics.cjs');
const { buildFricativeFixtures } = require('./fricative-fixtures.cjs');

const ROOT = path.resolve(__dirname, '../..');

function segSiSdr(out, ref, from, to) {
  return M.siSdr(out.subarray(from, to), ref.subarray(from, to));
}

const PATCHES = {
  full: null,
  'no-hf': (code) => code.replace(
    "typeof self.createHfPostFilter === 'function'", 'false',
  ),
  'no-eng': (code) => code.replace(
    "typeof self.createEngineerFrameProcessor === 'function'", 'false',
  ),
  neither: (code) => code
    .replace("typeof self.createHfPostFilter === 'function'", 'false')
    .replace("typeof self.createEngineerFrameProcessor === 'function'", 'false'),
};

async function main() {
  const args = process.argv.slice(2);
  const variantArg = args.includes('--variant') ? args[args.indexOf('--variant') + 1] : 'full';
  const variants = variantArg === 'all' ? ['full', 'no-hf', 'no-eng', 'neither'] : [variantArg];
  const fixturesArg = args.includes('--fixtures') ? args[args.indexOf('--fixtures') + 1] : 'all';
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
  const configArg = args.includes('--config') ? args[args.indexOf('--config') + 1] : 'canonical';
  const guardArg = args.includes('--guard') ? args[args.indexOf('--guard') + 1] : 'on';

  const mod = await import(pathToFileURL(path.join(ROOT, 'src/core/PresetCalibration.js')).href);
  const Schema = await import(pathToFileURL(path.join(ROOT, 'src/core/ParameterSchema.js')).href);
  let config;
  let configLabel;
  if (configArg === 'canonical') {
    config = mod.buildStandardProcessingConfig();
    configLabel = `canonical ${config.revision}`;
  } else if (configArg === 'landing') {
    config = null;
    configLabel = 'landing (null config, s=1)';
  } else if (configArg === 's1') {
    config = Schema.buildMlProcessingConfig({});
    configLabel = `plain s=1 ${config.revision}`;
  } else {
    throw new Error(`unknown --config ${configArg}`);
  }
  // DSP-02: guard-off comparison. The builder never emits fricativeGuard
  // (sanitize defaults it to 1 = on), so the off config is hand-built from
  // the canonical one. The worker's validateStandardBlock only checks the
  // three worker keys, so the canonical claim still validates.
  if (guardArg === 'off' && config) {
    config = {
      ...config,
      spectral: { ...config.spectral, fricativeGuard: 0 },
      revision: `${config.revision}+noguard`,
    };
    configLabel += ' guard=off';
  } else if (guardArg === 'off') {
    throw new Error('--guard off needs a config (canonical or s1), not landing');
  } else if (guardArg !== 'on') {
    throw new Error(`unknown --guard ${guardArg}`);
  }

  const allFixtures = buildFricativeFixtures();
  const fixtures = fixturesArg === 'all'
    ? allFixtures
    : allFixtures.filter((f) => fixturesArg.split(',').includes(f.id));
  if (fixtures.length === 0) throw new Error('no fixtures selected');

  const results = {};
  for (const variant of variants) {
    const patch = PATCHES[variant];
    if (variantArg !== 'all' && !patch && variant !== 'full') throw new Error(`unknown --variant ${variant}`);
    const worker = await createMlWorker(patch ? { patchSource: patch } : {});
    console.log(`[fric] variant=${variant} config=${configLabel} backend=${worker.backend} fixtures=${fixtures.length}`);
    const rows = [];
    for (const fx of fixtures) {
      const out = await worker.separate([fx.mix], {
        modelIds: ['bsrnn_vocals'], processingConfig: config,
      });
      const clean = out.clean[0];
      const [fFrom, fTo] = fx.fricSamples;
      if (fx.kind === 'speech') {
        const fricPres = M.bandEnergyDb(clean, 3500, 9000, 48000, 1024, fx.fricMask)
          - M.bandEnergyDb(fx.clean, 3500, 9000, 48000, 1024, fx.fricMask);
        // Speech-band level on vowel samples only (fricative mask off).
        const vowelMask = new Uint8Array(fx.clean.length);
        for (let i = 0; i < vowelMask.length; i++) vowelMask[i] = fx.speechMask[i] && !fx.fricMask[i] ? 1 : 0;
        const speechBand = M.bandEnergyDb(clean, 300, 3400, 48000, 1024, vowelMask)
          - M.bandEnergyDb(fx.clean, 300, 3400, 48000, 1024, vowelMask);
        const row = {
          id: fx.id, phoneme: fx.phoneme, level: fx.level, f0: fx.f0, kind: 'speech',
          fricPreservationDb: fricPres,
          fricSegmentSiSdrDb: segSiSdr(clean, fx.clean, fFrom, fTo),
          estoi: M.estoi(fx.clean, clean, 48000),
          speechBandDeltaDb: speechBand,
          overallSiSdrDeltaDb: M.siSdr(clean, fx.clean) - M.siSdr(fx.mix, fx.clean),
        };
        rows.push(row);
        console.log(`  ${fx.id.padEnd(16)} fric ${row.fricPreservationDb.toFixed(2)} dB | segSI ${row.fricSegmentSiSdrDb.toFixed(2)} | ESTOI ${row.estoi.toFixed(3)} | speech-band ${row.speechBandDeltaDb.toFixed(2)}`);
      } else {
        const [lo, hi] = fx.controlBand;
        const att = M.bandEnergyDb(clean, lo, hi, 48000, 1024, fx.fricMask)
          - M.bandEnergyDb(fx.mix, lo, hi, 48000, 1024, fx.fricMask);
        const row = {
          id: fx.id, phoneme: fx.phoneme, level: 'control', f0: 0, kind: 'control',
          controlAttenuationDb: att,
        };
        rows.push(row);
        console.log(`  ${fx.id.padEnd(16)} control attenuation ${att.toFixed(2)} dB (negative = suppressed)`);
      }
    }
    const speech = rows.filter((r) => r.kind === 'speech');
    const loud = speech.filter((r) => r.level === 'loud');
    const quiet = speech.filter((r) => r.level === 'quiet');
    const controls = rows.filter((r) => r.kind === 'control');
    const mean = (rs, k) => rs.reduce((a, r) => a + r[k], 0) / Math.max(1, rs.length);
    const summary = {
      variant,
      config: configLabel,
      nSpeech: speech.length,
      meanFricPreservationDb: mean(speech, 'fricPreservationDb'),
      meanFricPreservationLoudDb: mean(loud, 'fricPreservationDb'),
      meanFricPreservationQuietDb: mean(quiet, 'fricPreservationDb'),
      worstFricPreservationDb: Math.min(...speech.map((r) => r.fricPreservationDb)),
      worstFixture: speech.reduce((w, r) => (r.fricPreservationDb < w.fricPreservationDb ? r : w), speech[0]).id,
      meanFricSegmentSiSdrDb: mean(speech, 'fricSegmentSiSdrDb'),
      meanEstoi: mean(speech, 'estoi'),
      meanSpeechBandDeltaDb: mean(speech, 'speechBandDeltaDb'),
      meanControlAttenuationDb: mean(controls, 'controlAttenuationDb'),
      controls: Object.fromEntries(controls.map((c) => [c.id, c.controlAttenuationDb])),
    };
    console.log(`[fric] ${variant} summary: fric mean ${summary.meanFricPreservationDb.toFixed(2)} dB (loud ${summary.meanFricPreservationLoudDb.toFixed(2)}, quiet ${summary.meanFricPreservationQuietDb.toFixed(2)}), worst ${summary.worstFricPreservationDb.toFixed(2)} (${summary.worstFixture}), ESTOI ${summary.meanEstoi.toFixed(3)}, controls ${summary.meanControlAttenuationDb.toFixed(2)} dB`);
    results[variant] = { summary, rows };
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, `${JSON.stringify({ generatedAt: new Date().toISOString(), config: configLabel, results }, null, 2)}\n`);
    console.log(`wrote ${jsonOut}`);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
