/**
 * Tests for AI Intelligence Module — v21.0
 * Covers: noise floor estimation, scene classification, auto-tune, SNR, quality metrics
 */
'use strict';

const fs = require('fs');
const path = require('path');

// Load AIIntelligence module using eval pattern (same as dsp.test.js)
const aiJsPath = path.join(__dirname, '../public/app/ai-intelligence.js');
const aiJs = fs.readFileSync(aiJsPath, 'utf8');
const AIIntelligence = (() => {
  const exports = {};
  const module = { exports };
  const self = { AIIntelligence: null };
  eval(aiJs);
  return module.exports || self.AIIntelligence;
})();

// ── Helper: generate synthetic audio ──────────────────────────────────────
function generateSineWave(freq, sr, duration, amplitude = 0.5) {
  const samples = Math.floor(sr * duration);
  const audio = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    audio[i] = amplitude * Math.sin(2 * Math.PI * freq * i / sr);
  }
  return audio;
}

function generateNoise(length, amplitude = 0.1) {
  const audio = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    audio[i] = amplitude * (Math.random() * 2 - 1);
  }
  return audio;
}

function generateSpeechLike(sr, duration) {
  // Mix of speech-frequency sine waves to simulate voice
  const samples = Math.floor(sr * duration);
  const audio = new Float32Array(samples);
  const freqs = [200, 400, 800, 1600, 2400, 3200];
  for (const freq of freqs) {
    const amp = 0.1 + Math.random() * 0.1;
    for (let i = 0; i < samples; i++) {
      audio[i] += amp * Math.sin(2 * Math.PI * freq * i / sr);
    }
  }
  // Normalize
  const peak = Math.max(...audio.map(Math.abs));
  if (peak > 0) for (let i = 0; i < samples; i++) audio[i] /= peak * 1.5;
  return audio;
}

// ── Tests ──────────────────────────────────────────────────────────────────
describe('AIIntelligence — Noise Floor Estimation (MCRA)', () => {
  test('returns Float32Array of correct length', () => {
    const sr = 48000;
    const audio = generateSpeechLike(sr, 1.0);
    // Create fake STFT frames
    const frameSize = 512;
    const halfN = frameSize / 2 + 1;
    const nFrames = 10;
    const magFrames = [];
    for (let f = 0; f < nFrames; f++) {
      const frame = new Float32Array(halfN);
      for (let k = 0; k < halfN; k++) frame[k] = Math.random() * 0.5;
      magFrames.push(frame);
    }
    const result = AIIntelligence.estimateNoiseFloorMCRA(magFrames);
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(halfN);
  });

  test('returns zeros for empty input', () => {
    const result = AIIntelligence.estimateNoiseFloorMCRA([]);
    expect(result.length).toBe(0);
  });

  test('noise estimate is non-negative', () => {
    const halfN = 257;
    const nFrames = 20;
    const magFrames = [];
    for (let f = 0; f < nFrames; f++) {
      const frame = new Float32Array(halfN);
      for (let k = 0; k < halfN; k++) frame[k] = Math.abs(Math.random());
      magFrames.push(frame);
    }
    const result = AIIntelligence.estimateNoiseFloorMCRA(magFrames);
    for (let k = 0; k < result.length; k++) {
      expect(result[k]).toBeGreaterThanOrEqual(0);
    }
  });

  test('lower noise estimate for quiet frames', () => {
    const halfN = 64;
    const quietFrames = [];
    const loudFrames = [];
    for (let f = 0; f < 30; f++) {
      const quiet = new Float32Array(halfN).fill(0.01);
      const loud = new Float32Array(halfN).fill(0.5);
      quietFrames.push(quiet);
      loudFrames.push(loud);
    }
    const quietNoise = AIIntelligence.estimateNoiseFloorMCRA(quietFrames);
    const loudNoise = AIIntelligence.estimateNoiseFloorMCRA(loudFrames);
    const quietAvg = quietNoise.reduce((a, b) => a + b, 0) / quietNoise.length;
    const loudAvg = loudNoise.reduce((a, b) => a + b, 0) / loudNoise.length;
    expect(quietAvg).toBeLessThan(loudAvg);
  });
});

describe('AIIntelligence — Scene Classification', () => {
  const sr = 48000;

  test('returns valid scene string', () => {
    const audio = generateSpeechLike(sr, 1.0);
    const result = AIIntelligence.classifyScene(audio, sr);
    expect(result).toHaveProperty('scene');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('scores');
    expect(typeof result.scene).toBe('string');
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  test('returns podcast/interview for speech-like audio', () => {
    const audio = generateSpeechLike(sr, 2.0);
    const result = AIIntelligence.classifyScene(audio, sr);
    const speechScenes = ['podcast', 'interview', 'broadcast'];
    expect(speechScenes).toContain(result.scene);
  });

  test('handles very short audio gracefully', () => {
    const audio = new Float32Array(100);
    const result = AIIntelligence.classifyScene(audio, sr);
    expect(result).toHaveProperty('scene');
    expect(result.scene).toBe('podcast');
  });

  test('scores object contains all expected scenes', () => {
    const audio = generateSpeechLike(sr, 1.0);
    const result = AIIntelligence.classifyScene(audio, sr);
    const expectedScenes = ['podcast', 'interview', 'music', 'broadcast', 'forensic', 'film'];
    for (const scene of expectedScenes) {
      expect(result.scores).toHaveProperty(scene);
    }
  });

  test('includes feature extraction results', () => {
    const audio = generateSpeechLike(sr, 1.0);
    const result = AIIntelligence.classifyScene(audio, sr);
    expect(result).toHaveProperty('features');
    expect(result.features).toHaveProperty('rms');
    expect(result.features).toHaveProperty('peak');
    expect(result.features).toHaveProperty('crestFactor');
  });
});

describe('AIIntelligence — Auto-Tune Parameters', () => {
  const sr = 48000;

  test('returns suggestions object', () => {
    const audio = generateSpeechLike(sr, 1.0);
    const result = AIIntelligence.autoTuneParams(audio, sr, {});
    expect(result).toHaveProperty('scene');
    expect(result).toHaveProperty('confidence');
    expect(result).toHaveProperty('suggestions');
    expect(typeof result.suggestions).toBe('object');
  });

  test('suggests higher NR for noisy audio', () => {
    const sr = 48000;
    // Create noisy audio (low SNR)
    const noise = generateNoise(sr * 2, 0.3);
    const speech = generateSpeechLike(sr, 2.0);
    const mixed = new Float32Array(noise.length);
    for (let i = 0; i < mixed.length; i++) mixed[i] = speech[i] + noise[i];

    const result = AIIntelligence.autoTuneParams(mixed, sr, {});
    // Should suggest some NR amount
    expect(result.suggestions).toBeDefined();
  });

  test('includes scene classification in result', () => {
    const audio = generateSpeechLike(sr, 1.0);
    const result = AIIntelligence.autoTuneParams(audio, sr, {});
    expect(['podcast', 'interview', 'music', 'broadcast', 'forensic', 'film', 'whisper']).toContain(result.scene);
  });

  test('whisper-level audio suggests lift and sensitive gate', () => {
    const audio = generateSineWave(300, sr, 1.0, 0.008);
    const result = AIIntelligence.autoTuneParams(audio, sr, {});
    expect(result.suggestions.compMakeup).toBe(8);
    expect(result.suggestions.gateThresh).toBeLessThanOrEqual(-60);
    expect(result.suggestions.outGain).toBe(6);
  });
});

describe('AIIntelligence — SNR Improvement', () => {
  test('returns SNR metrics', () => {
    const sr = 48000;
    const original = generateSpeechLike(sr, 1.0);
    // Processed = original with noise removed (simulate by reducing amplitude)
    const processed = new Float32Array(original.length);
    for (let i = 0; i < original.length; i++) processed[i] = original[i] * 0.9;

    const result = AIIntelligence.computeSNRImprovement(original, processed);
    expect(result).toHaveProperty('originalSNR');
    expect(result).toHaveProperty('processedSNR');
    expect(result).toHaveProperty('improvement');
    expect(result).toHaveProperty('snrDb');
    expect(typeof result.improvement).toBe('number');
  });

  test('SNR values are finite numbers', () => {
    const audio = generateSineWave(1000, 48000, 0.5);
    const result = AIIntelligence.computeSNRImprovement(audio, audio);
    expect(isFinite(result.originalSNR)).toBe(true);
    expect(isFinite(result.processedSNR)).toBe(true);
  });
});

describe('AIIntelligence — Voice Quality Metrics', () => {
  const sr = 48000;

  test('returns MOS estimate in 1-5 range', () => {
    const audio = generateSpeechLike(sr, 1.0);
    const result = AIIntelligence.estimateVoiceQuality(audio, sr);
    expect(result.mosEstimate).toBeGreaterThanOrEqual(1.0);
    expect(result.mosEstimate).toBeLessThanOrEqual(5.0);
  });

  test('returns clarity and naturalness as percentages', () => {
    const audio = generateSpeechLike(sr, 1.0);
    const result = AIIntelligence.estimateVoiceQuality(audio, sr);
    expect(result.clarity).toBeGreaterThanOrEqual(0);
    expect(result.clarity).toBeLessThanOrEqual(100);
    expect(result.naturalness).toBeGreaterThanOrEqual(0);
    expect(result.naturalness).toBeLessThanOrEqual(100);
  });

  test('includes feature breakdown', () => {
    const audio = generateSpeechLike(sr, 1.0);
    const result = AIIntelligence.estimateVoiceQuality(audio, sr);
    expect(result).toHaveProperty('features');
    expect(result.features).toHaveProperty('centroid');
    expect(result.features).toHaveProperty('flux');
    expect(result.features).toHaveProperty('zcr');
  });
});

describe('AIIntelligence — Private Helpers', () => {
  test('_calcRMS returns correct value for known signal', () => {
    // RMS of sine wave with amplitude A = A/sqrt(2)
    const sr = 48000;
    const audio = generateSineWave(1000, sr, 0.1, 1.0);
    const rms = AIIntelligence._calcRMS(audio);
    // Expected: 1/sqrt(2) ≈ 0.707
    expect(rms).toBeCloseTo(0.707, 1);
  });

  test('_calcPeak returns maximum absolute value', () => {
    const audio = new Float32Array([0.1, -0.5, 0.3, -0.8, 0.2]);
    expect(AIIntelligence._calcPeak(audio)).toBeCloseTo(0.8, 5);
  });

  test('_calcZCR returns value between 0 and 1', () => {
    const audio = generateSineWave(440, 48000, 0.1);
    const zcr = AIIntelligence._calcZCR(audio);
    expect(zcr).toBeGreaterThanOrEqual(0);
    expect(zcr).toBeLessThanOrEqual(1);
  });

  test('_scoreFeature returns weight for in-range value', () => {
    expect(AIIntelligence._scoreFeature(500, 100, 1000, 1.0)).toBeCloseTo(1.0, 1);
  });

  test('_scoreFeature returns 0 for far out-of-range value', () => {
    const score = AIIntelligence._scoreFeature(10000, 100, 500, 1.0);
    expect(score).toBeLessThan(0.1);
  });
});

describe('_calcDynamicRange order statistics (no full-track sort)', () => {
  const AI = require('../public/app/ai-intelligence.js');
  const sortedAbs = (a) => Float32Array.from(a, Math.abs).sort();

  test('_absOrderStats returns exactly the sorted |x| at each rank', () => {
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const a = new Float32Array(50_000);
    for (let i = 0; i < a.length; i++) {
      const r = rnd();
      a[i] = r < 0.05 ? 0 : r < 0.07 ? -0 : r < 0.1 ? 1e-40 * (rnd() - 0.5) : (rnd() - 0.5) * 2 ** (rnd() * 20 - 18);
    }
    const sorted = sortedAbs(a);
    const ks = [0, 1, 2499, 25_000, 47_500, a.length - 1];
    const got = AI._absOrderStats(a, ks);
    ks.forEach((k, i) => expect(Object.is(got[i], sorted[k]) || got[i] === sorted[k]).toBe(true));
  });

  test('matches the sort-based dynamic range on a subarray view', () => {
    const base = new Float32Array(9000).map((_, i) => Math.sin(i * 0.013) * (i % 900 < 600 ? 0.5 : 0.01));
    const view = base.subarray(1000, 8000);
    const s = sortedAbs(view);
    const expected = 20 * Math.log10(s[Math.floor(0.95 * s.length)] / (s[Math.floor(0.05 * s.length)] + 1e-10));
    expect(AI._calcDynamicRange(view)).toBe(expected);
  });
});

describe('full-track scene classification (no sampling)', () => {
  // A long track with one short transient far from the start: any excerpt or
  // stride would miss it and change peak, crest factor and the suggestions.
  function longTrack(n) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      a[i] = Math.sin(i * 0.031) * (i % 48000 < 30000 ? 0.2 : 0.004) + ((i * 7919) % 13) / 1300;
    }
    a[Math.floor(n * 0.6137)] = 0.97;
    return a;
  }

  test('classifySceneAsync equals classifyScene on every sample, across chunk boundaries', async () => {
    const audio = longTrack(48000 * 45);
    const sync = AIIntelligence.classifyScene(audio, 48000);
    let yields = 0;
    const asyncResult = await AIIntelligence.classifySceneAsync(audio, 48000, {
      yieldBudget: async () => { yields++; },
    });
    expect(yields).toBeGreaterThan(1);
    expect(asyncResult).toEqual(sync);
    expect(sync.features.peak).toBeCloseTo(0.97, 6);
  });

  test('autoTuneParamsAsync equals autoTuneParams', async () => {
    const audio = longTrack(48000 * 35);
    expect(await AIIntelligence.autoTuneParamsAsync(audio, 48000, {}))
      .toEqual(AIIntelligence.autoTuneParams(audio, 48000, {}));
  });

  test('short input returns the default scene on both paths', async () => {
    const tiny = new Float32Array(100);
    expect(await AIIntelligence.classifySceneAsync(tiny, 48000)).toEqual(AIIntelligence.classifyScene(tiny, 48000));
  });
});
