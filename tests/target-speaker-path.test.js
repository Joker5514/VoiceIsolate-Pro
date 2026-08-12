/**
 * Target-speaker path: mel voiceprint, gain smoothing, diarization fusion.
 */
'use strict';

let ts;
let clickFix;

beforeAll(async () => {
  ts = await import('../src/core/TargetSpeaker.js');
  clickFix = await import('../src/core/AudioClickFix.js');
});

function makeSpeechy(sr, sec, f0 = 180) {
  const n = Math.floor(sr * sec);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // Harmonic-ish burst to pass enrollment energy checks
    x[i] = 0.2 * Math.sin(2 * Math.PI * f0 * t)
      + 0.08 * Math.sin(2 * Math.PI * f0 * 2 * t)
      + 0.03 * Math.sin(2 * Math.PI * f0 * 3 * t);
  }
  return x;
}

describe('TargetSpeaker local voiceprint', () => {
  const SR = 16000;

  test('enrollFromRange accepts clear speech segment', () => {
    const x = makeSpeechy(SR, 2.0, 160);
    const r = ts.enrollFromRange(x, SR, { startSec: 0.2, endSec: 1.5 });
    expect(r.ok).toBe(true);
    expect(r.embedding.length).toBe(24);
    expect(r.meta.method).toBe('local-mel-voiceprint');
  });

  test('cosine similarity self-match is high', () => {
    const x = makeSpeechy(SR, 1.5, 200);
    const emb = ts.extractLocalVoiceprint(x, SR);
    expect(ts.cosineSimilarity(emb, emb)).toBeGreaterThan(0.99);
  });

  test('buildTargetGainCurve is smooth (no hard steps)', () => {
    const x = makeSpeechy(SR, 2.0, 150);
    const emb = ts.extractLocalVoiceprint(x.subarray(0, SR), SR);
    // Second half different pitch → lower sim
    for (let i = SR; i < x.length; i++) {
      x[i] = 0.15 * Math.sin(2 * Math.PI * 400 * (i / SR));
    }
    const gain = ts.buildTargetGainCurve(x, SR, emb, { smoothMs: 15 });
    expect(gain.length).toBe(x.length);
    let maxStep = 0;
    for (let i = 1; i < gain.length; i++) {
      maxStep = Math.max(maxStep, Math.abs(gain[i] - gain[i - 1]));
    }
    // ~0.06 per ms * (1000/SR) ms per sample ≈ 0.00375 @ 16k; allow headroom
    expect(maxStep).toBeLessThan(0.05);
  });

  test('diarization fusion attenuates non-target cluster', () => {
    const x = makeSpeechy(SR, 2.0, 180);
    const emb = ts.extractLocalVoiceprint(x.subarray(0, SR), SR);
    const segs = [
      { speakerId: 'A', start: 0, end: 1 },
      { speakerId: 'B', start: 1, end: 2 },
    ];
    const gain = ts.buildTargetGainCurve(x, SR, emb, {
      diarizationSegments: segs,
      targetSpeakerId: 'A',
      smoothMs: 10,
    });
    const midA = gain[Math.floor(SR * 0.5)];
    const midB = gain[Math.floor(SR * 1.5)];
    expect(midA).toBeGreaterThan(midB);
  });

  test('matchEmbeddingToDiarization picks closest cluster', () => {
    const a = makeSpeechy(SR, 1.2, 140);
    const b = makeSpeechy(SR, 1.2, 320);
    const mix = new Float32Array(a.length + b.length);
    mix.set(a, 0);
    mix.set(b, a.length);
    const embA = ts.extractLocalVoiceprint(a, SR);
    const segs = [
      { speakerId: 'spk0', start: 0, end: 1.2 },
      { speakerId: 'spk1', start: 1.2, end: 2.4 },
    ];
    const m = ts.matchEmbeddingToDiarization(mix, SR, embA, segs);
    expect(m).toBeTruthy();
    expect(m.speakerId).toBe('spk0');
  });

  test('UI honesty: mel voiceprint not ECAPA claim', () => {
    const fs = require('fs');
    const path = require('path');
    const ui = fs.readFileSync(path.join(__dirname, '../src/presentation/TargetSpeakerUI.js'), 'utf8');
    expect(ui).toMatch(/mel-band voiceprint|mel voiceprint/i);
    expect(ui).toMatch(/not ECAPA/);
  });
});
