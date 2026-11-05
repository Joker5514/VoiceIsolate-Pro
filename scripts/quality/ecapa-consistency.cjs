#!/usr/bin/env node
'use strict';

/**
 * VIP-015 — ECAPA-TDNN consistency probe (NOT an identification eval).
 *
 * The corpus has no speaker labels, so identification accuracy, false
 * attribution, and EER cannot be measured here (speaker-eval.mjs does
 * that once labeled recordings exist). What CAN be measured without
 * labels:
 *
 *   - same-source consistency: cosine similarity between embeddings of
 *     the two halves of one clip (exact — same recording by
 *     construction);
 *   - cross-clip similarity distribution: halves of different clips.
 *     Caveat: different clips MAY share a speaker (the corpus carries
 *     no speaker labels, and e.g. several clips derive from the same
 *     MS-SNSD clean sources), so cross similarity is an upper bound on
 *     true different-speaker similarity, not a different-speaker score.
 *   - ECAPA vs the local mel voiceprint on the same pairs;
 *   - ECAPA load time, per-embedding runtime, model size, memory.
 *
 * A method that cannot even separate same-source pairs from cross-clip
 * pairs is not worth fusing; a method that can is a candidate for the
 * fusion spec (docs/guides/SPEAKER_FUSION.md), pending labeled data.
 * No identity is asserted from any number here.
 *
 * Usage: node scripts/quality/ecapa-consistency.cjs
 * Output: output/ecapa-consistency/report.json + report.md.
 * Requires public/app/models/ecapa_tdnn.onnx (pnpm models:fetch-ecapa);
 * exits 2 with a clear message when it is absent (the model is
 * optional — absence is not a product failure).
 */
const fs = require('fs');
const path = require('path');
const { createSpeakerWorker, realOrt, ecapaEntry } = require('./lib/speaker-worker-node.cjs');

const ROOT = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'output', 'ecapa-consistency');

function readWav16(file) {
  const b = fs.readFileSync(file);
  let off = 12;
  let fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || fmt.ch !== 1) throw new Error(`${file}: need 16-bit mono PCM`);
      const x = new Float32Array(size / 2);
      for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(off + 8 + 2 * i) / 32768;
      return x;
    }
    off += 8 + size + (size & 1);
  }
  throw new Error(`${file}: no data chunk`);
}

function upsampleLinear(x) {
  const out = new Float32Array(x.length * 3);
  for (let i = 0; i < x.length; i++) {
    const base = i * 3;
    out[base] = x[i];
    if (i + 1 < x.length) {
      out[base + 1] = (2 * x[i] + x[i + 1]) / 3;
      out[base + 2] = (x[i] + 2 * x[i + 1]) / 3;
    } else {
      out[base + 1] = x[i];
      out[base + 2] = x[i];
    }
  }
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

function stats(v) {
  const s = [...v].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, mean: Math.round(mean * 1000) / 1000, min: Math.round(s[0] * 1000) / 1000, p25: Math.round(s[Math.floor(s.length * 0.25)] * 1000) / 1000, median: Math.round(s[Math.floor(s.length / 2)] * 1000) / 1000, max: Math.round(s[s.length - 1] * 1000) / 1000 };
}

async function main() {
  const modelPath = path.join(ROOT, 'public/app/models/ecapa_tdnn.onnx');
  if (!fs.existsSync(modelPath)) {
    console.error('[ecapa] model absent — run `pnpm models:fetch-ecapa` first. The model is optional; absence is not a product failure.');
    process.exit(2);
  }
  const { extractLocalVoiceprint } = await import('../../src/core/TargetSpeaker.js');
  const worker = createSpeakerWorker(realOrt());
  const entry = ecapaEntry();
  const tInit0 = performance.now();
  const initReplies = await worker.send({ type: 'init', entry });
  const initMs = Math.round(performance.now() - tInit0);
  const ready = initReplies.find((m) => m.type === 'ready');
  if (!ready) throw new Error(`ECAPA init failed: ${JSON.stringify(initReplies)}`);
  console.log(`[ecapa] ready: dims=${ready.dims}, init=${initMs} ms, model=${(fs.statSync(modelPath).size / 1048576).toFixed(1)} MB`);

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/quality/corpus/corpus-manifest.json'), 'utf8'));
  const picked = [];
  for (const cat of ['clean-speech', 'quiet-speech', 'noisy-speech/hvac', 'overlapping-speakers']) {
    picked.push(...manifest.clips.filter((c) => c.category === cat).slice(0, 2));
  }
  const embs = {}; // clipId -> { ecapa: [h1, h2], mel: [h1, h2] }
  const runtimes = [];
  for (const clip of picked) {
    const x48 = upsampleLinear(readWav16(path.join(ROOT, 'scripts/quality/corpus', clip.path)));
    const half = Math.floor(x48.length / 2);
    const halves = [x48.subarray(0, half), x48.subarray(half)];
    const ec = [];
    for (const h of halves) {
      const t0 = performance.now();
      const replies = await worker.send({ type: 'embed', samples: h, sampleRate: 48000 });
      runtimes.push(performance.now() - t0);
      const emb = replies.find((m) => m.embedding)?.embedding;
      if (!emb) throw new Error(`no embedding for ${clip.id}: ${JSON.stringify(replies)}`);
      ec.push(Float32Array.from(emb));
    }
    const mel = halves.map((h) => extractLocalVoiceprint(h, 48000));
    embs[clip.id] = { ecapa: ec, mel };
    console.log(`[ecapa] ${clip.id}: ecapa same-half cos=${cosine(ec[0], ec[1]).toFixed(3)}, mel same-half cos=${cosine(mel[0], mel[1]).toFixed(3)}`);
  }
  const same = { ecapa: [], mel: [] };
  const cross = { ecapa: [], mel: [] };
  const ids = Object.keys(embs);
  for (const id of ids) {
    same.ecapa.push(cosine(embs[id].ecapa[0], embs[id].ecapa[1]));
    same.mel.push(cosine(embs[id].mel[0], embs[id].mel[1]));
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      cross.ecapa.push(cosine(embs[ids[i]].ecapa[0], embs[ids[j]].ecapa[0]));
      cross.mel.push(cosine(embs[ids[i]].mel[0], embs[ids[j]].mel[0]));
    }
  }
  const report = {
    generatedAt: new Date().toISOString(),
    model: { file: 'public/app/models/ecapa_tdnn.onnx', bytes: fs.statSync(modelPath).size, dims: ready.dims, initMs },
    clips: ids,
    runtimePerEmbeddingMs: { mean: Math.round(runtimes.reduce((a, b) => a + b, 0) / runtimes.length), max: Math.round(Math.max(...runtimes)) },
    sameSource: { ecapa: stats(same.ecapa), mel: stats(same.mel) },
    crossClip: { ecapa: stats(cross.ecapa), mel: stats(cross.mel) },
    caveat: 'Cross-clip pairs may share a speaker (no speaker labels in corpus); cross stats are an upper bound on different-speaker similarity, not identification accuracy.',
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const lines = [
    '# ECAPA consistency probe — VIP-015 (not an identification eval)',
    '',
    `Model: ${report.model.bytes} bytes, dims ${ready.dims}, init ${initMs} ms, mean embed ${report.runtimePerEmbeddingMs.mean} ms.`,
    '',
    '| Pair type | Method | n | Mean | Min | p25 | Median | Max |',
    '|---|---|---|---|---|---|---|---|',
    `| same-source | ECAPA | ${report.sameSource.ecapa.n} | ${report.sameSource.ecapa.mean} | ${report.sameSource.ecapa.min} | ${report.sameSource.ecapa.p25} | ${report.sameSource.ecapa.median} | ${report.sameSource.ecapa.max} |`,
    `| same-source | mel | ${report.sameSource.mel.n} | ${report.sameSource.mel.mean} | ${report.sameSource.mel.min} | ${report.sameSource.mel.p25} | ${report.sameSource.mel.median} | ${report.sameSource.mel.max} |`,
    `| cross-clip | ECAPA | ${report.crossClip.ecapa.n} | ${report.crossClip.ecapa.mean} | ${report.crossClip.ecapa.min} | ${report.crossClip.ecapa.p25} | ${report.crossClip.ecapa.median} | ${report.crossClip.ecapa.max} |`,
    `| cross-clip | mel | ${report.crossClip.mel.n} | ${report.crossClip.mel.mean} | ${report.crossClip.mel.min} | ${report.crossClip.mel.p25} | ${report.crossClip.mel.median} | ${report.crossClip.mel.max} |`,
    '',
    report.caveat,
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'report.md'), `${lines.join('\n')}\n`);
  console.log(`[ecapa] DONE → output/ecapa-consistency/report.json + report.md`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
