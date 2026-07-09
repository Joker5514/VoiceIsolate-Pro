'use strict';

const fs = require('fs');
const path = require('path');

function loadWhisperHunterModule() {
  let src = fs.readFileSync(path.join(__dirname, '../public/app/whisper-hunter.js'), 'utf8');
  src = src.replace(/^export /gm, '');
  const sandbox = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function('exports', 'window', `${src}\nreturn { WhisperHunterAI, mapWhisperUi, analyzeAcousticEnvironment, maskConfidence, chunkedMaskInference };`);
  return fn(sandbox, {});
}

const {
  WhisperHunterAI,
  mapWhisperUi,
  analyzeAcousticEnvironment,
  maskConfidence,
} = loadWhisperHunterModule();

function makeToneBuffer(freq = 440, durationSec = 0.25, sampleRate = 48000) {
  const len = Math.floor(durationSec * sampleRate);
  const data = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    data[i] = 0.35 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }
  return {
    sampleRate,
    length: len,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

describe('WhisperHunterAI DSP', () => {
  test('mapWhisperUi maps 50 to ~0.5', () => {
    expect(mapWhisperUi(50)).toBeCloseTo(0.5, 1);
  });

  test('processFrame preserves speech-like energy after noise learning', () => {
    const hunter = new WhisperHunterAI(512, 48000);
    const halfN = hunter.halfBins;
    const params = { clarity: 0.5, sensitivity: 0.5, threshold: 0.5, harmonic: 0 };

    const noiseRe = new Float32Array(halfN);
    const noiseIm = new Float32Array(halfN);
    for (let k = 0; k < halfN; k++) {
      const n = (Math.random() - 0.5) * 0.02;
      noiseRe[k] = n;
      noiseIm[k] = n * 0.5;
    }
    for (let i = 0; i < 8; i++) hunter.processFrame(noiseRe, noiseIm, params);

    const voiceLo = hunter._voiceLo;
    const voiceHi = hunter._voiceHi;
    const speechRe = new Float32Array(halfN);
    const speechIm = new Float32Array(halfN);
    const voiceBin = Math.round(1000 / hunter._binHz);
    for (let h = 1; h <= 4; h++) {
      const k = Math.min(halfN - 1, voiceBin * h);
      if (k >= voiceLo && k <= voiceHi) speechRe[k] = 0.08;
    }

    const before = speechRe[voiceBin];
    const vad = hunter.processFrame(speechRe, speechIm, params);
    expect(vad).toBe(1);
    expect(Math.abs(speechRe[voiceBin])).toBeGreaterThanOrEqual(Math.abs(before) * 0.5);
  });

  test('seedNoiseFromAudio updates noise profile from quiet audio', () => {
    const hunter = new WhisperHunterAI(512, 48000);
    const data = new Float32Array(2048);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() - 0.5) * 0.005;
    const seeded = hunter.seedNoiseFromAudio(data, 48000);
    expect(seeded).toBeGreaterThan(0);
    expect(hunter.noiseFloor).toBeGreaterThan(0);
  });
});

describe('WhisperHunter analysis helpers', () => {
  test('analyzeAcousticEnvironment returns profile for tone buffer', () => {
    const buf = makeToneBuffer(220, 1);
    const env = analyzeAcousticEnvironment(buf);
    expect(env).toHaveProperty('dominantNoise');
    expect(env).toHaveProperty('voiceRatio');
    expect(env.voiceRatio).toBeGreaterThan(0);
    expect(env.rt60).toBeGreaterThan(0);
  });

  test('maskConfidence weights voice band higher', () => {
    const masks = new Array(2049).fill(0.2);
    for (let i = 200; i < 700; i++) masks[i] = 0.85;
    const conf = maskConfidence(masks);
    expect(conf).toBeGreaterThan(0.5);
  });
});

describe('whisper-hunter.js source features', () => {
  const src = fs.readFileSync(path.join(__dirname, '../public/app/whisper-hunter.js'), 'utf8');

  test('exports Wiener-style separation and chunked ML inference', () => {
    expect(src).toContain('chunkedMaskInference');
    expect(src).toContain('seedNoiseFromAudio');
    expect(src).toContain('analyzeAcousticEnvironment');
    expect(src).toContain('flatness');
  });
});

describe('app.js WhisperHunter orchestrator wiring', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');

  test('imports smarter whisper-hunter helpers', () => {
    expect(appJs).toContain("from './whisper-hunter.js'");
    expect(appJs).toContain('analyzeAcousticEnvironment');
    expect(appJs).toContain('chunkedMaskInference');
    expect(appJs).toContain('maskConfidence');
  });

  test('forensic passes escalate separation sliders', () => {
    expect(appJs).toContain('WhisperHunter pass');
    expect(appJs).toContain('crowdNull: Math.min(100');
    expect(appJs).toContain('seedNoiseFromAudio');
  });
});