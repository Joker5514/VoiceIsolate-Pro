/**
 * MET-01 — ESTOI/STOI validation (scripts/quality/lib/metrics.cjs).
 *
 * Reference comparison: the JS scores must match the pinned pystoi
 * 0.4.1 outputs in scripts/quality/fixtures/estoi/manifest.json to
 * <= 1e-4 (the same check `node scripts/quality/estoi-reference.cjs`
 * performs standalone). The silence fixture is exempt from that
 * comparison because pystoi itself is non-deterministic there (see the
 * manifest / metrics.cjs); the JS behaviour on silence is asserted
 * separately as deterministic 0.
 *
 * Self-consistency cases use the pinned fixtures plus small signals
 * generated here with a seeded PRNG, so the suite needs no oracle.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const M = require('../scripts/quality/lib/metrics.cjs');

const DIR = path.join(__dirname, '..', 'scripts', 'quality', 'fixtures', 'estoi');
const TOLERANCE = 1e-4;

function readF64(file) {
  const buf = fs.readFileSync(path.join(DIR, file));
  const out = new Float64Array(buf.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = buf.readDoubleLE(i * 8);
  return out;
}

const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const fixtures = {};
for (const fx of manifest.fixtures) {
  fixtures[fx.name] = { ...fx, ref: readF64(fx.refFile), deg: readF64(fx.degFile) };
}

/** Deterministic PRNG (mulberry32) for locally generated signals. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Short speech-like signal (harmonic complex, syllabic envelope), 1.2 s. */
function localSpeech(fs, seed = 42) {
  const rand = rng(seed);
  const n = Math.floor(fs * 1.2);
  const x = new Float64Array(n);
  const f0 = 120;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    phase += (2 * Math.PI * f0) / fs;
    const env = 0.6 + 0.4 * Math.sin((2 * Math.PI * 3 * i) / fs);
    let s = 0;
    for (let k = 1; k <= 6; k++) s += Math.sin(k * phase) / k;
    x[i] = s * env * 0.3;
  }
  // Deterministic noise overlay via a second PRNG pass.
  const rand2 = rng(seed + 1);
  for (let i = 0; i < n; i++) x[i] += (rand2() - 0.5) * 0.02;
  const peak = Math.max(...x.map(Math.abs));
  for (let i = 0; i < n; i++) x[i] = (x[i] / peak) * 0.8;
  return x;
}

function addNoiseAtSnr(x, snrDb, seed = 7) {
  const rand = rng(seed);
  const noise = new Float64Array(x.length);
  let xn = 0; let nn = 0;
  for (let i = 0; i < x.length; i++) { noise[i] = rand() * 2 - 1; xn += x[i] * x[i]; nn += noise[i] * noise[i]; }
  const scale = Math.sqrt(xn / nn) * Math.pow(10, -snrDb / 20);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + noise[i] * scale;
  return out;
}

describe('ESTOI/STOI reference comparison (pystoi 0.4.1 fixtures)', () => {
  test('manifest is the pinned oracle (pystoi 0.4.1)', () => {
    expect(manifest.pystoi).toBe('0.4.1');
    expect(manifest.fixtures.length).toBeGreaterThanOrEqual(10);
  });

  for (const fx of manifest.fixtures) {
    test(`${fx.name}: |JS - reference| <= 1e-4 (stoi + estoi)`, () => {
      const { ref, deg, sampleRate } = fixtures[fx.name];
      const jsStoi = M.stoi(ref, deg, sampleRate);
      const jsEstoi = M.estoi(ref, deg, sampleRate);
      expect(Number.isFinite(jsStoi)).toBe(true);
      expect(Number.isFinite(jsEstoi)).toBe(true);
      expect(jsStoi).toBeGreaterThanOrEqual(0);
      expect(jsStoi).toBeLessThanOrEqual(1);
      expect(jsEstoi).toBeGreaterThanOrEqual(0);
      expect(jsEstoi).toBeLessThanOrEqual(1);
      if (fx.toleranceExempt) {
        // Silence: pystoi is non-deterministic here; JS must be
        // deterministic 0 instead (the zero-noise limit).
        expect(jsStoi).toBe(0);
        expect(jsEstoi).toBe(0);
        return;
      }
      expect(Math.abs(jsStoi - fx.stoi)).toBeLessThanOrEqual(TOLERANCE);
      expect(Math.abs(jsEstoi - fx.estoi)).toBeLessThanOrEqual(TOLERANCE);
    });
  }
});

describe('ESTOI validation cases', () => {
  test('identical clean speech scores 1 (stoi and estoi, all rates)', () => {
    for (const name of ['identical-10k', 'identical-16k', 'identical-48k']) {
      const { ref, deg, sampleRate } = fixtures[name];
      // 1 - 1e-12, not exactly 1: the STOI correlation accumulation can
      // land 1-2 ulp off 1.0 depending on summation order (pystoi lands
      // exactly on 1.0 for these fixtures; JS lands 2.2e-15 below on
      // identical-16k). That is float noise, far below the 1e-4
      // reference tolerance — investigated, not a loosened tolerance.
      expect(M.estoi(ref, deg, sampleRate)).toBeGreaterThan(1 - 1e-12);
      expect(M.stoi(ref, deg, sampleRate)).toBeGreaterThan(1 - 1e-12);
    }
  });

  test('monotonicity: mild noise > severe noise; distortion and shift below clean', () => {
    const clean = M.estoi(fixtures['identical-10k'].ref, fixtures['identical-10k'].deg, 10000);
    const mild = M.estoi(fixtures['mild-noise-10k'].ref, fixtures['mild-noise-10k'].deg, 10000);
    const severe = M.estoi(fixtures['severe-noise-10k'].ref, fixtures['severe-noise-10k'].deg, 10000);
    const clipped = M.estoi(fixtures['clipped-10k'].ref, fixtures['clipped-10k'].deg, 10000);
    const shifted = M.estoi(fixtures['shifted-10k'].ref, fixtures['shifted-10k'].deg, 10000);
    expect(clean).toBeGreaterThan(1 - 1e-12);
    expect(mild).toBeLessThan(clean);
    expect(severe).toBeLessThan(mild);
    expect(clipped).toBeLessThan(clean);
    expect(shifted).toBeLessThan(clean);
    // Same ordering for ordinary STOI.
    const mildS = M.stoi(fixtures['mild-noise-10k'].ref, fixtures['mild-noise-10k'].deg, 10000);
    const severeS = M.stoi(fixtures['severe-noise-10k'].ref, fixtures['severe-noise-10k'].deg, 10000);
    expect(severeS).toBeLessThan(mildS);
  });

  test('a level-matched noisy signal still scores lower: degradation is not normalised away', () => {
    // Fixture pair (realistic speech-like signal, +10 dB SNR): rescale
    // the degraded signal to the clean RMS and re-score. A global gain
    // change alone scores 1 (see below), so if the score stays low the
    // degradation itself — not the level — is what ESTOI measures.
    const { ref, deg, sampleRate } = fixtures['mild-noise-10k'];
    let rn = 0; let dn = 0;
    for (let i = 0; i < ref.length; i++) { rn += ref[i] * ref[i]; dn += deg[i] * deg[i]; }
    const g = Math.sqrt(rn / dn);
    const rescaled = Float64Array.from(deg, (v) => v * g);
    const score = M.estoi(ref, rescaled, sampleRate);
    expect(score).toBeLessThan(0.99);
    expect(score).toBeGreaterThan(0.8); // unrescaled reference is 0.913
  });

  test('deterministic: repeated calls on the same input agree exactly', () => {
    const { ref, deg, sampleRate } = fixtures['mild-noise-48k'];
    expect(M.estoi(ref, deg, sampleRate)).toBe(M.estoi(ref, deg, sampleRate));
    expect(M.stoi(ref, deg, sampleRate)).toBe(M.stoi(ref, deg, sampleRate));
  });

  test('silence is deterministic 0 (stoi and estoi), not NaN', () => {
    const z = new Float64Array(12000);
    expect(M.estoi(z, z, 10000)).toBe(0);
    expect(M.stoi(z, z, 10000)).toBe(0);
    expect(M.estoi(z, z, 10000)).toBe(M.estoi(z, z, 10000));
  });

  test('near-silence identical signals score near 1', () => {
    const x = localSpeech(10000);
    const tiny = Float64Array.from(x, (v) => v * 1e-6);
    expect(M.estoi(tiny, tiny, 10000)).toBeGreaterThan(0.99);
  });

  test('pure gain change does not change the score (algorithm property, documented)', () => {
    const x = localSpeech(10000);
    const half = Float64Array.from(x, (v) => v * 0.5);
    expect(M.estoi(x, half, 10000)).toBeGreaterThan(0.999999);
  });
});

describe('ESTOI/STOI input validation', () => {
  const x = localSpeech(10000);
  const y = addNoiseAtSnr(x, 10);

  test('empty input throws', () => {
    expect(() => M.estoi(new Float64Array(0), new Float64Array(0), 10000)).toThrow(/empty input/);
    expect(() => M.stoi(new Float64Array(0), new Float64Array(0), 10000)).toThrow(/empty input/);
  });

  test('mismatched lengths throw (no silent alignment search)', () => {
    expect(() => M.estoi(x, x.slice(0, x.length - 10), 10000)).toThrow(/same length/);
  });

  test('non-finite samples throw', () => {
    const bad = Float64Array.from(x);
    bad[100] = NaN;
    expect(() => M.estoi(bad, y, 10000)).toThrow(/non-finite/);
    const badInf = Float64Array.from(y);
    badInf[200] = Infinity;
    expect(() => M.estoi(x, badInf, 10000)).toThrow(/non-finite/);
  });

  test('invalid sample rate throws', () => {
    for (const sr of [0, -16000, NaN, Infinity, 44100.5, '16000']) {
      expect(() => M.estoi(x, y, sr)).toThrow(/sampleRate/);
    }
  });

  test('too-short input throws a documented error, not NaN', () => {
    const short = x.slice(0, 100);
    expect(() => M.estoi(short, short, 10000)).toThrow(/too short/);
    const medium = x.slice(0, 3000); // long enough to frame, too short for 30 segments
    expect(() => M.estoi(medium, medium, 10000)).toThrow(/too short/);
  });

  test('compareAudio returns { siSdr, stoi, estoi } consistent with the parts', () => {
    const out = M.compareAudio(x, y, 10000);
    expect(Object.keys(out).sort()).toEqual(['estoi', 'siSdr', 'stoi']);
    expect(out.stoi).toBe(M.stoi(x, y, 10000));
    expect(out.estoi).toBe(M.estoi(x, y, 10000));
    expect(out.siSdr).toBe(M.siSdr(y, x));
    const identical = M.compareAudio(x, x, 10000);
    expect(identical.stoi).toBeGreaterThan(1 - 1e-12);
    expect(identical.estoi).toBeGreaterThan(1 - 1e-12);
    expect(identical.siSdr).toBeGreaterThan(100);
  });
});
