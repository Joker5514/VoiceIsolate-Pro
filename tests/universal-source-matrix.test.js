/**
 * Universal Source Matrix — unit tests (classical core + mix).
 */
'use strict';

let separateUniversal;
let mixSources;
let dbToGain;
let maskPartitionError;
let computeStft;
let maskToPcm;
let querySpectralPrior;
let USMNode;
let SAMPLE_RATE;

beforeAll(async () => {
  const core = await import('../src/core/UniversalSourceMatrix.js');
  separateUniversal = core.separateUniversal;
  mixSources = core.mixSources;
  dbToGain = core.dbToGain;
  maskPartitionError = core.maskPartitionError;
  computeStft = core.computeStft;
  maskToPcm = core.maskToPcm;
  querySpectralPrior = core.querySpectralPrior;

  const nodeMod = await import('../src/pipeline/USMNode.js');
  USMNode = nodeMod.USMNode;

  const ac = await import('../src/core/audio-config.js');
  SAMPLE_RATE = ac.SAMPLE_RATE;
});

/** 440 Hz sine + soft noise + 60 Hz hum. */
function syntheticMix(seconds = 0.5, sr = 48000) {
  const n = Math.floor(sr * seconds);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const speech = 0.35 * Math.sin(2 * Math.PI * 440 * t)
      + 0.15 * Math.sin(2 * Math.PI * 880 * t);
    const hum = 0.2 * Math.sin(2 * Math.PI * 60 * t);
    // Deterministic pseudo-noise (tests must be stable)
    const noise = 0.05 * Math.sin(2 * Math.PI * 3333 * t + i * 0.17);
    x[i] = speech + hum + noise;
  }
  return x;
}

describe('UniversalSourceMatrix core', () => {
  test('auto mode yields K sources with partitionable masks', () => {
    const mix = syntheticMix(0.4, SAMPLE_RATE);
    const K = 4;
    const result = separateUniversal(mix, SAMPLE_RATE, {
      mode: 'auto',
      numSources: K,
      nmfIterations: 16,
      seed: 7,
    });
    expect(result.sources).toHaveLength(K);
    expect(result.method).toBe('classical-nmf');
    expect(result.shape.frames).toBeGreaterThan(0);
    expect(result.shape.bins).toBe(2049);

    const masks = result.sources.map((s) => s.mask);
    const { maxErr, meanErr } = maskPartitionError(
      masks,
      result.shape.frames,
      result.shape.bins,
    );
    expect(maxErr).toBeLessThan(1e-3);
    expect(meanErr).toBeLessThan(1e-4);

    for (const s of result.sources) {
      expect(s.pcm).toBeInstanceOf(Float32Array);
      expect(s.pcm.length).toBe(mix.length);
      expect(s.label).toBeTruthy();
      expect(s.id).toMatch(/^usm_/);
    }
  });

  test('identity: sum of auto stems ≈ mixture (energy)', () => {
    const mix = syntheticMix(0.35, SAMPLE_RATE);
    const result = separateUniversal(mix, SAMPLE_RATE, {
      mode: 'auto',
      numSources: 3,
      nmfIterations: 20,
      seed: 1,
    });
    const sum = new Float32Array(mix.length);
    for (const s of result.sources) {
      for (let i = 0; i < mix.length; i++) sum[i] += s.pcm[i];
    }
    let err = 0;
    let eMix = 0;
    for (let i = 0; i < mix.length; i++) {
      const d = sum[i] - mix[i];
      err += d * d;
      eMix += mix[i] * mix[i];
    }
    const rel = Math.sqrt(err / (eMix + 1e-12));
    expect(rel).toBeLessThan(0.35);
  });

  test('mute all sources → silent mix', () => {
    const mix = syntheticMix(0.25, SAMPLE_RATE);
    const result = separateUniversal(mix, SAMPLE_RATE, {
      mode: 'auto',
      numSources: 3,
      nmfIterations: 12,
    });
    const muted = result.sources.map((s) => ({ pcm: s.pcm, mute: true, gain: 1 }));
    const out = mixSources(muted, mix.length);
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    expect(peak).toBe(0);
  });

  test('solo one source isolates that stem', () => {
    const mix = syntheticMix(0.25, SAMPLE_RATE);
    const result = separateUniversal(mix, SAMPLE_RATE, {
      mode: 'auto',
      numSources: 3,
      nmfIterations: 12,
    });
    const states = result.sources.map((s, i) => ({
      pcm: s.pcm,
      solo: i === 1,
      mute: false,
      gain: 1,
    }));
    const out = mixSources(states, mix.length);
    const target = result.sources[1].pcm;
    let maxDiff = 0;
    for (let i = 0; i < out.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(out[i] - target[i]));
    }
    expect(maxDiff).toBeLessThan(1e-6);
  });

  test('query mode produces speech-like + residual labels', () => {
    const mix = syntheticMix(0.3, SAMPLE_RATE);
    const result = separateUniversal(mix, SAMPLE_RATE, {
      mode: 'query',
      queries: ['speech', 'AC hum'],
    });
    expect(result.method).toBe('query-prior');
    expect(result.sources.length).toBeGreaterThanOrEqual(2);
    const labels = result.sources.map((s) => s.label.toLowerCase());
    expect(labels.some((l) => l.includes('speech') || l.includes('hum') || l.includes('ac'))).toBe(true);
    expect(labels.some((l) => l.includes('residual'))).toBe(true);
  });

  test('dbToGain maps known values', () => {
    expect(dbToGain(0)).toBeCloseTo(1, 5);
    expect(dbToGain(-6)).toBeCloseTo(0.501, 2);
    expect(dbToGain(-Infinity)).toBe(0);
    expect(dbToGain(-120)).toBe(0);
  });

  test('querySpectralPrior hum emphasizes low bins', () => {
    const { weights, prior } = querySpectralPrior('the AC hum', 2049, 48000, 4096);
    expect(prior.id).toBe('hum');
    const low = weights[10];
    const high = weights[1800];
    expect(low).toBeGreaterThan(high);
  });

  test('STFT + full mask round-trips energy', () => {
    const mix = syntheticMix(0.2, SAMPLE_RATE);
    const stft = computeStft(mix, 4096, 1024);
    const mask = new Float32Array(stft.frames * stft.bins);
    mask.fill(1);
    const pcm = maskToPcm(stft, mask, mix.length);
    let eIn = 0;
    let eOut = 0;
    for (let i = 0; i < mix.length; i++) {
      eIn += mix[i] * mix[i];
      eOut += pcm[i] * pcm[i];
    }
    const ratio = Math.sqrt(eOut / (eIn + 1e-12));
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(1.3);
  });
});

describe('USMNode pipeline', () => {
  test('process auto populates source state for Live-Mix', async () => {
    const mix = syntheticMix(0.3, SAMPLE_RATE);
    const node = new USMNode({ preferOnnx: false });
    const result = await node.process(mix, SAMPLE_RATE, {
      mode: 'auto',
      numSources: 3,
      nmfIterations: 12,
    });
    expect(result.sources).toHaveLength(3);
    expect(node.sources.every((s) => s.gainDb === 0 && !s.mute && !s.solo)).toBe(true);

    node.setMute(result.sources[0].id, true);
    node.setGainDb(result.sources[1].id, -6);
    const mixPcm = node.renderMix();
    expect(mixPcm.length).toBe(mix.length);
    let peak = 0;
    for (let i = 0; i < mixPcm.length; i++) peak = Math.max(peak, Math.abs(mixPcm[i]));
    expect(peak).toBeGreaterThan(0);

    await node.refine('dog barking');
    expect(node.sources.length).toBeGreaterThanOrEqual(4);
    const refined = node.sources.find((s) => s.method === 'query-refine');
    expect(refined).toBeTruthy();
    expect(String(refined.label).toLowerCase()).toMatch(/dog|bark/);

    node.dispose();
  });

  test('internal API: getSourceStems / getSourceLabels / isReady / ensureComputed cache', async () => {
    const mix = syntheticMix(0.25, SAMPLE_RATE);
    const node = new USMNode({ preferOnnx: false });
    expect(node.isReady()).toBe(false);
    expect(node.getSourceStems()).toEqual([]);
    expect(node.getSourceLabels()).toEqual([]);

    const first = await node.ensureComputed(mix, SAMPLE_RATE, {
      mode: 'auto',
      numSources: 3,
      nmfIterations: 10,
    });
    expect(first.sources).toHaveLength(3);
    expect(first.cached).toBeFalsy();
    expect(node.isReady()).toBe(true);

    const stems = node.getSourceStems();
    expect(stems).toHaveLength(3);
    expect(stems[0].pcm).toBeInstanceOf(Float32Array);
    expect(stems[0].label).toBeTruthy();
    expect(stems[0].id).toMatch(/^usm_/);

    const labels = node.getSourceLabels();
    expect(labels).toHaveLength(3);
    expect(labels[0]).toEqual(expect.objectContaining({
      id: expect.any(String),
      label: expect.any(String),
      confidence: expect.any(Number),
    }));
    // Labels must not expose PCM (UI summary only)
    expect(labels[0].pcm).toBeUndefined();

    const second = await node.ensureComputed(mix, SAMPLE_RATE, {
      mode: 'auto',
      numSources: 3,
      nmfIterations: 10,
    });
    expect(second.cached).toBe(true);
    expect(second.sources).toHaveLength(3);

    node.dispose();
  });

  test('Live-Mix contract: mute/solo/gain do not re-invoke process', async () => {
    const mix = syntheticMix(0.2, SAMPLE_RATE);
    const node = new USMNode({ preferOnnx: false });
    await node.ensureComputed(mix, SAMPLE_RATE, { mode: 'auto', numSources: 3, nmfIterations: 8 });
    const processSpy = jest.spyOn(node, 'process');
    const ensureSpy = jest.spyOn(node, 'ensureComputed');

    const id = node.sources[0].id;
    node.setMute(id, true);
    node.setSolo(id, true);
    node.setGainDb(id, -3);
    node.setLabel(id, 'renamed');
    node.renderMix();

    expect(processSpy).not.toHaveBeenCalled();
    expect(ensureSpy).not.toHaveBeenCalled();
    processSpy.mockRestore();
    ensureSpy.mockRestore();
    node.dispose();
  });
});

describe('USM engineer UI contract (source)', () => {
  const fs = require('fs');
  const path = require('path');
  const workspace = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app', 'lib', 'analysis-workspace.js'),
    'utf8',
  );
  const usmNodeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'pipeline', 'USMNode.js'),
    'utf8',
  );
  const indexHtml = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app', 'index.html'),
    'utf8',
  );

  test('analysis-workspace auto-runs USM backend after analysis', () => {
    expect(workspace).toMatch(/runUsmBackend/);
    expect(workspace).toMatch(/ensureComputed/);
    expect(workspace).toMatch(/getSourceStems/);
    expect(workspace).toMatch(/getSourceLabels/);
  });

  test('USMNode documents backend role and Live-Mix contract', () => {
    expect(usmNodeSrc).toMatch(/Internal backend service/);
    expect(usmNodeSrc).toMatch(/getSourceStems/);
    expect(usmNodeSrc).toMatch(/getSourceLabels/);
    expect(usmNodeSrc).toMatch(/USMWorker/);
  });

  test('Engineer HTML shows Detected Sources summary, not Separate controls as primary', () => {
    expect(indexHtml).toMatch(/Detected Sources/);
    expect(indexHtml).toMatch(/computed automatically/i);
    // Separate buttons exist only as hidden legacy ids
    expect(indexHtml).toMatch(/btnUsmSeparate[\s\S]*hidden/);
  });
});
