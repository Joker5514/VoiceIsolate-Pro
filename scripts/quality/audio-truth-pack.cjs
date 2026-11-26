#!/usr/bin/env node
'use strict';
/**
 * Audio Truth Pack — LOCAL (never CI-verified).
 * ChatGPT matrix, Phase 2 "establish audio truth": reproduce the four
 * Standard-profile SI-SDR baselines, bypass-vs-processing for every shipped
 * profile and Engineer preset, stage-by-stage ablation to locate where
 * degradation enters, and the QA-002 invariant tests that are runnable in
 * the Node harness (silence, unity-mask reconstruction, stereo, impulse
 * alignment). Slider-sweep and Live-Mix invariants are app-layer and are
 * NOT testable here — reported as NOT RUN.
 *
 * Runs the production MLWorker with the shipped ONNX models (WASM, one
 * thread, deterministic) over the repo's synthetic fixtures (seed 41 etc.).
 * No personal audio is used anywhere in this pack.
 *
 *   node scripts/quality/audio-truth-pack.cjs [--json <path>]
 *
 * Scratch script: uncommitted, do not commit, do not ship.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createMlWorker } = require('./lib/mlworker-node.cjs');
const { engineerConfig } = require('./lib/engineer-config.cjs');
const { profiles: loadProfiles } = require('./lib/profiles.cjs');
const M = require('./lib/metrics.cjs');
const { scenarios } = require('./scenarios.cjs');
const S = require('./lib/signals.cjs');

const SECS = 4;
const SR = 48000;
const ROOT = path.resolve(__dirname, '../..');
const KEY_FIXTURES = ['clean-speech', 'white-5db', 'hvac-5db', 'hum-10db', 'music-0db', 'whisper-clean', 'whisper-white-10db', 'whisper-music-5db'];
const ABLATION_FIXTURES = ['white-5db', 'hum-10db', 'music-0db', 'whisper-white-10db'];

function anchorOnce(code, anchor, label) {
  if (code.split(anchor).length !== 2) throw new Error(`${label}: anchor not found exactly once: ${JSON.stringify(anchor.slice(0, 80))}`);
  return true;
}

/** Unity-mask worker: mask forced to 1, HF post-filter / engineer processor /
 *  hum removal all disabled — measures the pure STFT/iSTFT + OLA path. */
function unityPatch(code) {
  let c = code;
  anchorOnce(c, "const hfPostFilter = typeof self.createHfPostFilter === 'function'", 'unity/hf');
  c = c.replace("const hfPostFilter = typeof self.createHfPostFilter === 'function'", 'const hfPostFilter = false && typeof self.createHfPostFilter === \'function\'');
  anchorOnce(c, 'const engineerProcessor = typeof self.createEngineerFrameProcessor', 'unity/eng');
  c = c.replace('const engineerProcessor = typeof self.createEngineerFrameProcessor', 'const engineerProcessor = false && typeof self.createEngineerFrameProcessor');
  anchorOnce(c, "if (typeof self.removeMainsHum === 'function') {\n    modelInput = [];", 'unity/hum');
  c = c.replace("if (typeof self.removeMainsHum === 'function') {\n    modelInput = [];", 'if (false) {\n    modelInput = [];');
  const fillAnchor = '    }\n\n    for (let b = 0; b < count; b++) {\n      const off = b * bins;';
  anchorOnce(c, fillAnchor, 'unity/fill');
  c = c.replace(fillAnchor, '    }\n    fusedMask.fill(1, 0, count * bins);\n\n    for (let b = 0; b < count; b++) {\n      const off = b * bins;');
  return c;
}
function noSmoothPatch(code) {
  anchorOnce(code, 'const maskSmooth = 0.55;', 'nosmooth');
  return code.replace('const maskSmooth = 0.55;', 'const maskSmooth = 0;');
}
function noHfPatch(code) {
  anchorOnce(code, "const hfPostFilter = typeof self.createHfPostFilter === 'function'", 'nohf');
  return code.replace("const hfPostFilter = typeof self.createHfPostFilter === 'function'", 'const hfPostFilter = false && typeof self.createHfPostFilter === \'function\'');
}
function noHumPatch(code) {
  anchorOnce(code, "if (typeof self.removeMainsHum === 'function') {\n    modelInput = [];", 'nohum');
  return code.replace("if (typeof self.removeMainsHum === 'function') {\n    modelInput = [];", 'if (false) {\n    modelInput = [];');
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

function fmt(v, d = 2) { return Number.isFinite(v) ? v.toFixed(d) : String(v); }

/** Cross-correlation lag (samples) of out vs ref over lags [-maxLag, maxLag]. */
function xcorrLag(out, ref, maxLag) {
  let bestLag = 0; let best = -Infinity;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let dot = 0; let eo = 0; let er = 0;
    const lo = Math.max(0, -lag); const hi = Math.min(out.length, ref.length - lag);
    for (let i = lo; i < hi; i++) {
      const o = out[i]; const r = ref[i + lag];
      dot += o * r; eo += o * o; er += r * r;
    }
    const c = dot / Math.sqrt(Math.max(eo * er, 1e-30));
    if (c > best) { best = c; bestLag = lag; }
  }
  return { lag: bestLag, corr: best };
}

async function main() {
  const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
  const R = { baseline: '492e971c', label: 'LOCAL — never CI-verified', sections: {} };

  const worker = await createMlWorker();
  console.log(`[truth] MLWorker backend: ${worker.backend}`);

  // --- determinism probe (shared worker must be stateless across calls) ---
  const allSc = scenarios(SECS);
  const scById = Object.fromEntries(allSc.map((s) => [s.id, s]));
  const detFx = scById['white-5db'].build();
  const detCfg = await engineerConfig();
  const detRun = async () => {
    const out = await worker.separate([detFx.input], { modelIds: ['bsrnn_vocals'], processingConfig: detCfg });
    return { si: M.siSdr(out.clean[0], detFx.ref), clean: out.clean[0] };
  };
  const d1 = await detRun(); const d2 = await detRun();
  let maxDiff = 0;
  for (let i = 0; i < d1.clean.length; i++) maxDiff = Math.max(maxDiff, Math.abs(d1.clean[i] - d2.clean[i]));
  console.log(`[truth] determinism probe: dSI-SDR ${Math.abs(d1.si - d2.si).toFixed(4)} dB, max sample diff ${maxDiff.toExponential(2)}`);
  if (Math.abs(d1.si - d2.si) > 0.01) throw new Error('NON-DETERMINISTIC — aborting');

  // --- Part 1+2: gate profiles on ALL scenarios, bypass comparison ---
  const gateProfiles = await loadProfiles();
  const table = [];
  console.log('\n=== gate profiles x all scenarios (SI-SDR delta vs bypass; preservation = absolute SI-SDR) ===');
  for (const sc of allSc) {
    const fx = sc.build();
    const bypassSi = fx.ref ? M.siSdr(fx.input, fx.ref) : null;
    const bypassSdr = fx.ref ? M.sdr(fx.input, fx.ref) : null;
    for (const p of gateProfiles) {
      const out = await worker.separate([fx.input], p);
      const clean = out.clean[0];
      const row = {
        scenario: sc.id, kind: sc.kind, profile: p.id,
        pipelineMode: out.pipelineMode,
        stft: out.stftCounts || null,
        peak: M.peak(clean), nonFinite: M.nonFinite(clean),
        siSdr: fx.ref ? M.siSdr(clean, fx.ref) : null,
        sdr: fx.ref ? M.sdr(clean, fx.ref) : null,
        siSdrDelta: fx.ref && sc.kind !== 'preservation' ? M.siSdr(clean, fx.ref) - bypassSi : null,
        sdrDelta: fx.ref && sc.kind !== 'preservation' ? M.sdr(clean, fx.ref) - bypassSdr : null,
        speechLevel: fx.ref ? M.rmsDb(clean, fx.active) - M.rmsDb(fx.ref, fx.active) : null,
        fricativeLevel: fx.fricative ? M.bandEnergyDb(clean, 3500, 9000, 48000, 1024, fx.fricative) - M.bandEnergyDb(fx.ref, 3500, 9000, 48000, 1024, fx.fricative) : null,
        noiseReduction: !fx.ref && sc.id === 'noise-only' ? M.rmsDb(fx.input) - M.rmsDb(clean) : null,
        humRemoved: out.humRemoved || null,
      };
      table.push(row);
      const score = row.siSdrDelta != null ? `dSI ${fmt(row.siSdrDelta)} (dSDR ${fmt(row.sdrDelta)})` : (row.siSdr != null ? `SI ${fmt(row.siSdr)}` : `NR ${fmt(row.noiseReduction)}`);
      console.log(`  ${sc.id.padEnd(18)} ${p.id.padEnd(9)} ${score} | speech-lvl ${row.speechLevel != null ? fmt(row.speechLevel) : '  n/a'} | fric ${row.fricativeLevel != null ? fmt(row.fricativeLevel) : '  n/a'} | peak ${fmt(row.peak, 3)} | ${out.pipelineMode}`);
    }
  }
  R.sections.gateProfiles = table;

  // --- Part 2b: all 9 Engineer presets on key fixtures ---
  const presetMod = await import(pathToFileURL(path.join(ROOT, 'src/core/PresetCalibration.js')).href);
  const presetNames = Object.keys(presetMod.CALIBRATED_ENGINEER_PRESETS);
  const presetTable = [];
  console.log('\n=== Engineer presets x key fixtures ===');
  for (const name of presetNames) {
    const overrides = await presetOverrides(name);
    const cfg = await engineerConfig(overrides);
    for (const fid of KEY_FIXTURES) {
      const sc = scById[fid];
      const fx = sc.build();
      const out = await worker.separate([fx.input], { modelIds: ['bsrnn_vocals'], processingConfig: cfg });
      const clean = out.clean[0];
      const si = M.siSdr(clean, fx.ref);
      const row = {
        preset: name, scenario: fid, kind: sc.kind,
        siSdr: si,
        siSdrDelta: sc.kind !== 'preservation' ? si - M.siSdr(fx.input, fx.ref) : null,
        sdrDelta: sc.kind !== 'preservation' ? M.sdr(clean, fx.ref) - M.sdr(fx.input, fx.ref) : null,
        speechLevel: M.rmsDb(clean, fx.active) - M.rmsDb(fx.ref, fx.active),
        fricativeLevel: fx.fricative ? M.bandEnergyDb(clean, 3500, 9000, 48000, 1024, fx.fricative) - M.bandEnergyDb(fx.ref, 3500, 9000, 48000, 1024, fx.fricative) : null,
        peak: M.peak(clean),
      };
      presetTable.push(row);
      const score = row.siSdrDelta != null ? `dSI ${fmt(row.siSdrDelta)}` : `SI ${fmt(row.siSdr)}`;
      console.log(`  ${name.padEnd(20)} ${fid.padEnd(18)} ${score} | speech-lvl ${fmt(row.speechLevel)} | fric ${row.fricativeLevel != null ? fmt(row.fricativeLevel) : 'n/a'}`);
    }
  }
  R.sections.presets = presetTable;

  // --- Part 3: stage ablations on the worst fixtures ---
  console.log('\n=== stage ablations (landing config unless noted; SI-SDR delta vs bypass) ===');
  const ablations = [];
  const wUnity = await createMlWorker({ patchSource: unityPatch });
  const wNoSmooth = await createMlWorker({ patchSource: noSmoothPatch });
  const wNoHf = await createMlWorker({ patchSource: noHfPatch });
  const wNoHum = await createMlWorker({ patchSource: noHumPatch });
  for (const fid of ABLATION_FIXTURES) {
    const sc = scById[fid];
    const fx = sc.build();
    const bypassSi = M.siSdr(fx.input, fx.ref);
    const runVariant = async (label, w, opts) => {
      const out = await w.separate([fx.input], opts);
      const clean = out.clean[0];
      const d = M.siSdr(clean, fx.ref) - bypassSi;
      const row = { fixture: fid, variant: label, siSdrDelta: d, siSdr: M.siSdr(clean, fx.ref), speechLevel: M.rmsDb(clean, fx.active) - M.rmsDb(fx.ref, fx.active), stft: out.stftCounts || null, pipelineMode: out.pipelineMode };
      ablations.push(row);
      console.log(`  ${fid.padEnd(18)} ${label.padEnd(28)} dSI ${fmt(d)} | SI ${fmt(row.siSdr)} | speech-lvl ${fmt(row.speechLevel)} | ${out.pipelineMode} stft=${JSON.stringify(out.stftCounts)}`);
      return row;
    };
    await runVariant('unity-mask (STFT/iSTFT only)', wUnity, { modelIds: ['bsrnn_vocals'], processingConfig: null });
    await runVariant('mask only (landing)', worker, { modelIds: ['bsrnn_vocals'], processingConfig: null });
    await runVariant('mask, no temporal smoothing', wNoSmooth, { modelIds: ['bsrnn_vocals'], processingConfig: null });
    await runVariant('mask, no HF post-filter', wNoHf, { modelIds: ['bsrnn_vocals'], processingConfig: null });
    await runVariant('mask, no hum removal', wNoHum, { modelIds: ['bsrnn_vocals'], processingConfig: null });
    await runVariant('mask + RNNoise (maximum)', worker, { modelIds: ['bsrnn_vocals', 'rnnoise'], processingConfig: null });
    await runVariant('mask + engineer DSP (default)', worker, { modelIds: ['bsrnn_vocals'], processingConfig: await engineerConfig() });
    const wb = await presetOverrides('Whisper Boost');
    await runVariant('mask + Whisper Boost preset', worker, { modelIds: ['bsrnn_vocals'], processingConfig: await engineerConfig(wb) });
    await runVariant('mask + Whisper Boost, lift/mode 0', worker, { modelIds: ['bsrnn_vocals'], processingConfig: await engineerConfig({ ...wb, whisperLift: 0, whisperMode: 0 }) });
  }
  R.sections.ablations = ablations;

  // --- Part 4: invariant tests ---
  console.log('\n=== invariant tests ===');
  const invariants = {};
  // 4a. silence: bit-exact zero?
  const sil = scById['silence'].build();
  for (const p of gateProfiles) {
    const out = await worker.separate([sil.input], p);
    const pc = M.peak(out.clean[0]); const pn = M.peak(out.noise[0]);
    invariants[`silence/${p.id}`] = { cleanPeak: pc, noisePeak: pn, bitExact: pc === 0 && pn === 0 };
    console.log(`  silence/${p.id}: clean peak ${pc.toExponential(2)} noise peak ${pn.toExponential(2)} bit-exact=${pc === 0 && pn === 0}`);
  }
  // 4b. unity-mask reconstruction: clean-speech + impulse
  const cs = scById['clean-speech'].build();
  const uOut = await wUnity.separate([cs.input], { modelIds: ['bsrnn_vocals'], processingConfig: null });
  const reconSi = M.siSdr(uOut.clean[0], cs.input);
  const reconSdr = M.sdr(uOut.clean[0], cs.input);
  invariants.unityReconstruction = { siSdrVsInput: reconSi, sdrVsInput: reconSdr, stft: uOut.stftCounts };
  console.log(`  unity-mask reconstruction (clean-speech): SI-SDR vs input ${fmt(reconSi)} dB, SDR ${fmt(reconSdr)} dB, stft=${JSON.stringify(uOut.stftCounts)}`);
  const n = SECS * SR;
  const imp = new Float32Array(n); imp[SR] = 0.5; // impulse at 1.000 s
  const impOut = await wUnity.separate([imp], { modelIds: ['bsrnn_vocals'], processingConfig: null });
  let argmax = 0; let amax = 0;
  for (let i = 0; i < impOut.clean[0].length; i++) { const a = Math.abs(impOut.clean[0][i]); if (a > amax) { amax = a; argmax = i; } }
  let preMax = 0;
  for (let i = 0; i < SR - 10; i++) preMax = Math.max(preMax, Math.abs(impOut.clean[0][i]));
  invariants.impulseUnity = { inputIndex: SR, outputPeakIndex: argmax, offsetSamples: argmax - SR, offsetMs: (argmax - SR) / 48, peakAmp: amax, preRingingMax: preMax };
  console.log(`  impulse (unity): peak at sample ${argmax} (offset ${argmax - SR} samples = ${((argmax - SR) / 48).toFixed(2)} ms), amp ${amax.toFixed(4)} (in 0.5), pre-ringing max ${preMax.toExponential(2)}`);
  // 4c. full-chain alignment: clean-speech + impulse, cross-correlation lag
  const csImp = new Float32Array(cs.input); csImp[SR] += 0.5;
  const fcOut = await worker.separate([csImp], { modelIds: ['bsrnn_vocals'], processingConfig: null });
  const lag = xcorrLag(fcOut.clean[0], csImp, 240);
  let nearMax = 0; let nearIdx = -1;
  for (let i = SR - 480; i <= SR + 480; i++) { const a = Math.abs(fcOut.clean[0][i]); if (a > nearMax) { nearMax = a; nearIdx = i; } }
  invariants.impulseFullChain = { xcorrLagSamples: lag.lag, xcorrLagMs: lag.lag / 48, xcorr: lag.corr, impulsePeakNear1s: { index: nearIdx, offsetSamples: nearIdx - SR, amp: nearMax } };
  console.log(`  impulse (full chain, landing): xcorr lag ${lag.lag} samples (${(lag.lag / 48).toFixed(2)} ms), corr ${lag.corr.toFixed(4)}; peak near 1 s at ${nearIdx} (offset ${nearIdx - SR}), amp ${nearMax.toFixed(4)}`);
  // 4d. stereo: dual-mono identity + side-channel preservation
  const v = S.talker({ seconds: SECS, seed: 11, f0: 125 });
  const tone = new Float32Array(n);
  for (let i = 0; i < n; i++) tone[i] = 0.1 * Math.sin(2 * Math.PI * 1000 * i / SR);
  const L = new Float32Array(n); const Rr = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = v.signal[i] + tone[i]; Rr[i] = v.signal[i] - tone[i]; }
  const stOut = await worker.separate([L, Rr], { modelIds: ['bsrnn_vocals'], processingConfig: null });
  const chOk = stOut.clean.length === 2 && stOut.clean[0].length === n && stOut.clean[1].length === n;
  const sideIn = new Float32Array(n); const sideOut = new Float32Array(n);
  const midIn = new Float32Array(n); const midOut = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sideIn[i] = (L[i] - Rr[i]) / 2; sideOut[i] = (stOut.clean[0][i] - stOut.clean[1][i]) / 2;
    midIn[i] = (L[i] + Rr[i]) / 2; midOut[i] = (stOut.clean[0][i] + stOut.clean[1][i]) / 2;
  }
  const sideDelta = M.rmsDb(sideOut) - M.rmsDb(sideIn);
  const midSi = M.siSdr(midOut, midIn);
  let dualMaxDiff = 0;
  const dmOut = await worker.separate([v.signal, v.signal], { modelIds: ['bsrnn_vocals'], processingConfig: null });
  for (let i = 0; i < n; i++) dualMaxDiff = Math.max(dualMaxDiff, Math.abs(dmOut.clean[0][i] - dmOut.clean[1][i]));
  invariants.stereo = {
    channelsOut: stOut.clean.length, lengthsOk: chOk, pipelineMode: stOut.pipelineMode,
    sideLevelDeltaDb: sideDelta, midSiSdrDb: midSi,
    dualMonoMaxChannelDiff: dualMaxDiff,
  };
  console.log(`  stereo: channels=${stOut.clean.length} lengthsOk=${chOk} mode=${stOut.pipelineMode} | side level delta ${fmt(sideDelta)} dB | mid SI-SDR ${fmt(midSi)} dB | dual-mono L/R max diff ${dualMaxDiff.toExponential(2)}`);
  // 4e. stem conservation: noise is defined as input - clean (residual), so
  // clean+noise == input by construction. Verify the arithmetic holds.
  const fx = scById['white-5db'].build();
  const cOut = await worker.separate([fx.input], { modelIds: ['bsrnn_vocals'], processingConfig: null });
  let consMax = 0;
  for (let i = 0; i < fx.input.length; i++) consMax = Math.max(consMax, Math.abs(fx.input[i] - (cOut.clean[0][i] + cOut.noise[0][i])));
  invariants.stemConservation = { maxAbsResidualError: consMax, note: 'noise stem is defined as input-clean in MLWorker.js residual(); conservation is exact by construction, not an independent measurement' };
  console.log(`  stem conservation (clean+noise vs input): max abs error ${consMax.toExponential(2)} — exact by construction (noise = input - clean)`);
  R.sections.invariants = invariants;

  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(R, null, 2));
  console.log(`\n[truth] DONE — ${jsonOut ? `results written to ${jsonOut}` : 'no JSON output requested'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
