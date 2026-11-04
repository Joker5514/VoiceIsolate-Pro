'use strict';

/**
 * VIP-016 box 2 — target-speaker extraction PROTOTYPE (harness only).
 *
 * ECAPA-guided frame selection on the corpus overlap clips: enroll one
 * speaker, score 1.0 s windows of the mixture against the enrollment,
 * keep windows scoring at or above the ECAPA similarity threshold,
 * attenuate the rest. Scored with the same metrics as corpus-eval
 * (SI-SDR vs the aligned primary-speaker target, speech-level and
 * fricative deltas) so the prototype is comparable to the shipped
 * chains' overlap baselines (landing −3.18, engineer −3.96,
 * maximum −3.53, enhance −11.34 dB mean SI-SDR Δ).
 *
 * CAPABILITY FLAG: this script refuses to run without
 * `--enable-target-extract`. It is a prototype, not a product path:
 * it touches no Stem-Split or Live-Mix code, adds no product chain,
 * and is NOT integrated — integration still requires the Phase 2
 * acceptance gate (CORPUS_THRESHOLDS.md overlap bars).
 *
 * ENROLLMENT HONESTY — read before quoting any number from this script:
 *   --enroll oracle (default OFF, must be chosen explicitly): enrolls
 *     from the clip's aligned primary-speaker target, i.e. from ground
 *     truth. This tests only whether the MECHANISM works when given a
 *     true target. It is not a product result and must never be quoted
 *     as one.
 *   --enroll pseudo: enrolls from the mixture itself (longest
 *     diarization segment ≥ 0.5 s). This is the product-plausible
 *     enrollment, and it is expected to be weak: the segment contains
 *     both speakers, so the enrollment embedding is a mixture, not a
 *     speaker. If pseudo enrollment fails, that failure IS the finding
 *     (product use needs real user enrollment, not mixture segments).
 *
 * Usage:
 *   node scripts/quality/target-extract-proto.cjs --enable-target-extract [--enroll oracle|pseudo]
 * Requires public/app/models/ecapa_tdnn.onnx (pnpm models:fetch-ecapa);
 * exits 2 with a clear message when it is absent.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SR = 48000;
const { readWav, upsampleLinear, activityMask } = require('./corpus-eval.cjs');
const { createDiarizationWorker } = require('./lib/diarization-node.cjs');
const { createSpeakerWorker, realOrt, ecapaEntry } = require('./lib/speaker-worker-node.cjs');
const M = require('./lib/metrics.cjs');

const args = process.argv.slice(2);
if (!args.includes('--enable-target-extract')) {
  console.error('target-extract-proto is a flagged prototype: pass --enable-target-extract to run it.');
  console.error('It is NOT a product path and its output is NOT an integration candidate (see header).');
  process.exit(2);
}
const enrollArg = args[args.indexOf('--enroll') + 1];
const enroll = enrollArg || 'pseudo';
if (!['oracle', 'pseudo'].includes(enroll)) {
  console.error(`--enroll must be oracle or pseudo, got ${enrollArg}`);
  process.exit(2);
}
const THRESHOLD = 0.35; // ECAPA_SIMILARITY.threshold (TargetSpeaker.js)
const WIN_SEC = 1.0;
const HOP_SEC = 0.5;

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/quality/corpus/corpus-manifest.json'), 'utf8'));
  const overlap = manifest.clips.filter((c) => c.category === 'overlapping-speakers');
  if (!overlap.length) throw new Error('no overlapping-speakers clips in manifest');

  const worker = createSpeakerWorker(realOrt());
  const init = await worker.send({ type: 'init', entry: ecapaEntry() });
  if (init[0]?.type !== 'ready') {
    console.error('ECAPA model unavailable (run: pnpm models:fetch-ecapa). Prototype cannot run without it.');
    process.exit(2);
  }
  const diarizer = createDiarizationWorker();
  const outDir = path.join(ROOT, 'output/target-extract-proto');
  fs.mkdirSync(outDir, { recursive: true });

  const rows = [];
  for (const clip of overlap) {
    const mix16 = readWav(path.join(ROOT, 'scripts/quality/corpus', clip.path)).samples;
    const tgt16 = readWav(path.join(ROOT, 'scripts/quality/corpus', clip.reference.alignedTargetPath)).samples;
    const mix = upsampleLinear(mix16, clip.sampleRate, SR);
    const target = upsampleLinear(tgt16, clip.sampleRate, SR);

    let enrollment;
    let enrollNote;
    if (enroll === 'oracle') {
      const r = await worker.send({ type: 'embed', samples: target, sampleRate: SR });
      enrollment = (r.find((m) => m.type === 'result') || r[0]).embedding;
      enrollNote = 'oracle: embedded the aligned primary target (ground truth — mechanism test only)';
    } else {
      const d = await diarizer.diarize(mix, SR);
      const segs = d.segments.filter((s) => s.end - s.start >= 0.5).sort((a, b) => (b.end - b.start) - (a.end - a.start));
      if (!segs.length) throw new Error(`${clip.id}: no diarization segment >= 0.5 s for pseudo enrollment`);
      const s = segs[0];
      const segAudio = mix.slice(Math.floor(s.start * SR), Math.ceil(s.end * SR));
      const r = await worker.send({ type: 'embed', samples: segAudio, sampleRate: SR });
      enrollment = (r.find((m) => m.type === 'result') || r[0]).embedding;
      enrollNote = `pseudo: embedded longest diarization segment [${s.start.toFixed(2)}, ${s.end.toFixed(2)}]s (mixture audio — weak by construction)`;
    }

    const windows = [];
    for (let t = 0; t + WIN_SEC <= mix.length / SR; t += HOP_SEC) {
      windows.push([Math.floor(t * SR), Math.floor((t + WIN_SEC) * SR)]);
    }
    const scoreReplies = await worker.send({ type: 'score', samples: mix, sampleRate: SR, target: enrollment, windows });
    // The worker posts progress messages before the result; the embed
    // path above has a single window and no progress, so [0] works there.
    const scoreResult = scoreReplies.find((m) => m.type === 'result');
    if (!scoreResult) {
      const err = scoreReplies.find((m) => m.type === 'error');
      throw new Error(`${clip.id}: score failed: ${err?.message || 'no result message'}`);
    }
    const sims = Array.from(scoreResult.sims);
    const keep = new Uint8Array(mix.length);
    let keptWindows = 0;
    windows.forEach(([a, b], i) => {
      if (sims[i] >= THRESHOLD) {
        keptWindows++;
        keep.fill(1, a, b);
      }
    });
    const out = new Float32Array(mix.length);
    for (let i = 0; i < mix.length; i++) out[i] = keep[i] ? mix[i] : 0;

    const mask = activityMask(target, SR);
    const siSdrOut = M.siSdr(out, target, mask);
    const siSdrIn = M.siSdr(mix, target, mask);
    const speechDelta = M.rmsDb(out, mask) - M.rmsDb(target, mask);
    const fricDelta = M.bandEnergyDb(out, 3500, 9000, SR, 2048, mask) - M.bandEnergyDb(target, 3500, 9000, SR, 2048, mask);
    rows.push({
      clip: clip.id,
      enroll,
      keptWindows,
      windows: windows.length,
      meanSim: sims.reduce((a, b) => a + b, 0) / sims.length,
      siSdrDelta: siSdrOut - siSdrIn,
      speechLevelDelta: speechDelta,
      fricativeDelta: fricDelta,
      enrollNote,
    });
    console.log(`[${clip.id}] ${enroll}: kept ${keptWindows}/${windows.length} windows, mean sim ${rows.at(-1).meanSim.toFixed(3)}, SI-SDR Δ ${rows.at(-1).siSdrDelta.toFixed(2)} dB, speech Δ ${speechDelta.toFixed(2)} dB, fricative Δ ${fricDelta.toFixed(2)} dB`);
  }

  const mean = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length;
  const summary = {
    prototype: 'ECAPA-guided target-speaker frame selection (harness only, NOT integrated)',
    enroll,
    enrollCaveat: enroll === 'oracle'
      ? 'Oracle enrollment uses ground truth; these numbers test the mechanism only and must never be quoted as product performance.'
      : 'Pseudo enrollment embeds mixture audio; weakness here is expected and is itself the finding.',
    clips: rows.length,
    meanSiSdrDelta: mean('siSdrDelta'),
    meanSpeechLevelDelta: mean('speechLevelDelta'),
    meanFricativeDelta: mean('fricativeDelta'),
    gate: 'CORPUS_THRESHOLDS.md overlap bars: mean SI-SDR Δ ≥ 0 dB, speech-level ±3 dB, fricative ≥ −6 dB. Prototype is not integrated regardless of this run.',
    gateMet: mean('siSdrDelta') >= 0 && Math.abs(mean('speechLevelDelta')) <= 3 && mean('fricativeDelta') >= -6,
    rows,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const lines = [
    '# Target-extraction prototype (VIP-016 box 2 — prototype only, NOT integrated)', '',
    `- Enrollment: ${enroll} — ${summary.enrollCaveat}`,
    `- Clips: ${rows.length} overlap clips; threshold ${THRESHOLD}, windows ${WIN_SEC}s / hop ${HOP_SEC}s.`,
    `- Mean SI-SDR Δ: ${summary.meanSiSdrDelta.toFixed(2)} dB (gate ≥ 0); speech-level Δ: ${summary.meanSpeechLevelDelta.toFixed(2)} dB (gate ±3); fricative Δ: ${summary.meanFricativeDelta.toFixed(2)} dB (gate ≥ −6).`,
    `- Gate met: ${summary.gateMet ? 'YES (still not integrated — a prototype run is not a product chain)' : 'NO — correctly not integrated.'}`,
    '',
    ...rows.map((r) => `- ${r.clip}: kept ${r.keptWindows}/${r.windows} windows, mean sim ${r.meanSim.toFixed(3)}, SI-SDR Δ ${r.siSdrDelta.toFixed(2)} dB, speech Δ ${r.speechLevelDelta.toFixed(2)} dB, fricative Δ ${r.fricativeDelta.toFixed(2)} dB.`),
  ];
  fs.writeFileSync(path.join(outDir, 'report.md'), `${lines.join('\n')}\n`);
  console.log(`[target-extract-proto] DONE — mean SI-SDR Δ ${summary.meanSiSdrDelta.toFixed(2)} dB, gate ${summary.gateMet ? 'MET (not integrated)' : 'NOT MET'} → output/target-extract-proto/report.md`);
}

main().catch((e) => { console.error(e); process.exit(1); });
