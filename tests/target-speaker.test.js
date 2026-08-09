'use strict';

const { pathToFileURL } = require('url');
const path = require('path');

let TS;

beforeAll(async () => {
  TS = await import(pathToFileURL(path.join(__dirname, '../src/core/TargetSpeaker.js')).href);
});

function tone(sr, sec, hz, amp = 0.2) {
  const n = Math.floor(sr * sec);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(2 * Math.PI * hz * i / sr);
  return out;
}

describe('TargetSpeaker local enrollment', () => {
  const sr = 48000;

  test('rejects short enrollment', () => {
    const samples = tone(sr, 2, 220);
    const r = TS.validateEnrollmentSegment(samples, sr, { startSec: 0, endSec: 0.1 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/short/i);
  });

  test('accepts speech-like tone segment and builds embedding', () => {
    const samples = tone(sr, 3, 180, 0.25);
    const r = TS.enrollFromRange(samples, sr, { startSec: 0.2, endSec: 1.5 });
    expect(r.ok).toBe(true);
    expect(r.embedding.length).toBeGreaterThan(8);
    expect(r.meta.method).toBe('local-mel-voiceprint');
  });

  test('cosine similarity is high for same voiceprint', () => {
    const samples = tone(sr, 2, 200, 0.3);
    const a = TS.extractLocalVoiceprint(samples, sr);
    const b = TS.extractLocalVoiceprint(samples, sr);
    expect(TS.cosineSimilarity(a, b)).toBeGreaterThan(0.9);
  });

  test('buildTargetGainCurve returns unit length gains', () => {
    const samples = tone(sr, 1, 220, 0.2);
    const emb = TS.extractLocalVoiceprint(samples, sr);
    const g = TS.buildTargetGainCurve(samples, sr, emb);
    expect(g.length).toBe(samples.length);
    let max = 0;
    for (let i = 0; i < g.length; i++) if (g[i] > max) max = g[i];
    expect(max).toBeGreaterThan(0.5);
  });
});
