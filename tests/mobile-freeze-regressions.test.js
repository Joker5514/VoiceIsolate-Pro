/**
 * VoiceIsolate Pro — mobile main-thread freeze regressions
 *
 * Pins the fixes for the import/Process freezes measured on a 4x
 * CPU-throttled Pixel 7 profile (scripts/perf/perf-harness.cjs --mobile):
 *  - AutoAnalysis yields between slices and gives identical results.
 *  - The stem-cache key hash has a yielding twin with an identical key, and
 *    the cache is bounded by a byte budget, not only an entry count.
 *  - The session store's history no longer pins past sessions' PCM.
 *  - ProcessingController can adopt immutable ingest buffers without a copy.
 *  - Waveform/spectrogram layers decimate without full-file render passes.
 *  - Landing wires transport crop/loop listeners once per page.
 *  - Device tiering is feature-detected and never changes audio output.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Speech-like bursts, pauses with quiet whisper-band noise, and a floor. */
function speechLike(seconds, sr = 16000, seed = 3) {
  const n = Math.floor(seconds * sr);
  const out = new Float32Array(n);
  const rand = mulberry32(seed);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.max(0, Math.sin(2 * Math.PI * 0.45 * t));
    const whisper = Math.floor(t) % 5 === 2 ? 0.02 : 0;
    out[i] = 0.3 * env * Math.sin(2 * Math.PI * 180 * t)
      + whisper * (rand() * 2 - 1) + 0.002 * (rand() * 2 - 1);
  }
  return out;
}

const stripVolatile = (r) => JSON.stringify({
  ...r,
  timestamp: 0,
  regions: r.regions.map((x) => ({ ...x, id: 0 })),
});

describe('AutoAnalysis cooperative scheduling', () => {
  let runAutoAnalysis;
  beforeAll(async () => {
    ({ runAutoAnalysis } = await import('../src/core/audio/analysis/AutoAnalysis.js'));
  });

  test('yields between slices and returns exactly the unyielded result', async () => {
    const ch = speechLike(40);
    const plain = await runAutoAnalysis([ch], 16000);
    let yields = 0;
    const cooperative = await runAutoAnalysis([ch], 16000, { maybeYield: async () => { yields += 1; } });
    expect(yields).toBeGreaterThan(5);
    expect(stripVolatile(cooperative)).toBe(stripVolatile(plain));
    expect(plain.speechSegments.length).toBeGreaterThan(5);
    expect(plain.whisperCandidates.length).toBeGreaterThan(0);
  });

  test('an abort between slices stops the run', async () => {
    const ch = speechLike(40);
    const abort = new AbortController();
    let yields = 0;
    const run = runAutoAnalysis([ch], 16000, {
      signal: abort.signal,
      maybeYield: async () => { if (++yields === 3) abort.abort(); },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('whisper candidates never fall inside a speech segment', async () => {
    const r = await runAutoAnalysis([speechLike(30, 16000, 9)], 16000);
    for (const w of r.whisperCandidates) {
      for (const s of r.speechSegments) {
        expect(w.start >= s.start && w.start <= s.end).toBe(false);
      }
    }
  });
});

describe('MLStemCache: yielding key + byte budget', () => {
  let mod;
  beforeAll(async () => {
    mod = await import('../src/pipeline/MLStemCache.js');
  });
  beforeEach(() => {
    mod.clearStemCache();
    mod.setStemCacheByteBudget(Infinity);
  });
  afterAll(() => mod.setStemCacheByteBudget(null));

  test('stemCacheKeyAsync equals stemCacheKey and yields on long inputs', async () => {
    const rand = mulberry32(5);
    const make = () => Float32Array.from({ length: 700_001 }, () => rand() * 2 - 1);
    const a = [make(), make()];
    const b = [new Float32Array(a[0]), new Float32Array(a[1])];
    let yields = 0;
    const asyncKey = await mod.stemCacheKeyAsync(a, 48000, ['bsrnn_vocals'], 'x.wav', 'rev1', {
      maybeYield: async () => { yields += 1; },
    });
    expect(yields).toBeGreaterThan(4);
    expect(asyncKey).toBe(mod.stemCacheKey(b, 48000, ['bsrnn_vocals'], 'x.wav', 'rev1'));
  });

  test('async and sync keys share the per-buffer memo', async () => {
    const ch = [Float32Array.from({ length: 4096 }, (_, i) => Math.sin(i))];
    const before = mod.getDigestComputationCount();
    await mod.stemCacheKeyAsync(ch, 48000, ['m'], '', '', { maybeYield: async () => {} });
    mod.stemCacheKey(ch, 48000, ['m']);
    await mod.stemCacheKeyAsync(ch, 48000, ['m']);
    expect(mod.getDigestComputationCount() - before).toBe(1);
  });

  test('a result larger than the budget is not copied into the cache', async () => {
    mod.setStemCacheByteBudget(1000);
    const big = { clean: [new Float32Array(200)], noise: [new Float32Array(200)], sampleRate: 48000 };
    let copies = 0;
    await mod.setCachedStemsAsync('k', big, async (c) => { copies += 1; return new Float32Array(c); });
    expect(copies).toBe(0);
    expect(mod.getStemCacheSize()).toBe(0);
  });

  test('LRU entries are evicted until the cache fits its byte budget', () => {
    const entry = () => ({ clean: [new Float32Array(100)], noise: [new Float32Array(100)], sampleRate: 48000 });
    mod.setStemCacheByteBudget(1000); // one 800-byte entry fits, two do not
    mod.setCachedStems('a', entry());
    mod.setCachedStems('b', entry());
    expect(mod.getStemCacheSize()).toBe(1);
    expect(mod.getCachedStems('b')).not.toBeNull();
    expect(mod.getStemCacheBytes()).toBe(800);
    mod.setStemCacheByteBudget(0);
    expect(mod.getStemCacheSize()).toBe(0);
  });
});

describe('performance tier', () => {
  let tier;
  beforeAll(async () => {
    tier = await import('../src/core/PerformanceTier.js');
  });

  test.each([
    [{ deviceMemory: 2, hardwareConcurrency: 8 }, 'CONSTRAINED'],
    [{ hardwareConcurrency: 2 }, 'CONSTRAINED'],
    [{ saveData: true, deviceMemory: 8 }, 'CONSTRAINED'],
    [{ deviceMemory: 4, hardwareConcurrency: 8 }, 'BALANCED'],
    [{ coarsePointer: true, viewportWidth: 412, deviceMemory: 8, hardwareConcurrency: 8 }, 'BALANCED'],
    [{ coarsePointer: true, viewportWidth: 1366, deviceMemory: 8, hardwareConcurrency: 8 }, 'HIGH'],
    [{ deviceMemory: 8, hardwareConcurrency: 8 }, 'HIGH'],
    [{}, 'HIGH'],
  ])('%j -> %s', (signals, expected) => {
    expect(tier.selectPerformanceTier(signals)).toBe(expected);
  });

  test('budgets shrink with the tier and desktop stays unbounded', () => {
    expect(tier.tierBudgets('HIGH').stemCacheBytes).toBe(Infinity);
    expect(tier.tierBudgets('BALANCED').stemCacheBytes)
      .toBeGreaterThan(tier.tierBudgets('CONSTRAINED').stemCacheBytes);
  });

  test('readDeviceSignals never sniffs the user agent and tolerates bare globals', () => {
    expect(tier.readDeviceSignals({})).toEqual({
      deviceMemory: undefined,
      hardwareConcurrency: undefined,
      coarsePointer: false,
      viewportWidth: undefined,
      saveData: false,
    });
    const g = {
      navigator: { deviceMemory: 4, hardwareConcurrency: 8, userAgent: 'Android', connection: { saveData: false } },
      matchMedia: () => ({ matches: true }),
      innerWidth: 390,
    };
    expect(tier.detectPerformanceTier(g)).toBe('BALANCED');
    expect(read('src/core/PerformanceTier.js')).not.toMatch(/userAgent/);
  });
});

describe('session store history holds no PCM', () => {
  test('history entries keep only the event name and time', async () => {
    const { AudioSessionStore } = await import('../src/state/audioSessionStore.js');
    const store = new AudioSessionStore();
    const raw = [new Float32Array(1024)];
    store.importSource({ name: 'a', sampleRate: 48000, channels: 1, duration: 1, rawBuffer: raw });
    store.applyProcessing({ processedBuffer: raw, removedBuffer: raw });
    for (const entry of store._history) {
      expect(Object.keys(entry).sort()).toEqual(['event', 'ts']);
    }
  });
});

describe('ProcessingController adopt', () => {
  test('setRaw adopt keeps the caller arrays; default still deep-clones', async () => {
    const { ProcessingController } = await import('../src/core/audio/processing/ProcessingController.js');
    const ch = [Float32Array.from([0.1, 0.2])];
    const adopted = new ProcessingController(null).setRaw(ch, 48000, { adopt: true });
    expect(adopted[0]).toBe(ch[0]);
    const cloned = new ProcessingController(null).setRaw(ch, 48000);
    expect(cloned[0]).not.toBe(ch[0]);
  });

  test('setProcessedAsync publishes raw by reference, other buffers as clones', async () => {
    const { ProcessingController } = await import('../src/core/audio/processing/ProcessingController.js');
    const updates = [];
    const c = new ProcessingController({ applyProcessing: (u) => updates.push(u), setProcessingState() {} });
    const raw = c.setRaw([Float32Array.from([1, 1])], 48000, { adopt: true });
    const processed = [Float32Array.from([0.5, 0.5])];
    await c.setProcessedAsync(processed, 48000);
    expect(updates[0].rawBuffer[0]).toBe(raw[0]);
    expect(updates[0].processedBuffer[0]).not.toBe(processed[0]);
  });
});

/** Minimal 2D canvas stub: enough for the layers' render paths in Node. */
function stubCanvas(width, height) {
  const calls = { fillRect: 0, putImageData: 0, createImageData: 0 };
  const ctx = {
    fillRect() { calls.fillRect += 1; },
    clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {}, closePath() {}, fillText() {},
    createImageData(w, h) { calls.createImageData += 1; return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() { calls.putImageData += 1; },
  };
  return {
    calls,
    canvas: {
      width, height,
      getContext: () => ctx,
      getBoundingClientRect: () => ({ width, height }),
    },
  };
}

describe('render layers', () => {
  let frames;
  beforeAll(() => {
    frames = [];
    global.requestAnimationFrame = (cb) => { frames.push(cb); return frames.length; };
    global.cancelAnimationFrame = () => {};
  });
  afterAll(() => {
    delete global.requestAnimationFrame;
    delete global.cancelAnimationFrame;
  });
  const flushFrames = () => { while (frames.length) frames.shift()(); };

  test('WaveformLayer pyramid peaks match a direct min/max scan', async () => {
    const { WaveformLayer } = await import('../src/ui/components/WaveformLayer/WaveformLayer.js');
    const n = 256 * 8192 + 12345;
    const rand = mulberry32(11);
    const ch = Float32Array.from({ length: n }, (_, i) => (rand() * 2 - 1) * Math.sin(i / 5000));
    const { canvas } = stubCanvas(512, 100);
    const layer = new WaveformLayer(canvas);
    layer.setData([ch], n / 48000);
    expect(layer._computePeaks(512)).toBeNull(); // pyramid still building: no full scan in render
    for (let i = 0; i < 200 && !layer._buckets; i++) await new Promise((r) => setTimeout(r, 5));
    const peaks = layer._computePeaks(512);
    expect(peaks).not.toBeNull();
    const spp = Math.floor(n / 512);
    let maxErr = 0;
    for (let x = 0; x < 512; x++) {
      let min = 0;
      let max = 0;
      for (let i = x * spp; i < (x + 1) * spp; i++) { if (ch[i] < min) min = ch[i]; if (ch[i] > max) max = ch[i]; }
      // Buckets straddling a pixel edge may add <= 255 neighbouring samples.
      maxErr = Math.max(maxErr, min - peaks[2 * x], peaks[2 * x + 1] - max);
      expect(peaks[2 * x]).toBeLessThanOrEqual(min);
      expect(peaks[2 * x + 1]).toBeGreaterThanOrEqual(max);
    }
    expect(maxErr).toBeLessThan(0.2);
    layer.dispose?.();
  });

  test('SpectrogramLayer paints one ImageData and reuses it for identical renders', async () => {
    global.ImageData = class {};
    try {
      const { SpectrogramLayer } = await import('../src/ui/components/SpectrogramLayer/SpectrogramLayer.js');
      const { canvas, calls } = stubCanvas(300, 120);
      const layer = new SpectrogramLayer(canvas);
      layer.setAudioData([speechLike(20, 48000)], 48000);
      flushFrames();
      expect(calls.createImageData).toBe(1);
      expect(calls.putImageData).toBe(1);
      // Background + grid only: no fillRect per pixel.
      expect(calls.fillRect).toBeLessThan(10);
      const spy = jest.spyOn(layer, '_computeSimpleSpectrogram');
      layer._render();
      expect(spy).not.toHaveBeenCalled();
      expect(calls.putImageData).toBe(2);
      layer.setViewRange(0.25, 0.5);
      flushFrames();
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      delete global.ImageData;
    }
  });
});

describe('listener and pipeline duplication guards', () => {
  test('Landing wires transport crop/loop listeners once, outside installStems', () => {
    const src = read('public/landing.js');
    expect(src.match(/wireTransportRegion\(/g)).toHaveLength(1);
    const install = src.slice(src.indexOf('async function installStems('), src.indexOf('function syncTransportRegionUi('));
    expect(install).not.toMatch(/wireTransportRegion\(/);
    expect(install).toMatch(/syncTransportRegionUi\(\)/);
  });

  test('Landing runs one import analysis and shares it with listeners', () => {
    const landing = read('public/landing.js');
    expect(landing.match(/runAutoAnalysis\(/g)).toHaveLength(1);
    expect(landing).toMatch(/analysis,\n\s*\},\n\s*\}\)\);/);
    expect(read('public/landing-premium.js')).toMatch(/if \(analysis\) \{/);
  });

  test('Engineer premium workspace handles one import once and coalesces drag redraws', () => {
    const src = read('public/app/premium-workspace.js');
    expect(src).toMatch(/channelData\[0\] === state\.channelData\?\.\[0\]\) return;/);
    expect(src).toMatch(/maybeYield: createYieldBudget\(\)/);
    const moves = src.split("addEventListener('pointermove'").slice(1).map((s) => s.slice(0, 900));
    expect(moves).toHaveLength(2);
    for (const body of moves) {
      expect(body).toMatch(/scheduleSelectionDraw\(/);
      expect(body).not.toMatch(/drawWaveform\(/);
    }
  });

  test('Engineer handleFile ignores a second delivery of the same pick', () => {
    expect(read('public/app/m4a-decode-fix.js')).toMatch(/if \(this\._vipHandleFileActive === file\) return;/);
  });
});
