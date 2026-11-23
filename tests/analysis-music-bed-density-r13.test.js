/**
 * Round 13 (#950 follow-up): a whisper with low harmonic frames scattered
 * through it (Randy's control: a steady 120 Hz buzz under whisper plus
 * sub-bass rumble; 10.6 % of frames pass the music rule) was bridged by the
 * 0.5 s merge into "music beds" over 61 % of the file. A bed must be dense:
 * at least MUSIC_BED_MIN_DENSITY of its frames must be music.
 */
'use strict';

const SR = 48000;
let analyzeAudio;
let classifyUnwantedSounds;

beforeAll(async () => {
  ({ analyzeAudio } = await import('../src/core/FullAnalysis.js'));
  ({ classifyUnwantedSounds } = await import('../src/core/AnalyzerWhisperBridge.js'));
});

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
}

/** Whisper hiss in syllables (period / duty) over sub-bass rumble. */
function whisper(sec, period, duty, hiss = 0.05) {
  const r = rng(7);
  const n = SR * sec; const x = new Float32Array(n);
  let hp = 0; let prev = 0; let brown = 0;
  for (let i = 0; i < n; i++) {
    const w = r();
    hp = 0.95 * (hp + w - prev); prev = w;
    const t = i / SR; const on = (t % period) < duty ? 1 : 0;
    brown = 0.995 * brown + 0.05 * r();
    x[i] = hiss * on * hp + 0.02 * brown;
  }
  return x;
}

/** 50 ms low harmonic creaks (120 + 240 Hz) in every syllable gap. */
function withCreaks(x, every, dur, from, to) {
  for (let t = from; t < to; t += every) {
    const s0 = Math.floor(t * SR);
    for (let i = 0; i < dur * SR && s0 + i < x.length; i++) {
      x[s0 + i] += 0.08 * (Math.sin(2 * Math.PI * 120 * i / SR) + 0.5 * Math.sin(2 * Math.PI * 240 * i / SR));
    }
  }
  return x;
}

function clubBed(sec = 8) {
  const n = SR * sec; const x = new Float32Array(n);
  const beat = 60 / 128;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR; const tb = t % beat;
    const f = 45 + 105 * Math.exp(-tb / 0.03);
    phase += (2 * Math.PI * f) / SR;
    let v = 0.4 * Math.exp(-tb / 0.12) * Math.sin(phase);
    for (const f0 of [98, 123.5, 146.8]) {
      for (let h = 1; h <= 4; h++) v += (0.02 / h) * Math.sin(2 * Math.PI * f0 * h * t);
    }
    x[i] = 0.5 * v;
  }
  return x;
}

function withHumSeries(x, f0, level = 0.01) {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    y[i] = x[i] + level * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t) + 0.3 * Math.sin(2 * Math.PI * 3 * f0 * t));
  }
  return y;
}

/** Voiced speech-like: 140 Hz glottal pulse train shaped into syllables. */
function voicedSpeech(sec = 8) {
  const n = SR * sec; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.max(0, Math.sin(Math.PI * ((t % 0.4) / 0.28))) * ((t % 0.4) < 0.28 ? 1 : 0);
    let v = 0;
    for (let h = 1; h <= 20; h++) v += Math.sin(2 * Math.PI * 140 * h * t) / h * (h * 140 > 300 && h * 140 < 3000 ? 1.5 : 0.5);
    x[i] = 0.03 * env * v;
  }
  return x;
}

describe('music beds are dense, not bridged scatter', () => {
  test('whisper with scattered low harmonic frames is not a music bed (control-like)', () => {
    const a = analyzeAudio([withCreaks(whisper(8, 0.25, 0.18), 0.25, 0.05, 1.19, 7.5)], SR);
    expect(a.musicSegments).toHaveLength(0);
    const u = classifyUnwantedSounds(a);
    expect(u.classes.music.present).toBe(false);
    expect(u.classes.hum.present).toBe(false);
    expect(a.recommendation.findings.join(' | ')).not.toMatch(/music-bed/);
  });

  test('a club bed is still a music bed', () => {
    const a = analyzeAudio([clubBed()], SR);
    expect(a.musicSegments.length).toBeGreaterThan(0);
    expect(classifyUnwantedSounds(a).classes.music.present).toBe(true);
  });

  test('a club bed under a whisper (the mix) is still a music bed', () => {
    const w = whisper(8, 1.2, 0.7, 0.02); const c = clubBed();
    const mix = new Float32Array(w.length);
    for (let i = 0; i < mix.length; i++) mix[i] = w[i] + c[i];
    const a = analyzeAudio([mix], SR);
    expect(a.musicSegments.length).toBeGreaterThan(0);
    expect(classifyUnwantedSounds(a).classes.music.present).toBe(true);
  });
});

describe('hum: tonal mains series vs broadband sub-bass', () => {
  test('sub-bass rumble under a whisper is not hum', () => {
    const a = analyzeAudio([whisper(8, 1.2, 0.7)], SR);
    expect(a.humProfile.present).toBe(false);
    expect(classifyUnwantedSounds(a).classes.hum.present).toBe(false);
  });

  test('60 Hz + harmonics on voiced speech is flagged as hum at 60 Hz', () => {
    const a = analyzeAudio([withHumSeries(voicedSpeech(), 60)], SR);
    expect(a.humProfile.present).toBe(true);
    expect(a.humProfile.freq).toBe(60);
    const hum = classifyUnwantedSounds(a).classes.hum;
    expect(hum.present).toBe(true);
    expect(hum.label).toBe('Hum / buzz (~60 Hz)');
  });
});
