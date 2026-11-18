/**
 * Round 10, item 2: the session stats must track separation quality and be
 * level-invariant. On main 9569dd0 every stat was an energy split of the
 * original (o) vs the processed stem (p): "voice" = energy kept in p,
 * "noise" = energy of o - p. That rewards keeping music, counts the model's
 * whisper attenuation as noise, and Output dBFS was the RMS of the processed
 * stem, not the export (Randy's live re-test: stats fell while SI-SDR and
 * STOI rose).
 *
 * New stats (src/core/SessionStats.js), from 50 ms frame energies of
 * o, p and the removed stem r, with speech frames taken from p:
 *   voice %    = speech-locked share of p (energy above p's between-phrase level)
 *   SNR dB     = p's speech frames vs p's gaps
 *   NR dB      = SNR(p) - SNR(o) on the same frames
 *   retention  = 100 * (1 - speech-locked energy in r / speech-locked energy in o)
 *   Output     = the exported file's integrated LUFS + 4x true peak
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SR = 16000;
let computeStemStats;
let statsFromFrames;
let measureExportLoudness;

beforeAll(async () => {
  ({ computeStemStats, statsFromFrames, measureExportLoudness } = await import('../src/core/SessionStats.js'));
});

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
}

/** Known truth: speech-like bursts s and a steady noise bed m (equal power). */
function truth(sec = 12) {
  const r = rng(11);
  const n = SR * sec;
  const s = new Float32Array(n);
  const m = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const on = (t % 1.0) < 0.55 ? 1 : 0;
    s[i] = on * 0.2 * r() * (1 + 0.5 * Math.sin(2 * Math.PI * 4 * t));
    m[i] = 0.15 * r();
  }
  return { s, m };
}

function separate({ s, m }, a, b) {
  const n = s.length;
  const o = new Float32Array(n);
  const p = new Float32Array(n);
  const rm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    o[i] = s[i] + m[i];
    p[i] = a * s[i] + b * m[i];
    rm[i] = o[i] - p[i];
  }
  return { o, p, rm };
}

function siSdr(est, ref) {
  let dot = 0; let rr = 0;
  for (let i = 0; i < ref.length; i++) { dot += est[i] * ref[i]; rr += ref[i] * ref[i]; }
  const k = dot / rr; let t = 0; let e = 0;
  for (let i = 0; i < ref.length; i++) { const x = k * ref[i]; t += x * x; e += (est[i] - x) ** 2; }
  return 10 * Math.log10(t / e);
}

const scale = (x, g) => Float32Array.from(x, (v) => v * g);

describe('session stats follow separation quality', () => {
  test('every stat improves when SI-SDR improves (known truth)', async () => {
    const tr = truth();
    const cases = [[0.5, 0.5], [0.7, 0.3], [0.9, 0.1], [0.97, 0.03]];
    const rows = [];
    for (const [a, b] of cases) {
      const { o, p, rm } = separate(tr, a, b);
      rows.push({ sdr: siSdr(p, tr.s), st: await computeStemStats(o, p, rm, SR) });
    }
    for (let k = 1; k < rows.length; k++) {
      const prev = rows[k - 1]; const cur = rows[k];
      expect(cur.sdr).toBeGreaterThan(prev.sdr);
      expect(cur.st.voicePct).toBeGreaterThan(prev.st.voicePct);
      expect(cur.st.snrDb).toBeGreaterThan(prev.st.snrDb);
      expect(cur.st.noiseReductionDb).toBeGreaterThan(prev.st.noiseReductionDb);
      expect(cur.st.whisperRetentionPct).toBeGreaterThan(prev.st.whisperRetentionPct);
      expect(cur.st.noisePct).toBeCloseTo(100 - cur.st.voicePct, 6);
    }
  });

  test('pure gain does not change any stat (whole session, or the processed stem alone)', async () => {
    const tr = truth();
    const { o, p, rm } = separate(tr, 0.8, 0.2);
    const base = await computeStemStats(o, p, rm, SR);
    for (const g of [0.05, 0.3, 2.5]) {
      const all = await computeStemStats(scale(o, g), scale(p, g), scale(rm, g), SR);
      const stemOnly = await computeStemStats(o, scale(p, g), rm, SR);
      for (const k of ['voicePct', 'snrDb', 'noiseReductionDb', 'whisperRetentionPct']) {
        expect(all[k]).toBeCloseTo(base[k], 6);
        expect(stemOnly[k]).toBeCloseTo(base[k], 6);
      }
    }
  });

  test('a clean whisper kept at -7 dB (no noise) reads as all voice, not 40 % noise', async () => {
    const { s } = truth();
    const p = scale(s, 0.45);
    const rm = Float32Array.from(s, (v, i) => v - p[i]);
    const st = await computeStemStats(s, p, rm, SR);
    expect(st.voicePct).toBeGreaterThan(99);
    expect(st.snrDb).toBeGreaterThanOrEqual(40);
  });

  test('without a removed stem it uses original - processed', async () => {
    const tr = truth();
    const { o, p, rm } = separate(tr, 0.8, 0.2);
    const a = await computeStemStats(o, p, rm, SR);
    const b = await computeStemStats(o, p, null, SR);
    expect(b.whisperRetentionPct).toBeCloseTo(a.whisperRetentionPct, 6);
  });

  test('no speech-like frames: nothing is claimed', () => {
    const flat = new Float64Array(200).fill(1e-4);
    const st = statsFromFrames(flat, flat, flat);
    expect(st.snrDb).toBeNull();
    expect(st.whisperRetentionPct).toBeNull();
  });
});

describe('Output is the exported file', () => {
  test('integrated LUFS and 4x true peak of the export buffer', () => {
    const n = 48000 * 4;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.1 * Math.sin((2 * Math.PI * 997 * i) / 48000);
    const { lufs, truePeakDb } = measureExportLoudness([x], 48000);
    expect(lufs).toBeGreaterThan(-23.3);
    expect(lufs).toBeLessThan(-22.7);
    expect(truePeakDb).toBeGreaterThan(-20.2);
    expect(truePeakDb).toBeLessThan(-19.8);
  });
});

describe('app wiring', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
  const pw = fs.readFileSync(path.join(__dirname, '../public/app/premium-workspace.js'), 'utf8');
  test('header and cards both come from computeStemStats; Output from the export', () => {
    expect(app).toContain("from '/src/core/SessionStats.js'");
    const header = app.slice(app.indexOf('_computeAudioMetricsState() {'), app.indexOf('_resetSessionMetrics() {'));
    expect(header).toContain('_stemStats(');
    expect(header).not.toMatch(/resid \* resid/);
    const cards = app.slice(app.indexOf('async _computeSessionMetricsAsync('), app.indexOf('showNotification(msg'));
    expect(cards).toMatch(/_stemStats(Async)?\(/);
    expect(cards).not.toMatch(/resid \* resid/);
    const dl = app.slice(app.indexOf('async _downloadProcessed()'), app.indexOf('/** @deprecated Use decodeBlobToAudioBuffer'));
    expect(dl).toContain('_publishExportLoudness(');
    expect(pw).toMatch(/exportLufs/);
    expect(pw).toMatch(/dBTP/);
  });
});
