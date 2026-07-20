/**
 * Full analysis pipeline — classical features, whisper logic, recommendations.
 */
'use strict';

let globalLevels;
let extractFrameFeatures;
let downmixToMono;
let speechBandRatio;
let magnitudeSpectrum;
let framesToSegments;
let mergeGaps;
let majoritySmooth;
let continuityScore;
let whisperFrameConfidence;
let detectWhisperRegions;
let whisperProcessingPolicy;
let analyzeAudio;
let recommendFromAnalysis;
let ENGINEER_PRESET_CATALOG;
let checkCapabilities;
let probeSharedArrayBuffer;
let CALIBRATED_ENGINEER_PRESETS;
let resolvePresetName;
let PRESET_REDIRECTS;
let bootstrapScenario;
let clampGainStaging;
let wienerIntensity;
let safeFilename;
let encodeWav;

beforeAll(async () => {
  const fe = await import('../src/core/FeatureExtractor.js');
  ({ globalLevels, extractFrameFeatures, downmixToMono, speechBandRatio, magnitudeSpectrum } = fe);
  const sm = await import('../src/core/SegmentMerger.js');
  ({ framesToSegments, mergeGaps, majoritySmooth, continuityScore } = sm);
  const wl = await import('../src/core/WhisperLogic.js');
  ({ whisperFrameConfidence, detectWhisperRegions, whisperProcessingPolicy } = wl);
  const fa = await import('../src/core/FullAnalysis.js');
  ({ analyzeAudio } = fa);
  const re = await import('../src/core/RecommendationEngine.js');
  ({ recommendFromAnalysis, ENGINEER_PRESET_CATALOG } = re);
  const cap = await import('../src/core/CapabilityChecker.js');
  ({ checkCapabilities, probeSharedArrayBuffer } = cap);
  const pc = await import('../src/core/PresetCalibration.js');
  ({ CALIBRATED_ENGINEER_PRESETS, resolvePresetName, PRESET_REDIRECTS } = pc);
  const dc = await import('../src/core/DspCalibration.js');
  ({ bootstrapScenario, clampGainStaging, wienerIntensity } = dc);
  const em = await import('../src/pipeline/ExportManager.js');
  ({ safeFilename, encodeWav } = em);
});

function tone(freq, sr, sec, amp = 0.2) {
  const n = Math.floor(sr * sec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

function quietSpeechLike(sr, sec) {
  const n = Math.floor(sr * sec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = 0.012 * (
      Math.sin(2 * Math.PI * 180 * t)
      + 0.5 * Math.sin(2 * Math.PI * 360 * t)
      + 0.25 * Math.sin(2 * Math.PI * 720 * t)
    );
  }
  return out;
}

describe('FeatureExtractor', () => {
  test('globalLevels on tone', () => {
    const s = tone(440, 48000, 0.2, 0.5);
    const g = globalLevels(s);
    expect(g.peak).toBeGreaterThan(0.4);
    expect(g.rms).toBeGreaterThan(0.1);
    expect(g.rmsDb).toBeGreaterThan(-20);
  });

  test('extractFrameFeatures returns frames + hum/snr', () => {
    const s = tone(440, 16000, 0.5, 0.3);
    const ext = extractFrameFeatures(s, 16000, { frameSec: 0.032, hopSec: 0.016 });
    expect(ext.frames.length).toBeGreaterThan(5);
    expect(ext.frames[0]).toHaveProperty('centroid');
    expect(ext.frames[0]).toHaveProperty('speechRatio');
    expect(typeof ext.snrDb).toBe('number');
    expect(ext.humProfile).toHaveProperty('freq');
  });

  test('downmixToMono averages channels', () => {
    const a = new Float32Array([1, 1]);
    const b = new Float32Array([0, 0]);
    const m = downmixToMono([a, b]);
    expect(m[0]).toBeCloseTo(0.5);
  });

  test('speechBandRatio higher for mid tone than silence', () => {
    const s = tone(1000, 16000, 0.1, 0.4);
    const mag = magnitudeSpectrum(s.subarray(0, 512));
    const r = speechBandRatio(mag, 16000);
    expect(r).toBeGreaterThan(0);
  });
});

describe('SegmentMerger', () => {
  test('framesToSegments merges runs', () => {
    const labeled = [
      { t: 0, label: 'speech', confidence: 0.9 },
      { t: 0.01, label: 'speech', confidence: 0.8 },
      { t: 0.02, label: 'noise', confidence: 0.7 },
    ];
    const segs = framesToSegments(labeled, 0.01, { minSec: 0.01, mergeGapSec: 0.05 });
    expect(segs.length).toBeGreaterThanOrEqual(1);
    expect(segs[0].label).toBe('speech');
  });

  test('majoritySmooth reduces flicker', () => {
    const s = majoritySmooth([false, true, false, true, true, true, false], 1);
    expect(s.length).toBe(7);
    expect(s[4]).toBe(true);
  });

  test('continuityScore', () => {
    expect(continuityScore(['a', 'a', 'a'])).toBe(1);
    expect(continuityScore(['a', 'b'])).toBe(0);
  });

  test('mergeGaps', () => {
    const m = mergeGaps([
      { start: 0, end: 0.2, label: 'speech', confidence: 1 },
      { start: 0.25, end: 0.5, label: 'speech', confidence: 0.9 },
    ], 0.1, 0.05);
    expect(m.length).toBe(1);
    expect(m[0].end).toBeCloseTo(0.5);
  });
});

describe('WhisperLogic', () => {
  test('quiet speech-like frames score higher than silence', () => {
    const silence = { rms: 0.0001, rmsDb: -80, speechRatio: 0, harmonicity: 0, flatness: 1, voiced: 0, zcr: 0.2 };
    const whisper = {
      rms: 0.01, rmsDb: -40, speechRatio: 0.45, harmonicity: 0.35, flatness: 0.25, voiced: 0.5, zcr: 0.08,
    };
    expect(whisperFrameConfidence(whisper, { noiseFloor: 0.001 })).toBeGreaterThan(
      whisperFrameConfidence(silence, { noiseFloor: 0.001 }),
    );
  });

  test('detectWhisperRegions on quiet harmonic audio', () => {
    const s = quietSpeechLike(16000, 1.0);
    const ext = extractFrameFeatures(s, 16000, { frameSec: 0.025, hopSec: 0.01 });
    const pack = detectWhisperRegions(ext, { minWhisperConf: 0.25 });
    expect(pack).toHaveProperty('whisperRegions');
    expect(pack).toHaveProperty('frameScores');
    const policy = whisperProcessingPolicy(pack, { snrDb: 5 });
    expect(policy).toHaveProperty('protectConsonants', true);
    expect(policy.gateThreshDb).toBeLessThanOrEqual(-52);
  });
});

describe('FullAnalysis + Recommendation', () => {
  test('analyzeAudio returns required schema fields', () => {
    const s = tone(300, 16000, 0.8, 0.15);
    const analysis = analyzeAudio([s], 16000);
    const required = [
      'duration', 'sampleRate', 'channels', 'rms', 'peak', 'loudnessEstimate',
      'globalNoiseProfile', 'humProfile', 'roomEstimate',
      'speechSegments', 'silenceSegments', 'musicSegments', 'noiseSegments',
      'transientSegments', 'reverbSegments', 'speakerSegments', 'overlapRegions',
      'whisperRegions', 'difficultSpeechRegions',
      'detectedSources', 'confidenceScores', 'visualLayers',
      'recommendedPreset', 'recommendedStageConfig', 'recommendedProcessingPlan',
    ];
    for (const k of required) {
      expect(analysis).toHaveProperty(k);
    }
    expect(analysis.duration).toBeCloseTo(0.8, 1);
    expect(analysis.visualLayers.length).toBeGreaterThan(5);
    expect(ENGINEER_PRESET_CATALOG).toContain(analysis.recommendedPreset);
  });

  test('recommendFromAnalysis hum bias', () => {
    const rec = recommendFromAnalysis({
      snrDb: 18,
      rms: 0.05,
      humProfile: { present: true, freq: 60, strength: 0.4 },
      roomEstimate: 0.1,
      whisperRegions: [],
      difficultSpeechRegions: [],
      musicSegments: [],
      speakerSegments: [],
      overlapRegions: [],
      confidenceScores: { speechRatio: 0.6, musicRatio: 0.05 },
    });
    expect(rec.recommendedPreset).toBe('Hum Removal');
    expect(rec.reasons.join(' ')).toMatch(/hum/i);
  });
});

describe('Capability + Calibration + Export', () => {
  test('checkCapabilities returns summary', () => {
    const report = checkCapabilities({ models: { rnnoise: true }, worklets: { gate: false } });
    expect(report.summary).toHaveProperty('ready');
    expect(report.capabilities['model:rnnoise'].available).toBe(true);
    expect(report.capabilities['worklet:gate'].available).toBe(false);
  });

  test('probeSharedArrayBuffer does not throw', () => {
    const e = probeSharedArrayBuffer(globalThis);
    expect(e).toHaveProperty('id', 'sab');
  });

  test('calibrated presets and redirects', () => {
    expect(Object.keys(CALIBRATED_ENGINEER_PRESETS).length).toBeGreaterThanOrEqual(8);
    expect(resolvePresetName('Whisper in a Club')).toBe(PRESET_REDIRECTS['Whisper in a Club']);
    expect(resolvePresetName('Voice Clarity')).toBe('Voice Clarity');
  });

  test('dsp calibration helpers', () => {
    const b = bootstrapScenario('whisper');
    expect(b.gateThresh).toBeLessThan(-60);
    const g = clampGainStaging(20, 20);
    expect(g.limited).toBe(true);
    expect(wienerIntensity(100)).toBeLessThanOrEqual(1);
  });

  test('encodeWav + safeFilename', () => {
    const ch = [new Float32Array(100).fill(0.1)];
    const blob = encodeWav(ch, 48000);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBeGreaterThan(44);
    expect(safeFilename('My File!!!.wav')).toMatch(/\.wav$/);
  });
});
