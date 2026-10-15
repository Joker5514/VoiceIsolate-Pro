'use strict';
/**
 * SpeakerEmbeddingWorker (classic worker) in a vm sandbox: pin refusal, the
 * embed/score/cluster contract and batching run against a stub ORT; the real
 * ECAPA model runs only when `pnpm models:fetch-ecapa` has installed it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createSpeakerWorker, realOrt, ecapaEntry } = require('../scripts/quality/lib/speaker-worker-node.cjs');

const ROOT = path.join(__dirname, '..');
const MODEL_FILE = path.join(ROOT, 'public/app/models/ecapa_tdnn.onnx');
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Stub ORT: embedding = per-bin mean of the features (80 dims) zero-padded to 192. */
function stubOrt(calls) {
  class Tensor { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } }
  return {
    env: { wasm: {} },
    Tensor,
    InferenceSession: {
      async create() {
        return {
          async run(feeds) {
            const t = feeds.feats;
            calls.push(t.dims);
            const [B, T, D] = t.dims;
            const out = new Float32Array(B * 192);
            for (let b = 0; b < B; b++) {
              for (let f = 0; f < T; f++) {
                for (let d = 0; d < D; d++) out[b * 192 + d] += t.data[(b * T + f) * D + d] / T + (d === 0 ? 1 : 0) / T;
              }
            }
            return { embs: { data: out } };
          },
        };
      },
    },
  };
}

const createWorker = createSpeakerWorker;

function voice(f0, sr, seconds, seed = 1) {
  const x = new Float32Array(Math.round(sr * seconds));
  let s = seed;
  for (let i = 0; i < x.length; i++) {
    s = (s * 16807) % 2147483647;
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin((2 * Math.PI * f0 * h * i) / sr) / h;
    x[i] = 0.2 * v * (0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / sr)) + 0.01 * (s / 2147483647 - 0.5);
  }
  return x;
}

const ANY_PUBLIC_MODEL = '/app/models/silero_vad.onnx';
const anyModelSha = sha(fs.readFileSync(path.join(ROOT, 'public', ANY_PUBLIC_MODEL)));
const entry = (over = {}) => ({ url: ANY_PUBLIC_MODEL, sha256: anyModelSha, io: { input: 'feats', output: 'embs' }, embeddingDims: 192, ...over });

describe('SpeakerEmbeddingWorker init', () => {
  test('a missing model reports unavailable (fallback), not an error', async () => {
    const w = createWorker(stubOrt([]));
    const [m] = await w.send({ type: 'init', entry: entry({ url: '/app/models/does-not-exist.onnx' }) });
    expect(m).toMatchObject({ type: 'unavailable' });
    expect(m.reason).toMatch(/not installed/);
  });

  test('bytes that do not match the pinned sha256 are refused', async () => {
    const w = createWorker(stubOrt([]));
    const [m] = await w.send({ type: 'init', entry: entry({ sha256: 'a'.repeat(64) }) });
    expect(m).toMatchObject({ type: 'unavailable' });
    expect(m.reason).toMatch(/integrity mismatch/);
  });

  test('an unpinned entry is refused before any fetch', async () => {
    const w = createWorker(stubOrt([]));
    const [m] = await w.send({ type: 'init', entry: entry({ sha256: null }) });
    expect(m.reason).toMatch(/not pinned/);
    expect(w.fetched).toEqual([]);
  });

  test('requests before a successful init are errors', async () => {
    const w = createWorker(stubOrt([]));
    const [m] = await w.send({ type: 'embed', requestId: 'r1', samples: new Float32Array(16000), sampleRate: 16000 });
    expect(m).toMatchObject({ type: 'error', requestId: 'r1' });
  });
});

describe('SpeakerEmbeddingWorker contract (stub ORT)', () => {
  let w;
  let calls;
  beforeEach(async () => {
    calls = [];
    w = createWorker(stubOrt(calls));
    const [m] = await w.send({ type: 'init', entry: entry() });
    expect(m).toMatchObject({ type: 'ready', dims: 192 });
  });

  test('embed returns a unit-length 192-D vector at any input rate', async () => {
    const out = await w.send({ type: 'embed', requestId: 'e', samples: voice(140, 48000, 2), sampleRate: 48000 });
    const r = out.find((m) => m.type === 'result');
    expect(r.embedding).toHaveLength(192);
    const n = Math.hypot(...r.embedding);
    expect(n).toBeCloseTo(1, 5);
  });

  test('score returns one similarity per window, in batches of at most 16, with progress', async () => {
    const sr = 48000;
    const x = voice(140, sr, 12);
    const [enr] = (await w.send({ type: 'embed', requestId: 'e', samples: x.subarray(0, sr * 3), sampleRate: sr }));
    const windows = [];
    for (let a = 0; a + 1.5 * sr <= x.length; a += sr / 2) windows.push([a, a + 1.5 * sr]);
    const out = await w.send({ type: 'score', requestId: 's', samples: x, sampleRate: sr, target: Array.from(enr.embedding), windows });
    const r = out.find((m) => m.type === 'result');
    expect(r.sims).toHaveLength(windows.length);
    for (const v of r.sims) expect(v).toBeGreaterThan(0.9); // same stationary voice
    expect(calls.every((d) => d[0] <= 16 && d[2] === 80)).toBe(true);
    expect(out.filter((m) => m.type === 'progress').pop()).toMatchObject({ done: windows.length, total: windows.length });
  });

  test('cluster averages per speaker and skips segments under 0.5 s', async () => {
    const sr = 16000;
    const x = new Float32Array(sr * 8);
    x.set(voice(110, sr, 4), 0);
    x.set(voice(260, sr, 4, 7), sr * 4);
    const out = await w.send({
      type: 'cluster', requestId: 'c', samples: x, sampleRate: sr,
      segments: [
        { speakerId: 'A', start: 0, end: 2 }, { speakerId: 'A', start: 2, end: 4 },
        { speakerId: 'B', start: 4, end: 8 }, { speakerId: 'C', start: 7.8, end: 8 },
      ],
    });
    const r = out.find((m) => m.type === 'result');
    expect(r.clusters.map((c) => c.speakerId).sort()).toEqual(['A', 'B']);
    for (const c of r.clusters) expect(Math.hypot(...c.embedding)).toBeCloseTo(1, 5);
  });
});

const haveModel = fs.existsSync(MODEL_FILE);
(haveModel ? describe : describe.skip)('SpeakerEmbeddingWorker with the real ECAPA model', () => {
  test('installed file matches the manifest pin and embeds deterministically', async () => {
    const e = ecapaEntry();
    expect(sha(fs.readFileSync(MODEL_FILE))).toBe(e.sha256);
    const w = createWorker(realOrt());
    const [m] = await w.send({ type: 'init', entry: e });
    expect([m.type, m.reason]).toEqual(['ready', undefined]);
    const x = voice(130, 16000, 3);
    const a = (await w.send({ type: 'embed', requestId: 'a', samples: x, sampleRate: 16000 }))[0].embedding;
    const b = (await w.send({ type: 'embed', requestId: 'b', samples: x, sampleRate: 16000 }))[0].embedding;
    expect(a).toHaveLength(192);
    let dot = 0;
    for (let i = 0; i < 192; i++) dot += a[i] * b[i];
    expect(dot).toBeGreaterThan(0.9999);
  }, 60000);
});
