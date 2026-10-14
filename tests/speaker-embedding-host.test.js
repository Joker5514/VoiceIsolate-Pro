'use strict';
/**
 * SpeakerEmbeddingHost (pipeline) with a fake worker, plus the shared
 * TargetSpeaker window/gain/match helpers the ECAPA path uses.
 */
let hostMod;
let ts;

beforeAll(async () => {
  hostMod = await import('../src/pipeline/SpeakerEmbeddingHost.js');
  ts = await import('../src/core/TargetSpeaker.js');
});

/** Fake worker: `reply(msg, post)` decides what it answers. */
function fakeWorker(reply) {
  const w = {
    sent: [],
    terminated: false,
    postMessage(msg) {
      w.sent.push(msg);
      setTimeout(() => reply(msg, (m) => w.onmessage?.({ data: m })), 0);
    },
    terminate() { w.terminated = true; },
  };
  return w;
}

describe('createSpeakerEmbeddingHost', () => {
  test('ready() is false (not a throw) when the model is unavailable, and requests reject', async () => {
    const worker = fakeWorker((m, post) => post({ type: 'unavailable', reason: 'model not installed (HTTP 404)' }));
    const host = hostMod.createSpeakerEmbeddingHost({ createWorker: () => worker });
    expect(await host.ready()).toBe(false);
    expect(host.unavailableReason).toMatch(/not installed/);
    await expect(host.embed(new Float32Array(16000), 16000)).rejects.toThrow(/unavailable/);
  });

  test('forwards the pinned ecapa_tdnn entry on init', async () => {
    const worker = fakeWorker((m, post) => post({ type: 'ready' }));
    const host = hostMod.createSpeakerEmbeddingHost({ createWorker: () => worker });
    expect(await host.ready()).toBe(true);
    expect(worker.sent[0].type).toBe('init');
    expect(worker.sent[0].entry.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(worker.sent[0].entry.io).toEqual({ input: 'feats', output: 'embs' });
  });

  test('a worker that cannot be constructed means fallback, not a crash', async () => {
    const host = hostMod.createSpeakerEmbeddingHost({ createWorker: () => { throw new Error('no Worker'); } });
    expect(await host.ready()).toBe(false);
    expect(host.unavailableReason).toMatch(/no Worker/);
  });

  test('requests copy the caller PCM, relay progress and resolve results', async () => {
    const worker = fakeWorker((m, post) => {
      if (m.type === 'init') return post({ type: 'ready' });
      post({ type: 'progress', requestId: m.requestId, done: 1, total: 2 });
      post({ type: 'result', requestId: m.requestId, sims: new Float32Array([0.5, 0.1]) });
    });
    const host = hostMod.createSpeakerEmbeddingHost({ createWorker: () => worker });
    const pcm = new Float32Array(48000).fill(0.1);
    const progress = [];
    const sims = await host.scoreWindows(pcm, 48000, new Float32Array(192), [[0, 24000], [24000, 48000]], (d, t) => progress.push([d, t]));
    expect(Array.from(sims)).toEqual([0.5, Float32Array.from([0.1])[0]]);
    expect(progress).toEqual([[1, 2]]);
    const msg = worker.sent.find((m) => m.type === 'score');
    expect(msg.samples).not.toBe(pcm);
    expect(pcm[0]).toBeCloseTo(0.1); // caller's array untouched
  });

  test('worker errors reject with the worker message', async () => {
    const worker = fakeWorker((m, post) => (m.type === 'init'
      ? post({ type: 'ready' })
      : post({ type: 'error', requestId: m.requestId, message: 'segment too short' })));
    const host = hostMod.createSpeakerEmbeddingHost({ createWorker: () => worker });
    await expect(host.embed(new Float32Array(100), 16000)).rejects.toThrow(/segment too short/);
  });

  test('dispose terminates the worker and later calls fall back', async () => {
    const worker = fakeWorker((m, post) => post({ type: 'ready' }));
    const host = hostMod.createSpeakerEmbeddingHost({ createWorker: () => worker });
    await host.ready();
    host.dispose();
    expect(worker.terminated).toBe(true);
    expect(await host.ready()).toBe(false);
  });
});

describe('TargetSpeaker shared helpers', () => {
  test('similarityWindows: hop grid, tail coverage and short input', () => {
    const sr = 16000;
    expect(ts.similarityWindows(sr * 3, sr, 1.5, 0.5)).toEqual([[0, 24000], [8000, 32000], [16000, 40000], [24000, 48000]]);
    const tail = ts.similarityWindows(sr * 3.2, sr, 1.5, 0.5, { coverTail: true });
    expect(tail[tail.length - 1]).toEqual([sr * 3.2 - 24000, sr * 3.2]);
    expect(ts.similarityWindows(8000, sr, 1.5, 0.5)).toEqual([]);
    expect(ts.similarityWindows(8000, sr, 1.5, 0.5, { allowShort: true })).toEqual([[0, 8000]]);
  });

  test('gainCurveFromSimilarities maps around the threshold with a floor of 0.12', () => {
    const sr = 1000;
    const windows = [[0, 1000], [1000, 2000], [2000, 3000]];
    const g = ts.gainCurveFromSimilarities(3000, sr, windows, [0.1, 0.35, 0.9], {
      threshold: 0.35, softWidth: 0.08, smoothMs: 0.001, maxStepPerMs: 1e9,
    });
    expect(g[500]).toBeCloseTo(0.12, 2);
    expect(g[1500]).toBeCloseTo(0.12 + 0.5 * 0.88, 2);
    expect(g[2500]).toBeCloseTo(1, 2);
  });

  test('buildTargetGainCurve (mel) is unchanged by the refactor', () => {
    const sr = 16000;
    const x = new Float32Array(sr * 2);
    for (let i = 0; i < x.length; i++) x[i] = 0.2 * Math.sin((2 * Math.PI * 180 * i) / sr) * (i < sr ? 1 : 0.05);
    const emb = ts.extractLocalVoiceprint(x.subarray(0, sr), sr);
    const viaHelpers = ts.gainCurveFromSimilarities(x.length, sr,
      ts.similarityWindows(x.length, sr, 0.2, 0.05),
      ts.similarityWindows(x.length, sr, 0.2, 0.05).map(([a, b]) => ts.cosineSimilarity(ts.extractLocalVoiceprint(x.subarray(a, b), sr), emb)));
    expect(Array.from(ts.buildTargetGainCurve(x, sr, emb))).toEqual(Array.from(viaHelpers));
  });

  test('matchClusterEmbeddings needs two clusters and picks the closest', () => {
    const t = new Float32Array([1, 0, 0]);
    expect(ts.matchClusterEmbeddings([{ speakerId: 'A', embedding: [1, 0, 0] }], t)).toBeNull();
    const m = ts.matchClusterEmbeddings([
      { speakerId: 'A', embedding: [0.2, 1, 0] },
      { speakerId: 'B', embedding: [0.9, 0.1, 0] },
    ], t);
    expect(m.speakerId).toBe('B');
    expect(m.similarity).toBeGreaterThan(0.9);
  });

  test('ECAPA defaults are the measured operating point, not the blueprint 0.75', () => {
    expect(ts.ECAPA_SIMILARITY).toEqual({ threshold: 0.35, softWidth: 0.08, windowSec: 1.5, hopSec: 0.5 });
  });
});
