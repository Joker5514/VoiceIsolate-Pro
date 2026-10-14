/*
 * VoiceIsolate Pro — optional ECAPA-TDNN speaker embeddings (Layer 2)
 *
 * Classic worker (the vendored ORT build is a classic script). Loads the
 * ecapa_tdnn entry the host forwards from ModelManifest, refuses it unless
 * the bytes match the pinned SHA-256, and scores audio locally. It is only
 * used by target-speaker enrollment and isolation, after Process, on an
 * explicit user click: never from a slider, never on a live input.
 *
 * Messages in:
 *   { type: 'init', entry }
 *   { type: 'embed', requestId, samples, sampleRate }
 *   { type: 'score', requestId, samples, sampleRate, target, windows }
 *       windows: [start, end) in input samples; returns one cosine per window
 *   { type: 'cluster', requestId, samples, sampleRate, segments }
 *       segments: { speakerId, start, end } seconds; returns mean embedding per speaker
 * Messages out: ready | unavailable | result | progress | error
 */
'use strict';

/* global VipSpeakerFeatures */
importScripts('/lib/ort.min.js', '/src/workers/SpeakerFeatures.js');

const BATCH = 16;
const MIN_SEGMENT_SEC = 0.5;
const MAX_SEGMENT_SEC = 10;
let session = null;
let io = null;

function toHex(buf) {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function normalise(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // both unit length
}

async function init(entry) {
  if (!entry?.url || !/^[0-9a-f]{64}$/.test(entry.sha256 || '')) {
    return { type: 'unavailable', reason: 'ecapa_tdnn is not pinned in ModelManifest' };
  }
  let res;
  try {
    res = await fetch(entry.url);
  } catch (err) {
    return { type: 'unavailable', reason: `fetch failed: ${err?.message || err}` };
  }
  if (!res.ok) return { type: 'unavailable', reason: `model not installed (HTTP ${res.status})` };
  const bytes = await res.arrayBuffer();
  const digest = toHex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== entry.sha256) {
    return { type: 'unavailable', reason: `integrity mismatch (got ${digest.slice(0, 12)}…)` };
  }
  ort.env.wasm.wasmPaths = '/lib/';
  if (!self.crossOriginIsolated) ort.env.wasm.numThreads = 1;
  session = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: ['wasm'] });
  io = entry.io || { input: 'feats', output: 'embs' };
  return { type: 'ready', dims: entry.embeddingDims || 192 };
}

/** Embeddings for equal-length CMN'd feature windows, BATCH at a time. */
async function runBatches(raw, frameWindows, onProgress) {
  const F = VipSpeakerFeatures;
  const out = [];
  for (let i = 0; i < frameWindows.length; i += BATCH) {
    const chunk = frameWindows.slice(i, i + BATCH);
    const { data, frames } = F.windowFeatures(raw, chunk);
    const res = await session.run({ [io.input]: new ort.Tensor('float32', data, [chunk.length, frames, F.FBANK_BINS]) });
    const embs = res[io.output].data;
    const dims = embs.length / chunk.length;
    for (let b = 0; b < chunk.length; b++) out.push(normalise(embs.subarray(b * dims, (b + 1) * dims)));
    if (onProgress) onProgress(Math.min(i + BATCH, frameWindows.length), frameWindows.length);
  }
  return out;
}

function prepare(samples, sampleRate) {
  const F = VipSpeakerFeatures;
  const x16 = F.resampleTo16k(samples, sampleRate);
  const { data: raw, frames: total } = F.kaldiFbank(x16, { cmn: false });
  /** Map an input-sample range to a fbank frame range (10 ms frames, 25 ms long). */
  const toFrames = (a, b) => {
    const s16 = Math.round((a * F.ECAPA_SAMPLE_RATE) / sampleRate);
    const len = F.fbankFrameCount(Math.round(((b - a) * F.ECAPA_SAMPLE_RATE) / sampleRate));
    const start = Math.min(Math.round(s16 / 160), Math.max(0, total - len));
    return [start, Math.min(total, start + len)];
  };
  return { raw, total, toFrames };
}

async function embedAll(raw, frameWindows, onProgress) {
  // windowFeatures needs equal lengths per batch: group by frame count.
  const groups = new Map();
  frameWindows.forEach((w, i) => {
    const n = w[1] - w[0];
    if (!groups.has(n)) groups.set(n, []);
    groups.get(n).push(i);
  });
  const out = new Array(frameWindows.length);
  let done = 0;
  for (const idx of groups.values()) {
    const embs = await runBatches(raw, idx.map((i) => frameWindows[i]), (d) => onProgress?.(done + d, frameWindows.length));
    idx.forEach((i, k) => { out[i] = embs[k]; });
    done += idx.length;
  }
  return out;
}

async function handle(msg, progress) {
  const { samples, sampleRate } = msg;
  if (msg.type === 'embed') {
    const { raw, total } = prepare(samples, sampleRate);
    if (total < 10) throw new Error('segment too short for a speaker embedding');
    const [emb] = await embedAll(raw, [[0, total]]);
    return { embedding: emb };
  }
  if (msg.type === 'score') {
    const { raw, total, toFrames } = prepare(samples, sampleRate);
    const frameWindows = msg.windows.map(([a, b]) => toFrames(a, b)).filter(([a, b]) => b - a >= 10 && b <= total);
    if (frameWindows.length !== msg.windows.length) throw new Error('a scoring window is shorter than 0.1 s');
    const target = Float32Array.from(msg.target);
    const embs = await embedAll(raw, frameWindows, progress);
    return { sims: Float32Array.from(embs, (e) => cosine(e, target)) };
  }
  if (msg.type === 'cluster') {
    const { raw, toFrames } = prepare(samples, sampleRate);
    const picked = [];
    for (const seg of msg.segments || []) {
      if (!seg || seg.speakerId == null || !(seg.end - seg.start >= MIN_SEGMENT_SEC)) continue;
      const end = Math.min(seg.end, seg.start + MAX_SEGMENT_SEC);
      const a = Math.max(0, Math.floor(seg.start * sampleRate));
      const b = Math.min(samples.length, Math.ceil(end * sampleRate));
      if (b - a < MIN_SEGMENT_SEC * sampleRate) continue;
      picked.push({ speakerId: String(seg.speakerId), frames: toFrames(a, b) });
    }
    const embs = await embedAll(raw, picked.map((p) => p.frames), progress);
    const sums = new Map();
    picked.forEach((p, i) => {
      const row = sums.get(p.speakerId) || { sum: new Float32Array(embs[i].length), n: 0 };
      for (let k = 0; k < row.sum.length; k++) row.sum[k] += embs[i][k];
      row.n += 1;
      sums.set(p.speakerId, row);
    });
    return {
      clusters: [...sums].map(([speakerId, row]) => ({ speakerId, embedding: normalise(row.sum) })),
    };
  }
  throw new Error(`unknown message type ${msg.type}`);
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  if (msg.type === 'init') {
    try {
      self.postMessage(await init(msg.entry));
    } catch (err) {
      self.postMessage({ type: 'unavailable', reason: `[VIP] ECAPA init failed: ${err?.message || err}` });
    }
    return;
  }
  const { requestId } = msg;
  if (!session) {
    self.postMessage({ type: 'error', requestId, message: 'ECAPA model is not loaded' });
    return;
  }
  try {
    const progress = (done, total) => self.postMessage({ type: 'progress', requestId, done, total });
    self.postMessage({ type: 'result', requestId, ...(await handle(msg, progress)) });
  } catch (err) {
    self.postMessage({ type: 'error', requestId, message: String(err?.message || err) });
  }
};
