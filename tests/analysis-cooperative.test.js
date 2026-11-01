/**
 * Cooperative full analysis: one feature pass, real progress, and cancel.
 * Synthetic tones only. No audio fixtures and no microphone.
 */
'use strict';

let analyzeAudio;
let analyzeAudioCooperative;
let advanceFeaturePass;
let createFeaturePass;
let extractFrameFeatures;
let magnitudeSpectrum;

beforeAll(async () => {
  ({ analyzeAudio, analyzeAudioCooperative } = await import('../src/core/FullAnalysis.js'));
  ({
    advanceFeaturePass,
    createFeaturePass,
    extractFrameFeatures,
    magnitudeSpectrum,
  } = await import('../src/core/FeatureExtractor.js'));
});

function tone(seconds, sampleRate, freq = 440) {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.2 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

describe('cooperative feature extraction', () => {
  test('sliced feature passes match a single extractFrameFeatures call', () => {
    const sr = 16000;
    const mono = tone(1.5, sr, 220);
    const once = extractFrameFeatures(mono, sr);
    const pass = createFeaturePass(mono, sr);
    while (!pass.done) advanceFeaturePass(pass, 7);
    expect(pass.result.frames).toEqual(once.frames);
    expect(pass.result.snrDb).toBe(once.snrDb);
    expect(pass.result.reverbEstimate).toBe(once.reverbEstimate);
    expect(pass.result.humProfile).toEqual(once.humProfile);
    expect(mono[10]).toBeCloseTo(0.2 * Math.sin((2 * Math.PI * 220 * 10) / sr));
  });

  test('magnitudeSpectrum of a constant frame is the unnormalized DC bin', () => {
    const frame = new Float32Array(32).fill(1);
    const mag = magnitudeSpectrum(frame);
    expect(mag[0]).toBeCloseTo(32, 6);
    for (let k = 1; k < mag.length; k++) expect(mag[k]).toBeCloseTo(0, 6);
  });

  test('a supplied extraction is not computed again and matches analyzeAudio', async () => {
    const sr = 16000;
    const mono = tone(0.8, sr);
    const fresh = analyzeAudio([mono], sr);
    const extraction = extractFrameFeatures(mono, sr);
    let yields = 0;
    const reused = await analyzeAudioCooperative([mono], sr, { extraction }, {
      yield: async () => { yields += 1; },
    });
    expect(reused.diagnostics.extraction).toBe('reused');
    expect(yields).toBe(1);
    expect(reused.frameCount).toBe(fresh.frameCount);
    expect(reused.snrDb).toBe(fresh.snrDb);
    expect(reused.speechSegments).toEqual(fresh.speechSegments);
    expect(reused.recommendedPreset).toBe(fresh.recommendedPreset);
    expect(reused.diagnostics.frames).toBe(fresh.frameCount);
    expect(JSON.stringify(reused.diagnostics)).not.toMatch(/0\.2|Float32/);
  });

  test('progress advances by completed frames and a timer can run between slices', async () => {
    const sr = 16000;
    const mono = tone(2, sr);
    const seen = [];
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    try {
      const analysis = await analyzeAudioCooperative([mono], sr, {}, {
        framesPerSlice: 40,
        onProgress: (done, total) => { seen.push([done, total]); },
        yield: () => new Promise((resolve) => { setTimeout(resolve, 0); }),
      });
      expect(analysis.diagnostics.extraction).toBe('computed');
    } finally {
      clearInterval(timer);
    }
    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBeGreaterThan(seen[i - 1][0]);
    expect(seen.at(-1)[0]).toBe(seen[0][1]);
    expect(ticks).toBeGreaterThan(0);
  });

  test('cancellation stops before the remaining slices run', async () => {
    const sr = 16000;
    const mono = tone(4, sr);
    let slices = 0;
    await expect(analyzeAudioCooperative([mono], sr, {}, {
      framesPerSlice: 25,
      shouldStop: () => slices >= 1,
      onProgress: () => { slices += 1; },
      yield: async () => {},
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(slices).toBe(1);
  });
});

describe('FullAnalysisWorker slices', () => {
  let messages;

  beforeAll(async () => {
    messages = [];
    globalThis.postMessage = (msg) => { messages.push(msg); };
    await import('../src/workers/FullAnalysisWorker.js');
  });

  beforeEach(() => {
    messages = [];
    globalThis.postMessage = (msg) => { messages.push(msg); };
  });

  function waitFor(type, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type} message`)), timeoutMs);
      globalThis.postMessage = (msg) => {
        messages.push(msg);
        if (msg.type === type || msg.type === 'error') {
          clearTimeout(timer);
          resolve(msg);
        }
      };
    });
  }

  test('reused extraction reports classify above the host dispatch percent', async () => {
    const sr = 16000;
    const mono = tone(0.6, sr);
    const extraction = extractFrameFeatures(mono, sr);
    const done = waitFor('result');
    globalThis.onmessage({
      data: {
        type: 'analyze',
        requestId: 3,
        channels: [mono],
        sampleRate: sr,
        opts: { extraction },
      },
    });
    const result = await done;
    expect(result.analysis.diagnostics.extraction).toBe('reused');
    const progress = messages.filter((m) => m.type === 'progress');
    expect(progress[0]).toMatchObject({ percent: 16, stage: 'classify' });
    expect(progress.some((m) => m.percent === 5)).toBe(false);
    expect(mono[0]).toBeCloseTo(0);
  });

  test('cancel during the first feature slice does not post a result', async () => {
    const sr = 16000;
    const mono = tone(8, sr);
    let progressCount = 0;
    const finished = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cancel was not observed')), 8000);
      globalThis.postMessage = (msg) => {
        messages.push(msg);
        if (msg.type === 'progress') {
          progressCount += 1;
          if (progressCount === 2) {
            globalThis.onmessage({ data: { type: 'cancel', requestId: 9 } });
          }
        }
        if (msg.type === 'cancelled' || msg.type === 'result' || msg.type === 'error') {
          clearTimeout(timer);
          resolve(msg);
        }
      };
    });
    globalThis.onmessage({
      data: { type: 'analyze', requestId: 9, channels: [mono], sampleRate: sr, opts: {} },
    });
    const msg = await finished;
    expect(msg.type).toBe('cancelled');
    expect(messages.some((m) => m.type === 'result')).toBe(false);
    expect(progressCount).toBeGreaterThan(1);
  });
});
