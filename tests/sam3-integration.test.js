/**
 * SAM 3 vision sidecar — unit tests (local-only, no network).
 */
'use strict';

let sam3;

beforeAll(async () => {
  sam3 = await import('../src/sam3_integration/index.js');
});

describe('SAM3 feature flags', () => {
  test('disabled by default', () => {
    expect(sam3.isSam3Enabled({})).toBe(false);
    expect(sam3.isSam31MultiplexEnabled({})).toBe(false);
  });

  test('enabled via VIP_SAM3_ENABLED', () => {
    expect(sam3.isSam3Enabled({ VIP_SAM3_ENABLED: '1' })).toBe(true);
    expect(sam3.isSam3Enabled({ SAM3_ENABLED: 'true' })).toBe(true);
  });
});

describe('SAM3 local-only policy', () => {
  test('allows packaged sam3 paths', () => {
    expect(sam3.assertLocalModelAsset('/app/models/sam3/model.onnx').ok).toBe(true);
    expect(sam3.assertLocalModelAsset('app/models/sam3/weights.bin').ok).toBe(true);
  });

  test('rejects cloud / HF / CDN hosts', () => {
    expect(sam3.assertLocalModelAsset('https://huggingface.co/facebook/sam3').ok).toBe(false);
    expect(sam3.assertLocalModelAsset('https://fal.ai/model').ok).toBe(false);
    expect(sam3.assertLocalModelAsset('https://cdn.jsdelivr.net/x').ok).toBe(false);
    expect(sam3.assertLocalModelAsset('https://example.com/app/models/sam3/x.onnx').ok).toBe(false);
  });

  test('allows localhost for desktop tooling', () => {
    expect(sam3.assertLocalModelAsset('http://127.0.0.1:8765/model').ok).toBe(true);
  });

  test('rejects path traversal and non-allowlisted paths', () => {
    expect(sam3.assertLocalModelAsset('/app/models/sam3/../secret').ok).toBe(false);
    expect(sam3.assertLocalModelAsset('/app/models/bsrnn_vocals.onnx').ok).toBe(false);
  });

  test('findForbiddenRemoteHosts detects policy violations', () => {
    const hits = sam3.findForbiddenRemoteHosts('fetch("https://replicate.com/x")');
    expect(hits.some((h) => h.includes('replicate'))).toBe(true);
  });
});

describe('SAM3 prompt validation', () => {
  test('accepts text prompts', () => {
    const v = sam3.validatePromptCommand({ kind: 'text', text: 'the speaker in white' });
    expect(v.ok).toBe(true);
    expect(v.command.text).toMatch(/speaker/);
  });

  test('rejects remote URLs inside text', () => {
    const v = sam3.validatePromptCommand({ kind: 'text', text: 'see https://fal.ai/x' });
    expect(v.ok).toBe(false);
  });

  test('accepts box and click', () => {
    expect(sam3.validatePromptCommand({ kind: 'box', box: [10, 20, 30, 40] }).ok).toBe(true);
    expect(sam3.validatePromptCommand({ kind: 'click', point: [5, 6], label: 1 }).ok).toBe(true);
  });

  test('rejects oversized text', () => {
    const v = sam3.validatePromptCommand({
      kind: 'text',
      text: 'x'.repeat(sam3.SAM3_LIMITS.MAX_PROMPT_CHARS + 1),
    });
    expect(v.ok).toBe(false);
  });
});

describe('SAM3 frame result validation', () => {
  test('validates tracks and worklet meta', () => {
    const raw = {
      frameIndex: 0,
      timestampMs: 0,
      tracks: [
        { trackId: 1, label: 'person', score: 0.9, box: [0, 0, 10, 10] },
      ],
    };
    const v = sam3.validateFrameResult(raw);
    expect(v.ok).toBe(true);
    const m = sam3.toWorkletMetadata(v.result);
    expect(m.ok).toBe(true);
    expect(m.meta.type).toBe('sam3-tracks');
    expect(m.meta.tracks[0].mask).toBeUndefined();
  });

  test('rejects too many tracks', () => {
    const tracks = Array.from({ length: sam3.SAM3_LIMITS.MAX_TRACKS + 1 }, (_, i) => ({
      trackId: i,
      label: 't',
      score: 0.5,
      box: [0, 0, 1, 1],
    }));
    expect(sam3.validateFrameResult({ frameIndex: 0, timestampMs: 0, tracks }).ok).toBe(false);
  });
});

describe('SAM3 ImageSegmenter heuristic', () => {
  test('segments from text prompt deterministically', async () => {
    const seg = new sam3.ImageSegmenter({ confidenceThreshold: 0.3, maxTracks: 10 });
    seg.setPrompt({ kind: 'text', text: 'the person at the podium' });
    const r1 = await seg.segment({ frameIndex: 0, timestampMs: 0, width: 640, height: 360 });
    const r2 = await seg.segment({ frameIndex: 1, timestampMs: 33, width: 640, height: 360 });
    expect(r1.tracks.length).toBeGreaterThan(0);
    expect(r1.tracks[0].label).toMatch(/podium|person/i);
    expect(r1.tracks[0].box[2]).toBeCloseTo(r2.tracks[0].box[2], 5);
  });

  test('box prompt yields one track', async () => {
    const seg = new sam3.ImageSegmenter();
    seg.setPrompt({ kind: 'box', box: [100, 50, 80, 120], text: 'subject' });
    const r = await seg.segment({ frameIndex: 0, timestampMs: 0, width: 320, height: 240 });
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0].box[0]).toBe(100);
  });

  test('rejects remote model path in constructor', () => {
    expect(() => new sam3.ImageSegmenter({
      modelPath: 'https://huggingface.co/facebook/sam3',
    })).toThrow(/rejected/);
  });
});

describe('SAM3 VideoTracker', () => {
  test('associates tracks across frames (IoU)', () => {
    const tr = new sam3.VideoTracker({ maxTracks: 12, iouThreshold: 0.2 });
    const a = tr.ingest({
      frameIndex: 0,
      timestampMs: 0,
      tracks: [{ trackId: 99, label: 'speaker', score: 0.9, box: [10, 10, 50, 80] }],
    });
    expect(a.results).toHaveLength(1);
    const id = a.results[0].tracks[0].trackId;

    const b = tr.ingest({
      frameIndex: 1,
      timestampMs: 33,
      tracks: [{ trackId: 0, label: 'speaker', score: 0.88, box: [12, 11, 50, 80] }],
    });
    expect(b.results[0].tracks[0].trackId).toBe(id);
  });

  test('rejects or buffers out-of-order frames safely', () => {
    const gate = new sam3.FrameOrderGate({ maxPending: 4 });
    const e0 = gate.push({
      frameIndex: 0,
      timestampMs: 0,
      tracks: [{ trackId: 1, label: 'a', score: 0.9, box: [0, 0, 1, 1] }],
    });
    expect(e0.emit).toHaveLength(1);

    const late = gate.push({
      frameIndex: 0,
      timestampMs: 0,
      tracks: [{ trackId: 1, label: 'a', score: 0.9, box: [0, 0, 1, 1] }],
    });
    expect(late.rejected).toBe('stale-or-duplicate-frame');

    const future = gate.push({
      frameIndex: 3,
      timestampMs: 100,
      tracks: [{ trackId: 1, label: 'a', score: 0.9, box: [0, 0, 1, 1] }],
    });
    expect(future.emit).toHaveLength(0);

    const mid = gate.push({
      frameIndex: 1,
      timestampMs: 33,
      tracks: [{ trackId: 1, label: 'a', score: 0.9, box: [0, 0, 1, 1] }],
    });
    expect(mid.emit.some((f) => f.frameIndex === 1)).toBe(true);
  });

  test('supports at least 10 simultaneous tracks', async () => {
    const seg = new sam3.ImageSegmenter({ maxTracks: 16, confidenceThreshold: 0.2 });
    for (let i = 0; i < 12; i++) {
      seg.setPrompt({ kind: 'box', box: [i * 20, 10, 15, 40], text: `obj-${i}` });
    }
    const tr = new sam3.VideoTracker({ maxTracks: 12 });
    const raw = await seg.segment({ frameIndex: 0, timestampMs: 0, width: 800, height: 400 });
    expect(raw.tracks.length).toBeGreaterThanOrEqual(10);
    const out = tr.ingest(raw);
    expect(out.results[0].tracks.length).toBeGreaterThanOrEqual(10);
  });

  test('dropped-frame recovery continues sequence', () => {
    const tr = new sam3.VideoTracker();
    tr.ingest({
      frameIndex: 0,
      timestampMs: 0,
      tracks: [{ trackId: 1, label: 'a', score: 0.9, box: [0, 0, 10, 10] }],
    });
    const r = tr.ingest({
      frameIndex: 2,
      timestampMs: 66,
      tracks: [{ trackId: 1, label: 'a', score: 0.9, box: [1, 1, 10, 10] }],
    });
    const fill = tr.ingest({
      frameIndex: 1,
      timestampMs: 33,
      tracks: [{ trackId: 1, label: 'a', score: 0.9, box: [0.5, 0.5, 10, 10] }],
    });
    const emitted = [...(r.results || []), ...(fill.results || [])];
    expect(emitted.length).toBeGreaterThanOrEqual(1);
  });

  test('manual correctTrack updates box', () => {
    const tr = new sam3.VideoTracker();
    const a = tr.ingest({
      frameIndex: 0,
      timestampMs: 0,
      tracks: [{ trackId: 1, label: 'a', score: 0.9, box: [0, 0, 10, 10] }],
    });
    const id = a.results[0].tracks[0].trackId;
    const c = tr.correctTrack(id, { box: [5, 5, 20, 20], score: 1 });
    expect(c.ok).toBe(true);
    expect(c.track.box[0]).toBe(5);
  });
});

describe('SAM3 boxIoU', () => {
  test('identical boxes IoU=1', () => {
    expect(sam3.boxIoU([0, 0, 10, 10], [0, 0, 10, 10])).toBeCloseTo(1, 5);
  });
  test('disjoint boxes IoU=0', () => {
    expect(sam3.boxIoU([0, 0, 10, 10], [50, 50, 10, 10])).toBe(0);
  });
});

describe('SAM3 runtime probe', () => {
  test('returns structured status without throwing', () => {
    const r = sam3.probeSam3Runtime(globalThis);
    expect(r).toHaveProperty('enabled');
    expect(r).toHaveProperty('status');
    expect(r).toHaveProperty('webgpu');
    expect(Array.isArray(r.reasons)).toBe(true);
  });
});
