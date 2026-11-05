#!/usr/bin/env node
'use strict';

/**
 * VIP-004 / VIP-034 — corpus evaluation on the admitted corpus.
 *
 * Runs the production MLWorker (same Node harness as the quality gate:
 * real shipped ONNX models, WASM single thread, deterministic) over every
 * admitted clip (dataset 2026-11-03.v1, 36 clips, 8 classes) with each of
 * the 4 shipped chains (landing / engineer / maximum / enhance), and
 * scores the clean stem against the manifest's sample-accurate aligned
 * target. This is the baseline run VIP-004 box 1 asks for, and the
 * comparison VIP-004 box 2 asks for (same clips, same preprocessing —
 * linear upsample 16 kHz → 48 kHz for input and target alike, because
 * the shipped models reject non-48 kHz input, exactly as FileIngestion
 * resamples to canonical 48 kHz in product — same hardware class, same
 * protocol for every chain).
 *
 * What the targets mean (read this before quoting a number):
 * - Noisy / field / overlap clips (22): the target is a separate aligned
 *   clean file (LibriSpeech clean speech mixed with a real noise file at
 *   a documented SNR; overlap targets are the primary speaker, source1).
 *   SI-SDR delta = SI-SDR(output, target) - SI-SDR(input, target).
 * - Clean / quiet / whispered clips (14): the target IS the clip
 *   (self-referential by design). SI-SDR(output, input) therefore
 *   measures preservation — how much the chain distorts speech that
 *   needs no cleaning — not improvement.
 *
 * Metrics (all in dB, via scripts/quality/lib/metrics.cjs):
 * - si-sdr / si-sdr-delta, sdr / sdr-delta (plain SDR punishes mere
 *   attenuation, which SI-SDR forgives).
 * - speech-level delta: output vs reference RMS over reference-defined
 *   active frames (20 ms frames louder than both -50 dBFS and peak-40 dB).
 * - fricative-level delta: 3.5-7.5 kHz band energy, same active mask
 *   (the gate's 3.5-9 kHz band clipped at the 16 kHz Nyquist).
 * - warm realtime factor (processing wall / audio duration, model load
 *   excluded), cold start (worker init + first model load per chain),
 *   RSS/heap at chain boundaries.
 *
 * Thresholds are judged mechanically against docs/guides/
 * CORPUS_THRESHOLDS.md (written before this script ever ran). The script
 * reports which chains meet all bars; it does not select a default —
 * selection stays a product decision, and no chain is promoted on a
 * single clip, a single class, or synthetic fixtures.
 *
 * Not measured (documented gaps, not omissions by accident): PESQ/STOI
 * (no validated implementation bundled), WER (no pinned offline ASR).
 * The enhance chain runs ungated here for measurement; in product it is
 * gated by EnhanceGuard.
 *
 * Usage: node scripts/quality/corpus-eval.cjs [--clip <id> ...] [--chain <id> ...] [--stems]
 * Output: output/corpus-eval/report.json + report.md. With --stems, the
 * first clip of each class also yields blinded listening pairs
 * (output/corpus-eval/listen/pair-NN-A.wav + pair-NN-B.wav, one pair per
 * chain, input vs chain output in randomized A/B order) plus
 * listen/key.json — the sealed A/B mapping, not to be opened until
 * scoring is done — and listen/pairs.md, the listener-facing sheet.
 * Listening pairs are the prepared material for VIP-004 box 5; the
 * listening itself is a human step and stays open until it is done.
 * Exit 1 on missing / checksum-mismatched assets, invariant failures,
 * or crashes — an incomplete eval never reports as passed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { createMlWorker } = require('./lib/mlworker-node.cjs');
const { profiles } = require('./lib/profiles.cjs');
const M = require('./lib/metrics.cjs');

const ROOT = path.join(__dirname, '..', '..');
const CORPUS_DIR = path.join(__dirname, 'corpus');
const MANIFEST = path.join(CORPUS_DIR, 'corpus-manifest.json');
const OUT_DIR = path.join(ROOT, 'output', 'corpus-eval');
const FRIC_LO = 3500;
const FRIC_HI = 9000;
const EVAL_SR = 48000;

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** Minimal PCM16 mono WAV reader. Throws on anything it cannot prove. */
function readWav(p) {
  const buf = fs.readFileSync(p);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${p}: not a RIFF/WAVE file`);
  }
  let offset = 12;
  let fmt = null;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        sampleRate: buf.readUInt32LE(start + 4),
        bitsPerSample: buf.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      dataStart = start;
      dataSize = size;
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || dataStart < 0) throw new Error(`${p}: missing fmt or data chunk`);
  if (fmt.audioFormat !== 1 || fmt.channels !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`${p}: expected PCM16 mono, got format=${fmt.audioFormat} ch=${fmt.channels} bits=${fmt.bitsPerSample}`);
  }
  const out = new Float32Array(dataSize / 2);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(dataStart + i * 2) / 32768;
  return { samples: out, sampleRate: fmt.sampleRate };
}

/** 16-bit PCM mono WAV writer (the mirror of readWav). */
function writeWav16(file, samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * 2, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + 16 + 8 + data.length, 4);
  header.write('WAVE', 8);
  const fmtChunk = Buffer.concat([Buffer.from('fmt '), Buffer.alloc(4), fmt]);
  fmtChunk.writeUInt32LE(16, 4);
  const dataChunk = Buffer.concat([Buffer.from('data'), Buffer.alloc(4), data]);
  dataChunk.writeUInt32LE(data.length, 4);
  fs.writeFileSync(file, Buffer.concat([header, fmtChunk, dataChunk]));
}

/** Deterministic PRNG (mulberry32) so blinded A/B assignment is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Linear-interpolation resample. The product resamples to canonical 48 kHz
 *  in FileIngestion before the worker, and the shipped models reject
 *  non-48 kHz input outright — so the eval upsamples the 16 kHz corpus to
 *  48 kHz with this exact function, for input and target alike, and scores
 *  at 48 kHz. Same filter on both sides keeps chain comparisons fair. */
function upsampleLinear(samples, fromSr, toSr) {
  if (fromSr === toSr) return Float32Array.from(samples);
  const ratio = toSr / fromSr;
  const outLen = Math.floor(samples.length * ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    const frac = pos - i0;
    out[i] = samples[i0] * (1 - frac) + samples[i1] * frac;
  }
  return out;
}

/** Reference-defined activity mask: 20 ms frames louder than both -50 dBFS
 *  and the clip's peak frame minus 40 dB. Returns a per-sample boolean
 *  array, or null when no frame qualifies (caller reports null metrics). */
function activityMask(ref, sampleRate) {
  const frameSamples = Math.round(sampleRate * 0.02);
  const frames = Math.floor(ref.length / frameSamples);
  const frameDb = new Float64Array(frames);
  let peakDb = -Infinity;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = 0; i < frameSamples; i++) { const v = ref[f * frameSamples + i]; s += v * v; }
    frameDb[f] = M.db(s / frameSamples);
    if (frameDb[f] > peakDb) peakDb = frameDb[f];
  }
  const threshold = Math.max(-50, peakDb - 40);
  const mask = new Array(ref.length).fill(false);
  let active = 0;
  for (let f = 0; f < frames; f++) {
    if (frameDb[f] > threshold) {
      active++;
      for (let i = 0; i < frameSamples; i++) mask[f * frameSamples + i] = true;
    }
  }
  return active > 0 ? mask : null;
}

function mean(values) {
  const v = values.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function fmt(v, digits = 2) {
  return v == null || !Number.isFinite(v) ? 'n/a' : v.toFixed(digits);
}

/** Mechanical threshold judgement for one chain (CORPUS_THRESHOLDS.md).
 *  Every bar requires a FINITE measured value: a missing metric (null)
 *  fails the bar instead of silently passing — `null >= 0` is true in JS
 *  (null coerces to 0), so a bare comparison would pass an unmeasured
 *  chain. `aggs` maps category -> aggregate row from byClassChain. */
function judgeChain(aggs, warmRtf, coldMs) {
  const reasons = [];
  for (const [cat, agg] of Object.entries(aggs)) {
    const noisy = cat.startsWith('noisy-speech') || cat === 'field-recording' || cat === 'overlapping-speakers';
    if (noisy && !(Number.isFinite(agg.meanSiSdrDelta) && agg.meanSiSdrDelta >= 0)) {
      reasons.push(`${cat}: mean SI-SDR delta ${fmt(agg.meanSiSdrDelta)} dB < 0`);
    }
    if (!noisy && !(Number.isFinite(agg.meanPreservation) && agg.meanPreservation >= 15)) {
      reasons.push(`${cat}: mean preservation ${fmt(agg.meanPreservation)} dB < 15`);
    }
    if (!(Number.isFinite(agg.meanSpeechLevel) && Math.abs(agg.meanSpeechLevel) <= 3)) {
      reasons.push(`${cat}: mean speech-level delta ${fmt(agg.meanSpeechLevel)} dB outside ±3`);
    }
    if (!(Number.isFinite(agg.meanFricative) && agg.meanFricative >= -6)) {
      reasons.push(`${cat}: mean fricative delta ${fmt(agg.meanFricative)} dB < -6`);
    }
  }
  if (!(Number.isFinite(warmRtf) && warmRtf < 1)) reasons.push(`warm realtime factor ${fmt(warmRtf)} >= 1 (or unmeasured)`);
  if (coldMs != null && coldMs > 60000) reasons.push(`cold start ${Math.round(coldMs / 1000)} s > 60 s (flagged, mobile-default unsuitable)`);
  return { meetsAllBars: reasons.length === 0, reasons };
}

async function main() {
  const args = process.argv.slice(2);
  const onlyClips = [];
  const onlyChains = [];
  let writeStems = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--clip' && args[i + 1]) onlyClips.push(args[++i]);
    else if (args[i] === '--chain' && args[i + 1]) onlyChains.push(args[++i]);
    else if (args[i] === '--stems') writeStems = true;
  }

  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const clips = manifest.clips.filter((c) => !onlyClips.length || onlyClips.includes(c.id));

  // 1. Verify every admitted asset before measuring anything.
  const assetFailures = [];
  const loaded = [];
  for (const clip of clips) {
    const clipPath = path.join(CORPUS_DIR, clip.path);
    const targetPath = path.join(CORPUS_DIR, clip.reference.alignedTargetPath);
    if (!fs.existsSync(clipPath)) { assetFailures.push(`${clip.id}: missing ${clip.path}`); continue; }
    if (!fs.existsSync(targetPath)) { assetFailures.push(`${clip.id}: missing target ${clip.reference.alignedTargetPath}`); continue; }
    if (sha256File(clipPath) !== clip.sha256) { assetFailures.push(`${clip.id}: clip checksum mismatch`); continue; }
    if (sha256File(targetPath) !== clip.reference.alignedTargetSha256) { assetFailures.push(`${clip.id}: target checksum mismatch`); continue; }
    const input = readWav(clipPath);
    const target = readWav(targetPath);
    if (input.sampleRate !== clip.sampleRate || target.sampleRate !== clip.sampleRate) {
      assetFailures.push(`${clip.id}: sample rate mismatch (manifest ${clip.sampleRate})`); continue;
    }
    if (input.samples.length !== target.samples.length) {
      assetFailures.push(`${clip.id}: input/target length mismatch (${input.samples.length} vs ${target.samples.length})`); continue;
    }
    loaded.push({ clip, input: input.samples, target: target.samples, selfTarget: clip.reference.alignedTargetPath === clip.path });
  }
  if (assetFailures.length) {
    console.error(`[corpus-eval] INCOMPLETE — ${assetFailures.length} asset failure(s):\n  ${assetFailures.join('\n  ')}`);
    process.exit(1);
  }
  if (!loaded.length) { console.error('[corpus-eval] INCOMPLETE — no clips selected'); process.exit(1); }

  // 2. Run every chain over every clip.
  const tInit0 = performance.now();
  const worker = await createMlWorker();
  const initMs = performance.now() - tInit0;
  const allProfiles = await profiles();
  const chainProfiles = allProfiles.filter((p) => !onlyChains.length || onlyChains.includes(p.id));
  if (!chainProfiles.length) { console.error('[corpus-eval] unknown chain filter'); process.exit(1); }

  let commit = 'unknown';
  try { commit = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); } catch { /* not a git checkout */ }

  const rows = [];
  const invariantFailures = [];
  const mem = { start: process.memoryUsage() };
  // Listening pairs: first clip of each class, one input-vs-chain pair per
  // chain, blinded A/B order from a fixed-seed RNG (reproducible).
  const firstOfClass = new Set();
  {
    const seen = new Set();
    for (const { clip } of loaded) {
      if (!seen.has(clip.category)) { seen.add(clip.category); firstOfClass.add(clip.id); }
    }
  }
  const listenDir = path.join(OUT_DIR, 'listen');
  if (writeStems) fs.mkdirSync(listenDir, { recursive: true });
  const rng = mulberry32(0xC0FFEE);
  let pairCounter = 0;
  const pairKey = [];
  for (const profile of chainProfiles) {
    let first = true;
    for (const { clip, input, target, selfTarget } of loaded) {
      // Score at 48 kHz: models reject 16 kHz input, so both sides go
      // through the same linear upsampler (see upsampleLinear).
      const input48 = upsampleLinear(input, clip.sampleRate, EVAL_SR);
      const target48 = upsampleLinear(target, clip.sampleRate, EVAL_SR);
      const t0 = performance.now();
      const out = await worker.separate([input48], {
        modelIds: profile.modelIds,
        processingConfig: profile.processingConfig,
        sampleRate: EVAL_SR,
      });
      const wallMs = performance.now() - t0;
      const clean = out.clean[0];
      const durationSec = input.length / clip.sampleRate;
      if (!clean || clean.length !== input48.length) {
        invariantFailures.push(`${clip.id}/${profile.id}: clean length ${clean?.length} != ${input48.length}`);
        continue;
      }
      const bad = M.nonFinite(clean);
      if (bad) invariantFailures.push(`${clip.id}/${profile.id}: ${bad} non-finite samples`);
      if (M.peak(clean) > 1) invariantFailures.push(`${clip.id}/${profile.id}: peak ${M.peak(clean).toFixed(3)} > 1`);
      const mask = activityMask(target48, EVAL_SR);
      const row = {
        clip: clip.id,
        category: clip.category,
        chain: profile.id,
        selfTarget,
        durationSec: Math.round(durationSec * 100) / 100,
        siSdrIn: M.siSdr(input48, target48),
        siSdrOut: M.siSdr(clean, target48),
        sdrIn: M.sdr(input48, target48),
        sdrOut: M.sdr(clean, target48),
        speechLevelDelta: mask ? M.rmsDb(clean, mask) - M.rmsDb(target48, mask) : null,
        fricativeDelta: mask ? M.bandEnergyDb(clean, FRIC_LO, FRIC_HI, EVAL_SR, 1024, mask)
          - M.bandEnergyDb(target48, FRIC_LO, FRIC_HI, EVAL_SR, 1024, mask) : null,
        wallMs: Math.round(wallMs),
        cold: first,
      };
      row.siSdrDelta = row.siSdrOut - row.siSdrIn;
      row.sdrDelta = row.sdrOut - row.sdrIn;
      row.rtf = wallMs / 1000 / durationSec;
      rows.push(row);
      if (writeStems && firstOfClass.has(clip.id)) {
        // Back to the native 16 kHz grid (every 3rd sample of the 48 kHz
        // output, mirroring the 3x upsample) for listening at one rate.
        const down = new Float32Array(Math.floor(clean.length / 3));
        for (let i = 0; i < down.length; i++) down[i] = clean[i * 3];
        const pairNo = ++pairCounter;
        const inputFirst = rng() < 0.5;
        const tag = String(pairNo).padStart(2, '0');
        writeWav16(path.join(listenDir, `pair-${tag}-A.wav`), inputFirst ? input : down, clip.sampleRate);
        writeWav16(path.join(listenDir, `pair-${tag}-B.wav`), inputFirst ? down : input, clip.sampleRate);
        pairKey.push({ pair: pairNo, clip: clip.id, category: clip.category, chain: profile.id, A: inputFirst ? 'input' : profile.id, B: inputFirst ? profile.id : 'input' });
      }
      first = false;
      console.log(`  ${clip.id} / ${profile.id}: si-sdr-delta ${fmt(row.siSdrDelta)} dB, speech-level ${fmt(row.speechLevelDelta)} dB, fricative ${fmt(row.fricativeDelta)} dB, rtf ${row.rtf.toFixed(2)}`);
    }
    mem[profile.id] = process.memoryUsage();
  }
  mem.end = process.memoryUsage();
  if (invariantFailures.length) {
    console.error(`[corpus-eval] FAIL — invariant failures:\n  ${invariantFailures.join('\n  ')}`);
    process.exit(1);
  }

  // 3. Aggregate per class × chain + threshold verdicts.
  const categories = [...new Set(loaded.map((l) => l.clip.category))];
  const chains = chainProfiles.map((p) => p.id);
  const byClassChain = {};
  for (const cat of categories) {
    for (const chain of chains) {
      const rs = rows.filter((r) => r.category === cat && r.chain === chain);
      const noisy = cat.startsWith('noisy-speech') || cat === 'field-recording' || cat === 'overlapping-speakers';
      byClassChain[`${cat}/${chain}`] = {
        n: rs.length,
        meanSiSdrDelta: mean(rs.map((r) => r.siSdrDelta)),
        meanSiSdrOut: mean(rs.map((r) => r.siSdrOut)),
        meanSdrDelta: mean(rs.map((r) => r.sdrDelta)),
        meanSpeechLevel: mean(rs.map((r) => r.speechLevelDelta)),
        meanFricative: mean(rs.map((r) => r.fricativeDelta)),
        meanRtf: mean(rs.map((r) => r.rtf)),
        worst: [...rs].sort((a, b) => (a.selfTarget ? a.siSdrOut : a.siSdrDelta) - (b.selfTarget ? b.siSdrOut : b.siSdrDelta)).slice(0, 3).map((r) => ({ clip: r.clip, siSdrDelta: Math.round(r.siSdrDelta * 100) / 100, siSdrOut: Math.round(r.siSdrOut * 100) / 100 })),
        qualityKey: noisy ? 'siSdrDelta' : 'preservation',
      };
      // For self-target classes the "improvement" number is preservation:
      // siSdrDelta there equals siSdrOut - siSdrIn where in==target, i.e.
      // siSdrOut itself minus an astronomically large in value (identical
      // signals score ~+200 dB). The same applies to SDR delta. Report
      // preservation directly for both, and warm-only RTF (the first row
      // per chain includes model load).
      if (!noisy) {
        byClassChain[`${cat}/${chain}`].meanPreservation = mean(rs.map((r) => r.siSdrOut));
        byClassChain[`${cat}/${chain}`].meanSdrPreservation = mean(rs.map((r) => r.sdrOut));
      }
      byClassChain[`${cat}/${chain}`].meanRtf = mean(rs.filter((r) => !r.cold).map((r) => r.rtf));
    }
  }
  const verdicts = {};
  for (const chain of chains) {
    const aggs = Object.fromEntries(categories.map((cat) => [cat, byClassChain[`${cat}/${chain}`]]));
    const warm = rows.filter((r) => r.chain === chain && !r.cold);
    const warmRtf = mean(warm.map((r) => r.rtf));
    const coldRow = rows.find((r) => r.chain === chain && r.cold);
    // Leak check (thresholds doc): last warm clip must not take > 2x the
    // first warm clip for the same chain.
    const leakRatio = warm.length >= 2 ? warm[warm.length - 1].wallMs / Math.max(1, warm[0].wallMs) : null;
    const judged = judgeChain(aggs, warmRtf, coldRow?.wallMs ?? null);
    if (Number.isFinite(leakRatio) && leakRatio > 2) judged.reasons.push(`last warm clip ${warm[warm.length - 1].wallMs} ms > 2x first warm clip ${warm[0].wallMs} ms (possible leak/unbounded growth)`);
    if (judged.reasons.length) judged.meetsAllBars = false;
    verdicts[chain] = { ...judged, warmRtf, coldMs: coldRow?.wallMs ?? null, leakRatio };
  }
  const rssMb = (m) => Math.round(m.rss / 1048576);
  const report = {
    generatedAt: new Date().toISOString(),
    commit,
    node: process.version,
    corpus: { datasetVersion: manifest.datasetVersion, clips: loaded.length, categories },
    worker: { initMs: Math.round(initMs), backend: 'onnxruntime-web WASM single thread (quality harness)' },
    chains: chainProfiles.map((p) => ({ id: p.id, modelIds: p.modelIds })),
    notes: [
      'Enhance chain runs ungated here for measurement; in product it is gated by EnhanceGuard.',
      'Overlap targets are the primary speaker (source1) per the manifest.',
      'Fricative band 3.5-9 kHz at the 48 kHz eval rate (same band as the quality gate). Activity masks are reference-defined (see script header).',
      'PESQ/STOI not measured (no validated implementation bundled); WER not measured (no pinned offline ASR).',
    ],
    memory: {
      rssMbStart: rssMb(mem.start),
      rssMbEnd: rssMb(mem.end),
      rssMbByChain: Object.fromEntries(chains.map((c) => [c, rssMb(mem[c])])),
    },
    rows,
    byClassChain,
    verdicts,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [];
  lines.push(`# Corpus evaluation — ${manifest.datasetVersion}`);
  lines.push('');
  lines.push(`Commit \`${commit}\`, Node ${process.version}, worker init ${Math.round(initMs)} ms, RSS ${rssMb(mem.start)} → ${rssMb(mem.end)} MB.`);
  lines.push(`Chains: ${chainProfiles.map((p) => `${p.id} (${p.modelIds.join('+')})`).join(', ')}. Enhance runs ungated here for measurement.`);
  lines.push('');
  lines.push('## Threshold verdicts (docs/guides/CORPUS_THRESHOLDS.md)');
  lines.push('');
  for (const chain of chains) {
    const v = verdicts[chain];
    lines.push(`- **${chain}**: ${v.meetsAllBars ? 'MEETS ALL BARS' : 'does not meet all bars'} (warm RTF ${fmt(v.warmRtf, 2)}, cold ${v.coldMs} ms)${v.reasons.length ? ` — ${v.reasons.join('; ')}` : ''}`);
  }
  lines.push('');
  lines.push('## Per-class means (dB unless noted)');
  lines.push('');
  lines.push('| Class | Chain | n | SI-SDR Δ / preservation | SDR Δ / preservation | Speech-level Δ | Fricative Δ | Warm RTF |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const cat of categories) {
    for (const chain of chains) {
      const a = byClassChain[`${cat}/${chain}`];
      const q = a.meanPreservation != null ? fmt(a.meanPreservation) : fmt(a.meanSiSdrDelta);
      const s = a.meanSdrPreservation != null ? fmt(a.meanSdrPreservation) : fmt(a.meanSdrDelta);
      lines.push(`| ${cat} | ${chain} | ${a.n} | ${q} | ${s} | ${fmt(a.meanSpeechLevel)} | ${fmt(a.meanFricative)} | ${fmt(a.meanRtf, 2)} |`);
    }
  }
  lines.push('');
  lines.push('## Worst cases per class × chain (lowest SI-SDR delta)');
  lines.push('');
  for (const cat of categories) {
    const noisy = cat.startsWith('noisy-speech') || cat === 'field-recording' || cat === 'overlapping-speakers';
    for (const chain of chains) {
      const a = byClassChain[`${cat}/${chain}`];
      lines.push(`- ${cat} / ${chain}: ${a.worst.map((w) => `${w.clip} (${noisy ? `${w.siSdrDelta} dB Δ` : `${w.siSdrOut} dB preservation`})`).join(', ')}`);
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), `${lines.join('\n')}\n`);
  if (writeStems) {
    fs.writeFileSync(path.join(listenDir, 'key.json'), `${JSON.stringify({ note: 'SEALED — do not open until scoring is done.', pairs: pairKey }, null, 2)}\n`);
    const plines = ['# Blinded listening pairs (VIP-004 box 5 material)', '', 'Listen to each pair (A, then B) and rate per docs/guides/LISTENING_RUBRIC.md. Do not open key.json until every pair is scored.', ''];
    for (const p of pairKey) plines.push(`- Pair ${String(p.pair).padStart(2, '0')}: category ${p.category}, clip ${p.clip}, chain ${p.chain} (one side is the input, the other is that chain's output — which is which is sealed).`);
    fs.writeFileSync(path.join(listenDir, 'pairs.md'), `${plines.join('\n')}\n`);
  }
  console.log(`[corpus-eval] DONE — ${rows.length} runs, ${loaded.length} clips × ${chains.length} chains → output/corpus-eval/report.json + report.md${writeStems ? ` + ${pairKey.length} listening pairs` : ''}`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { readWav, writeWav16, activityMask, sha256File, upsampleLinear, judgeChain };
