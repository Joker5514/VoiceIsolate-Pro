#!/usr/bin/env node
/**
 * Target-speaker window scoring: ECAPA (through the real
 * SpeakerEmbeddingWorker) vs the local mel voiceprint.
 *
 *   node scripts/quality/speaker-eval.mjs <dir>
 *
 * <dir>/<speakerId>/*.wav: 16-bit PCM mono WAV, several 3–10 s utterances
 * per speaker (e.g. LibriSpeech test-clean via
 * `ffmpeg -i in.flac -ac 1 -ar 16000 out.wav`). Each speaker enrolls on the
 * first 3 s of their first file; every 1.5 s window (0.5 s hop) of the other
 * files is scored against every enrollment. Needs `pnpm models:fetch-ecapa`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  ECAPA_SIMILARITY, DEFAULT_SIM_THRESHOLD, similarityWindows, extractLocalVoiceprint, cosineSimilarity,
} from '../../src/core/TargetSpeaker.js';

const require = createRequire(import.meta.url);
const { createSpeakerWorker, realOrt, ecapaEntry } = require('./lib/speaker-worker-node.cjs');

function readWav(file) {
  const b = fs.readFileSync(file);
  let off = 12;
  let fmt = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(off + 8), ch: b.readUInt16LE(off + 10), sr: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || fmt.ch !== 1) throw new Error(`${file}: need 16-bit mono PCM`);
      const x = new Float32Array(size / 2);
      for (let i = 0; i < x.length; i++) x[i] = b.readInt16LE(off + 8 + 2 * i) / 32768;
      return { x, sr: fmt.sr };
    }
    off += 8 + size + (size & 1);
  }
  throw new Error(`${file}: no data chunk`);
}

function rates(same, diff, t) {
  return {
    frr: same.filter((v) => v < t).length / same.length,
    far: diff.filter((v) => v >= t).length / diff.length,
  };
}
function eer(same, diff) {
  let best = { gap: 2 };
  for (let t = -1; t <= 1; t += 0.001) {
    const { frr, far } = rates(same, diff, t);
    if (Math.abs(far - frr) < best.gap) best = { gap: Math.abs(far - frr), eer: (far + frr) / 2, t };
  }
  return best;
}
const pct = (v) => `${(100 * v).toFixed(1)}%`;

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node scripts/quality/speaker-eval.mjs <dir with <speaker>/*.wav>');
  process.exit(2);
}
const speakers = fs.readdirSync(dir).filter((d) => fs.statSync(path.join(dir, d)).isDirectory()).sort();
const files = Object.fromEntries(speakers.map((s) => [s, fs.readdirSync(path.join(dir, s)).filter((f) => f.endsWith('.wav')).sort()
  .map((f) => readWav(path.join(dir, s, f)))]));
// Each speaker enrolls on its first utterance and is tested on the rest.
const short = speakers.filter((s) => files[s].length < 2);
if (speakers.length < 2 || short.length) {
  console.error(`[speaker-eval] need at least two speakers with two or more .wav files each${short.length ? ` (too few: ${short.join(', ')})` : ''}`);
  process.exit(2);
}

const worker = createSpeakerWorker(realOrt());
const [init] = await worker.send({ type: 'init', entry: ecapaEntry() });
if (init.type !== 'ready') {
  console.error(`[speaker-eval] ECAPA unavailable: ${init.reason} (run pnpm models:fetch-ecapa)`);
  process.exit(1);
}
const call = async (msg) => {
  const result = (await worker.send(msg)).find((m) => m.type === 'result' || m.type === 'error');
  if (!result || result.type === 'error') throw new Error(result?.message || 'speaker worker returned no result');
  return result;
};

const enrollE = {};
const enrollM = {};
for (const s of speakers) {
  const { x, sr } = files[s][0];
  const seg = x.subarray(0, Math.min(x.length, 3 * sr));
  enrollE[s] = (await call({ type: 'embed', requestId: s, samples: seg, sampleRate: sr })).embedding;
  enrollM[s] = extractLocalVoiceprint(seg, sr);
}
const res = { ecapa: { same: [], diff: [] }, mel: { same: [], diff: [] } };
let windowsTotal = 0;
for (const s of speakers) {
  for (const { x, sr } of files[s].slice(1)) {
    const windows = similarityWindows(x.length, sr, ECAPA_SIMILARITY.windowSec, ECAPA_SIMILARITY.hopSec);
    windowsTotal += windows.length;
    const mels = windows.map(([a, b]) => extractLocalVoiceprint(x.subarray(a, b), sr));
    // Embed every window once (one 'cluster' per window), then compare to all enrollments.
    const { clusters } = await call({
      type: 'cluster', requestId: `${s}-${windowsTotal}`, samples: x, sampleRate: sr,
      segments: windows.map(([a, b], i) => ({ speakerId: i, start: a / sr, end: b / sr })),
    });
    const embs = clusters.sort((p, q) => Number(p.speakerId) - Number(q.speakerId)).map((c) => c.embedding);
    for (const t of speakers) {
      for (const e of embs) res.ecapa[s === t ? 'same' : 'diff'].push(cosineSimilarity(e, enrollE[t]));
      for (const m of mels) res.mel[s === t ? 'same' : 'diff'].push(cosineSimilarity(m, enrollM[t]));
    }
  }
}
console.log(`[speaker-eval] ${speakers.length} speakers, ${windowsTotal} windows of ${ECAPA_SIMILARITY.windowSec} s, each embedded once`);
for (const [name, thr] of [['ecapa', ECAPA_SIMILARITY.threshold], ['mel', DEFAULT_SIM_THRESHOLD]]) {
  const { same, diff } = res[name];
  if (!same.length || !diff.length) {
    console.error('[speaker-eval] need at least two speakers, each with two or more utterances');
    process.exit(2);
  }
  const e = eer(same, diff);
  const at = rates(same, diff, thr);
  console.log(`${name.padEnd(5)} EER ${pct(e.eer)} at ${e.t.toFixed(3)} | at default ${thr}: target missed ${pct(at.frr)}, others passed ${pct(at.far)}`);
}
