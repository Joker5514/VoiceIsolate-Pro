/**
 * Round 10 analysis quirks: the hum detector summed five 23 Hz-wide FFT bins
 * near 50/60 Hz per 25 ms frame (any bass or rumble counted as "hum"), took the
 * file MAX, and labelled music frames "hum" before "music". Whisper-only and
 * club files both read "Hum/buzz 100%, 50 Hz" and the club bed was not found.
 */
'use strict';

const SR = 48000;
let analyzeAudio;
let extractFrameFeatures;

beforeAll(async () => {
  ({ analyzeAudio } = await import('../src/core/FullAnalysis.js'));
  ({ extractFrameFeatures } = await import('../src/core/FeatureExtractor.js'));
});

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
}

/** Whisper-like: hissy noise bursts with gaps, over low-frequency room rumble. */
function whisperWithRumble(sec = 8) {
  const r = rng(7);
  const n = SR * sec; const x = new Float32Array(n);
  let hp = 0; let prev = 0; let brown = 0;
  for (let i = 0; i < n; i++) {
    const w = r();
    hp = 0.95 * (hp + w - prev); prev = w; // crude high-pass: hiss
    const t = i / SR; const on = (t % 1.2) < 0.7 ? 1 : 0;
    brown = 0.995 * brown + 0.05 * r(); // rumble below ~40 Hz
    x[i] = 0.05 * on * hp + 0.02 * brown;
  }
  return x;
}

/** Club-like: pitch-swept kicks + a sustained low harmonic pad (a music bed). */
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

function withHum(x, f0, level = 0.01) {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    y[i] = x[i] + level * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t) + 0.3 * Math.sin(2 * Math.PI * 3 * f0 * t));
  }
  return y;
}

/** Steady narrowband tone at one frequency, no harmonics. */
function loneTone(sec, f0, level = 0.01) {
  const n = SR * sec; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = level * Math.sin(2 * Math.PI * f0 * i / SR);
  return x;
}

/** Lone tone under the whisper+rumble fixture (fundamental still missing). */
function whisperWithLoneTone(f0, level = 0.01, sec = 8) {
  const x = whisperWithRumble(sec);
  for (let i = 0; i < x.length; i++) x[i] += level * Math.sin(2 * Math.PI * f0 * i / SR);
  return x;
}

/** Pitch-varying tone around f0 (vibrato), not a stationary mains line. */
function warbledTone(sec, f0, depthHz = 6, rate = 5, level = 0.01) {
  const n = SR * sec; const x = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 + depthHz * Math.sin(2 * Math.PI * rate * t);
    phase += (2 * Math.PI * f) / SR;
    x[i] = level * Math.sin(phase);
  }
  return x;
}

/** Level-gated 120 Hz bursts (on 200 ms / off 300 ms), not a steady hum. */
function pulsedTone(sec, f0, level = 0.01) {
  const n = SR * sec; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const on = (t % 0.5) < 0.2 ? 1 : 0;
    x[i] = on * level * Math.sin(2 * Math.PI * f0 * i / SR);
  }
  return x;
}

describe('hum detection', () => {
  test('whisper over room rumble is not hum', () => {
    const a = analyzeAudio([whisperWithRumble()], SR);
    expect(a.humProfile.present).toBe(false);
    expect(a.humSegments).toHaveLength(0);
  });

  test('a club bed (kicks + chords) is not hum, and is found as music', () => {
    const a = analyzeAudio([clubBed()], SR);
    expect(a.humProfile.present).toBe(false);
    expect(a.humSegments).toHaveLength(0);
    expect(a.musicSegments.length).toBeGreaterThan(0);
  });

  test('real 60 Hz mains hum under a whisper is found at 60 Hz', () => {
    const a = analyzeAudio([withHum(whisperWithRumble(), 60)], SR);
    expect(a.humProfile.present).toBe(true);
    expect(a.humProfile.freq).toBe(60);
  });

  test('real 50 Hz mains hum is found at 50 Hz', () => {
    const e = extractFrameFeatures(withHum(whisperWithRumble(), 50), SR);
    expect(e.humProfile.present).toBe(true);
    expect(e.humProfile.freq).toBe(50);
  });

  test('a steady lone 120 Hz tone (no fundamental or higher harmonics) is 60 Hz mains hum', () => {
    const a = analyzeAudio([loneTone(8, 120)], SR);
    expect(a.humProfile.present).toBe(true);
    expect(a.humProfile.freq).toBe(60);
  });

  test('a steady lone 100 Hz tone is 50 Hz mains hum', () => {
    const e = extractFrameFeatures(loneTone(8, 100), SR);
    expect(e.humProfile.present).toBe(true);
    expect(e.humProfile.freq).toBe(50);
  });

  test('a steady 120 Hz buzz under whisper and rumble is still 60 Hz mains hum', () => {
    const a = analyzeAudio([whisperWithLoneTone(120)], SR);
    expect(a.humProfile.present).toBe(true);
    expect(a.humProfile.freq).toBe(60);
    expect(a.musicSegments).toHaveLength(0);
  });

  test('a sustained bass note off the mains series is not hum', () => {
    const a = analyzeAudio([loneTone(8, 110, 0.05)], SR);
    expect(a.humProfile.present).toBe(false);
    expect(a.humSegments).toHaveLength(0);
  });

  test('a 120 Hz tone that warbles in pitch is not hum', () => {
    const a = analyzeAudio([warbledTone(8, 120)], SR);
    expect(a.humProfile.present).toBe(false);
    expect(a.humSegments).toHaveLength(0);
  });

  test('a level-gated 120 Hz burst train is not hum', () => {
    const a = analyzeAudio([pulsedTone(8, 120)], SR);
    expect(a.humProfile.present).toBe(false);
    expect(a.humSegments).toHaveLength(0);
  });
});

describe('music-bed segments', () => {
  test('a few scattered harmonic frames in a whisper do not make a music bed', () => {
    // 60 ms low harmonic blips every 150 ms (0.8 s in all) inside a whisper:
    // close enough to merge into one segment, but not a sustained music bed.
    const x = whisperWithRumble();
    for (let k = 0; k < 6; k++) {
      const s0 = Math.floor((2 + k * 0.15) * SR);
      for (let i = 0; i < 0.06 * SR; i++) x[s0 + i] += 0.08 * Math.sin(2 * Math.PI * 180 * i / SR);
    }
    const a = analyzeAudio([x], SR);
    expect(a.musicSegments).toHaveLength(0);
  });
});

describe('SNR naming', () => {
  test('the analysis SNR says it is an input estimate, not the header SNR', async () => {
    const { recommendFromAnalysis } = await import('../src/core/RecommendationEngine.js');
    const rec = recommendFromAnalysis({ snrDb: 6.9, rms: 0.02 });
    expect(rec.findings[0]).toMatch(/^Input SNR estimate ≈ \+?6\.9 dB \(file level vs its quietest 10% of frames\)$/);
  });
});

describe('workspace auto-analysis hum', () => {
  test('a bass-heavy club bed is not reported as hum (the old proxy counted slow samples)', async () => {
    const { runAutoAnalysis } = await import('../src/core/audio/analysis/AutoAnalysis.js');
    const r = await runAutoAnalysis([clubBed()], SR);
    expect(r.humSegments).toHaveLength(0);
  });

  test('real 60 Hz hum is still reported, with its frequency', async () => {
    const { runAutoAnalysis } = await import('../src/core/audio/analysis/AutoAnalysis.js');
    const r = await runAutoAnalysis([withHum(whisperWithRumble(), 60)], SR);
    expect(r.humSegments).toHaveLength(1);
    expect(r.humSegments[0].freqs[0]).toBe(60);
  });

  test('a lone 120 Hz tone is reported as 60 Hz hum', async () => {
    const { runAutoAnalysis } = await import('../src/core/audio/analysis/AutoAnalysis.js');
    const r = await runAutoAnalysis([loneTone(8, 120)], SR);
    expect(r.humSegments).toHaveLength(1);
    expect(r.humSegments[0].freqs[0]).toBe(60);
  });
});
