/**
 * VoiceIsolate Pro — AutoAnalysis region output contract
 *
 * Runs the deterministic DSP analysis on a synthetic signal (noise floor,
 * a loud "speech" burst, a quiet whisper-band section) and pins the shape
 * of the regions consumed by SignalCanvas / AnalysisOverlay / the overlay
 * list: { id, type, start, end, confidence, label } sorted by start time.
 */
'use strict';

let runAutoAnalysis;
let AnalysisOverlays;

const SAMPLE_RATE = 8000;
const DURATION = 3.0;

/** Deterministic PRNG so the noise floor is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSyntheticSignal() {
  const n = Math.floor(DURATION * SAMPLE_RATE);
  const ch = new Float32Array(n);
  const rand = mulberry32(42);
  const twoPi = Math.PI * 2;

  for (let i = 0; i < n; i++) {
    const t = i / SAMPLE_RATE;
    // Noise floor everywhere (uniform ±0.001).
    let v = (rand() - 0.5) * 0.002;
    if (t >= 0.5 && t < 1.5) {
      // Loud "speech": 300 Hz sine, well above the floor.
      v += 0.3 * Math.sin(twoPi * 300 * t);
    } else if (t >= 2.0 && t < 2.6) {
      // Whisper-band energy: ~4 dB above the floor, below the speech
      // threshold (floor + 6 dB), so VAD classifies it as whisper.
      v += 0.0013 * Math.sin(twoPi * 300 * t);
    }
    ch[i] = v;
  }
  return [ch];
}

beforeAll(async () => {
  const mod = await import('../src/core/audio/analysis/AutoAnalysis.js');
  runAutoAnalysis = mod.runAutoAnalysis;
  AnalysisOverlays = mod.AnalysisOverlays;
});

describe('runAutoAnalysis on a synthetic signal', () => {
  let result;

  beforeAll(async () => {
    result = await runAutoAnalysis(buildSyntheticSignal(), SAMPLE_RATE, {});
  });

  test('returns analysis scalars alongside the region list', () => {
    expect(result).toBeTruthy();
    expect(result.sampleRate).toBe(SAMPLE_RATE);
    expect(result.channels).toBe(1);
    expect(result.duration).toBeCloseTo(DURATION, 5);
    expect(Number.isFinite(result.snrDb)).toBe(true);
    expect(Number.isFinite(result.rms)).toBe(true);
    expect(Number.isFinite(result.peak)).toBe(true);
    expect(result.speechRatio).toBeGreaterThan(0);
    expect(Array.isArray(result.speechSegments)).toBe(true);
    expect(Array.isArray(result.whisperCandidates)).toBe(true);
    expect(Array.isArray(result.noiseSegments)).toBe(true);
  });

  test('regions carry the exact shape the overlays consume', () => {
    const { regions } = result;
    expect(Array.isArray(regions)).toBe(true);
    expect(regions.length).toBeGreaterThanOrEqual(3);

    const allowedTypes = new Set(Object.values(AnalysisOverlays));
    for (const region of regions) {
      expect(typeof region.id).toBe('string');
      expect(region.id).toMatch(/^r-/);
      expect(allowedTypes.has(region.type)).toBe(true);
      expect(Number.isFinite(region.start)).toBe(true);
      expect(Number.isFinite(region.end)).toBe(true);
      expect(region.start).toBeGreaterThanOrEqual(0);
      expect(region.end).toBeGreaterThan(region.start);
      expect(region.end).toBeLessThanOrEqual(DURATION + 1e-6);
      expect(region.confidence).toBeGreaterThanOrEqual(0);
      expect(region.confidence).toBeLessThanOrEqual(1);
      expect(typeof region.label).toBe('string');
    }
  });

  test('regions are sorted by start time', () => {
    for (let i = 1; i < result.regions.length; i++) {
      expect(result.regions[i].start).toBeGreaterThanOrEqual(result.regions[i - 1].start);
    }
  });

  test('detects the synthetic speech burst, whisper section and noise gaps', () => {
    const types = result.regions.map((r) => r.type);
    expect(types).toContain(AnalysisOverlays.SPEECH);
    expect(types).toContain(AnalysisOverlays.WHISPER);
    expect(types).toContain(AnalysisOverlays.NOISE);

    const speech = result.regions.find((r) => r.type === AnalysisOverlays.SPEECH);
    // Speech burst spans 0.5–1.5 s; allow detector slack at the edges.
    expect(speech.start).toBeLessThan(0.7);
    expect(speech.end).toBeGreaterThan(1.3);

    const whisper = result.regions.find((r) => r.type === AnalysisOverlays.WHISPER);
    expect(whisper.start).toBeGreaterThanOrEqual(1.9);
    expect(whisper.end).toBeLessThanOrEqual(2.7);

    const noise = result.regions.find((r) => r.type === AnalysisOverlays.NOISE);
    // A leading noise gap exists before the speech burst.
    expect(noise.start).toBeLessThan(0.3);
  });

  test('progress callback reports stage completion up to 100', async () => {
    const progress = [];
    await runAutoAnalysis(buildSyntheticSignal(), SAMPLE_RATE, {
      onProgress: (pct, extra) => progress.push({ pct, extra }),
    });
    expect(progress.length).toBeGreaterThan(3);
    expect(progress[progress.length - 1].pct).toBe(100);
    expect(progress.every((p) => p.pct >= 0 && p.pct <= 100)).toBe(true);
  });

  test('aborted signal rejects with AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runAutoAnalysis(buildSyntheticSignal(), SAMPLE_RATE, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
