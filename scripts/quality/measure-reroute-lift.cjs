#!/usr/bin/env node
'use strict';
/**
 * LOCAL measurement (never CI-verified) — how much Whisper Lift the #966
 * reroute (rerouteConfidentResidual, MLWorker.js) actually undoes.
 *
 * Runs each synthetic whisper fixture through the production MLWorker
 * (bsrnn_vocals fused spectral-mask chain, shipped ONNX, WASM, one thread,
 * deterministic) twice at shipped preset settings — reroute ON (default)
 * and reroute OFF (spectral.whisperReroute === false escape hatch) — and
 * reports SI-SDR, speech level, and reroute bin stats.
 *
 * The DSP path is untouched: the patchSource instrumentation only COUNTS
 * bins (mirroring the reroute condition) and attaches the counters to the
 * stems message. The original reroute function still does the work.
 *
 *   node scripts/quality/measure-reroute-lift.cjs
 *
 * Scratch script: uncommitted, do not commit, do not ship.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const { createMlWorker } = require('./lib/mlworker-node.cjs');
const { engineerConfig } = require('./lib/engineer-config.cjs');
const M = require('./lib/metrics.cjs');
const { scenarios } = require('./scenarios.cjs');

const SECS = 4;
const PRESET_NAMES = ['Whisper Boost', 'Forensic Extract', 'Surveillance'];
const FIXTURE_IDS = ['whisper-clean', 'whisper-white-10db', 'whisper-music-5db'];
const ROOT = path.resolve(__dirname, '../..');

/** Instrument rerouteConfidentResidual with counters; attach them to stems. */
function instrumentSource(code) {
  // NOTE: the chain calls the closure-local function, NOT self.reroute...,
  // so wrapping the self export alone never fires. Patch the call site.
  const exportAnchor = 'self.rerouteConfidentResidual = rerouteConfidentResidual;';
  if (code.split(exportAnchor).length !== 2) throw new Error('reroute export anchor not found exactly once');
  const wrapped = `self.__rerouteStats = { considered: 0, reset: 0, liftReset: 0, frames: 0 };
self.__countAndReroute = function (re, im, inRe, inIm, off, k0, bins, pThresh) {
  const q = pThresh / (1 - pThresh);
  for (let k = k0; k < bins; k++) {
    const xr = inRe[off + k], xi = inIm[off + k];
    const yr = re[k], yi = im[k];
    const dr = xr - yr, di = xi - yi;
    const y2 = yr * yr + yi * yi, x2 = xr * xr + xi * xi;
    self.__rerouteStats.considered++;
    if (y2 > q * (dr * dr + di * di)) {
      self.__rerouteStats.reset++;
      if (y2 > x2) self.__rerouteStats.liftReset++;
    }
  }
  self.__rerouteStats.frames++;
  return rerouteConfidentResidual(re, im, inRe, inIm, off, k0, bins, pThresh);
};
self.rerouteConfidentResidual = rerouteConfidentResidual;`;
  code = code.replace(exportAnchor, wrapped);
  const callAnchor = 'rerouteConfidentResidual(re, im, cur.batchRe, cur.batchIm, off, rerouteK0, bins, WHISPER_REROUTE_P);';
  if (code.split(callAnchor).length !== 2) throw new Error('reroute call-site anchor not found exactly once');
  code = code.replace(callAnchor, 'self.__countAndReroute(re, im, cur.batchRe, cur.batchIm, off, rerouteK0, bins, WHISPER_REROUTE_P);');
  const stemsAnchor = '      stftCounts: stft,';
  if (code.split(stemsAnchor).length !== 2) throw new Error('stems anchor not found exactly once');
  code = code.replace(
    stemsAnchor,
    `      stftCounts: stft,\n      rerouteStats: self.__rerouteStats ? { ...self.__rerouteStats } : null,`,
  );
  return code;
}

/** Shipped preset params as raw UI values (numbers only) for engineerConfig(). */
async function presetOverrides(name) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/core/PresetCalibration.js')).href);
  const preset = mod.CALIBRATED_ENGINEER_PRESETS[name] || (mod.default && mod.default[name]);
  if (!preset) throw new Error(`preset not found: ${name}`);
  const out = {};
  for (const [k, v] of Object.entries(preset)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

async function main() {
  const worker = await createMlWorker({ patchSource: instrumentSource });
  console.log(`[measure] MLWorker backend: ${worker.backend}`);

  const fixtures = scenarios(SECS).filter((s) => FIXTURE_IDS.includes(s.id));
  if (fixtures.length !== FIXTURE_IDS.length) {
    throw new Error(`expected fixtures ${FIXTURE_IDS.join(', ')}, got ${fixtures.map((f) => f.id).join(', ')}`);
  }

  let prevStats = { considered: 0, reset: 0, liftReset: 0, frames: 0 };
  const statsDelta = (msg) => {
    const cur = msg.rerouteStats || { considered: 0, reset: 0, liftReset: 0, frames: 0 };
    const d = {
      considered: cur.considered - prevStats.considered,
      reset: cur.reset - prevStats.reset,
      liftReset: cur.liftReset - prevStats.liftReset,
      frames: cur.frames - prevStats.frames,
    };
    prevStats = cur;
    return d;
  };

  const results = [];
  // Determinism probe: identical config twice on the first fixture. If the
  // worker carries state across calls, ON/OFF comparisons are confounded.
  {
    const probeCfg = await engineerConfig(await presetOverrides(PRESET_NAMES[0]));
    const probeFx = fixtures[0].build();
    const probeRun = async () => {
      const out = await worker.separate([probeFx.input], { modelIds: ['bsrnn_vocals'], processingConfig: probeCfg });
      return {
        si: M.siSdr(out.clean[0], probeFx.ref),
        lvl: M.rmsDb(out.clean[0], probeFx.active) - M.rmsDb(probeFx.ref, probeFx.active),
        stats: statsDelta(out),
        clean: out.clean[0],
      };
    };
    const pr1 = await probeRun();
    const pr2 = await probeRun();
    let maxDiff = 0;
    for (let i = 0; i < pr1.clean.length; i++) maxDiff = Math.max(maxDiff, Math.abs(pr1.clean[i] - pr2.clean[i]));
    console.log(`[measure] determinism probe (same config x2): dSI-SDR ${Math.abs(pr1.si - pr2.si).toFixed(4)} dB, dLevel ${Math.abs(pr1.lvl - pr2.lvl).toFixed(4)} dB, max sample diff ${maxDiff.toExponential(2)}, reroute bins run1 ${pr1.stats.reset}/${pr1.stats.considered}, run2 ${pr2.stats.reset}/${pr2.stats.considered}`);
    if (Math.abs(pr1.si - pr2.si) > 0.01 || Math.abs(pr1.lvl - pr2.lvl) > 0.01) {
      throw new Error('NON-DETERMINISTIC across identical calls — ON/OFF comparison invalid with a shared worker; use a fresh worker per run');
    }
  }
  for (const presetName of PRESET_NAMES) {
    const overrides = await presetOverrides(presetName);
    const configOn = await engineerConfig(overrides);
    const liftDisplay = overrides.whisperLift;
    const liftInternalDb = (12 * liftDisplay) / 40;
    // OFF: same config, only the reroute escape hatch flipped. The worker
    // reads processingConfig.spectral.whisperReroute raw (the lift reads the
    // sanitized copy, which drops unknown keys — so the lift is identical).
    const configOff = {
      ...configOn,
      spectral: { ...configOn.spectral, whisperReroute: false },
    };
    console.log(`\n=== preset ${presetName} (whisperLift display ${liftDisplay} dB -> internal max ${liftInternalDb.toFixed(2)} dB, whisperMode ${overrides.whisperMode}) ===`);
    for (const sc of fixtures) {
      const fx = sc.build();
      const run = async (cfg, label) => {
        const out = await worker.separate([fx.input], { modelIds: ['bsrnn_vocals'], processingConfig: cfg });
        const clean = out.clean[0];
        const d = statsDelta(out);
        return {
          label,
          siSdr: M.siSdr(clean, fx.ref),
          speechLevel: M.rmsDb(clean, fx.active) - M.rmsDb(fx.ref, fx.active),
          peak: M.peak(clean),
          stats: d,
        };
      };
      const on = await run(configOn, 'reroute ON');
      const off = await run(configOff, 'reroute OFF');
      const liftLostDb = off.speechLevel - on.speechLevel;
      const siSdrDelta = on.siSdr - off.siSdr;
      const resetFrac = on.stats.considered ? on.stats.reset / on.stats.considered : 0;
      const liftResetFrac = on.stats.considered ? on.stats.liftReset / on.stats.considered : 0;
      console.log(`  ${sc.id}:`);
      console.log(`    ON : SI-SDR ${on.siSdr.toFixed(2)} dB | speech-level ${on.speechLevel.toFixed(2)} dB | peak ${on.peak.toFixed(3)} | bins considered ${on.stats.considered}, reset ${on.stats.reset} (${(resetFrac * 100).toFixed(1)}%), lift-reset ${on.stats.liftReset} (${(liftResetFrac * 100).toFixed(1)}%)`);
      console.log(`    OFF: SI-SDR ${off.siSdr.toFixed(2)} dB | speech-level ${off.speechLevel.toFixed(2)} dB | peak ${off.peak.toFixed(3)} | bins reset ${off.stats.reset} (expect 0)`);
      console.log(`    ==> lift lost to reroute: ${liftLostDb.toFixed(2)} dB | SI-SDR ON-OFF: ${siSdrDelta >= 0 ? '+' : ''}${siSdrDelta.toFixed(2)} dB`);
      results.push({ preset: presetName, fixture: sc.id, liftDisplay, liftInternalDb, on, off, liftLostDb, siSdrDelta, resetFrac, liftResetFrac });
    }
  }

  console.log('\n=== SUMMARY (LOCAL, never CI-verified) ===');
  for (const r of results) {
    console.log(`  ${r.preset} / ${r.fixture}: lift lost ${r.liftLostDb.toFixed(2)} dB of ${r.liftInternalDb.toFixed(2)} dB max internal lift | SI-SDR change ${r.siSdrDelta >= 0 ? '+' : ''}${r.siSdrDelta.toFixed(2)} dB | bins reset ${(r.resetFrac * 100).toFixed(1)}% (${(r.liftResetFrac * 100).toFixed(1)}% had net gain > 1)`);
  }
  const worst = results.reduce((a, b) => (a.liftLostDb > b.liftLostDb ? a : b));
  console.log(`  Worst lift loss: ${worst.liftLostDb.toFixed(2)} dB (${worst.preset} / ${worst.fixture})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
