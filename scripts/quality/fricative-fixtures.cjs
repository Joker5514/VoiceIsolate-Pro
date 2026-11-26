#!/usr/bin/env node
'use strict';
/**
 * DSP-02 fricative-preservation fixture set (LOCAL 2026-11-25).
 *
 * Annotated clean-reference fixtures for measuring fricative destruction
 * separately from overall speech level ("do not let an overall SI-SDR
 * improvement hide consonant destruction").
 *
 * Speech fixtures: VCV tokens — vowel, fricative, vowel, fricative, vowel —
 * with the fricative segment annotated sample-exactly. Eight phoneme
 * classes with distinct spectral shapes (not one generic burst):
 *   /s/ /z/  high-frequency sibilants (bandpass ~6.5 kHz)
 *   /ʃ/ /ʒ/  lower sibilants (bandpass ~3.2 kHz)
 *   /f/ /v/  weak flat broadband (wide bandpass ~3 kHz, low gain)
 *   /θ/ /ð/  weakest flat broadband (low gain)
 * Voiced variants (/z/ /ʒ/ /v/ /ð/) carry low-frequency voicing through
 * the fricative. Levels: quiet (vowel RMS -32 dBFS) and loud (-12 dBFS).
 * Voices: F0 110 / 150 / 210 Hz. Mix: clean + white noise at 5 dB SNR
 * (active-speech RMS), so the mask has noise to remove and the fricative
 * has something to survive.
 *
 * Non-speech controls (the fix must not just protect noise): hiss with
 * the /s/ shape but no vowel context, flat hiss, stationary HF noise
 * (constant 4-8 kHz, no onsets), and a white-noise burst. A guard that
 * protects these is over-protecting and fails the control check.
 *
 * All synthesis is deterministic (seeded PRNG). Clean reference + noisy
 * mix + sample masks are returned per fixture, so SI-SDR, ESTOI, and
 * band-energy metrics all have a ground truth.
 *
 *   node scripts/quality/fricative-fixtures.cjs [--list] [--json <path>]
 */
const fs = require('fs');
const path = require('path');
const S = require('./lib/signals.cjs');

const SR = 48000;
const DUR = 2.4;

/** RBJ constant-0-dB-peak band-pass biquad (same form as signals.cjs). */
function bandpass(f, bw, sr = SR) {
  const w = 2 * Math.PI * f / sr;
  const q = f / bw;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b2: -alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 };
}

function applyBiquad(x, c) {
  const y = new Float32Array(x.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/** Phoneme table: spectral shape + relative fricative level. */
const PHONEMES = {
  s: { label: '/s/', bp: [6500, 3500], gain: 0.50, voiced: false },
  z: { label: '/z/', bp: [6500, 3500], gain: 0.45, voiced: true },
  sh: { label: '/ʃ/', bp: [3200, 2200], gain: 0.55, voiced: false },
  zh: { label: '/ʒ/', bp: [3200, 2200], gain: 0.50, voiced: true },
  f: { label: '/f/', bp: [3000, 5000], gain: 0.20, voiced: false },
  v: { label: '/v/', bp: [3000, 5000], gain: 0.18, voiced: true },
  th: { label: '/θ/', bp: [4200, 5000], gain: 0.13, voiced: false },
  dh: { label: '/ð/', bp: [4200, 5000], gain: 0.12, voiced: true },
};

const VOWEL_A = [730, 1090, 2440];
const VOWEL_I = [270, 2290, 3010];
const FORMANT_BW = [90, 110, 160];
const FORMANT_GAIN = [1, 0.6, 0.35];

/** Harmonic complex (band-limited sawtooth) through 3 formant bandpasses. */
function vowelSegment(n, f0, formants, seed) {
  const rand = S.prng(seed);
  const src = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 * (1 + 0.03 * Math.sin(2 * Math.PI * 3.1 * t));
    phase += f / SR;
    if (phase >= 1) phase -= 1;
    const H = Math.floor(7000 / f);
    let v = 0;
    for (let h = 1; h <= H; h++) v += Math.sin(2 * Math.PI * h * phase) / Math.pow(h, 1.2);
    src[i] = v * 0.35;
  }
  const out = new Float32Array(n);
  formants.forEach((fc, k) => {
    const c = bandpass(fc, FORMANT_BW[k]);
    const y = applyBiquad(src, c);
    for (let i = 0; i < n; i++) out[i] += y[i] * FORMANT_GAIN[k];
  });
  return { signal: out, rand };
}

/** Shaped fricative noise (optionally with low-frequency voicing). */
function fricativeSegment(n, phoneme, f0, seed) {
  const p = PHONEMES[phoneme];
  const rand = S.prng(seed);
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let u = 0;
    while (u === 0) u = rand();
    noise[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }
  const shaped = applyBiquad(noise, bandpass(p.bp[0], p.bp[1]));
  // 10 ms raised-cosine onset/offset ramps (no clicks).
  const ramp = Math.round(0.01 * SR);
  for (let i = 0; i < ramp; i++) {
    const w = 0.5 * (1 - Math.cos(Math.PI * i / ramp));
    shaped[i] *= w;
    shaped[n - 1 - i] *= w;
  }
  if (p.voiced) {
    // Voicing: low-frequency harmonic complex at 0.25x the noise level.
    let phase = 0;
    for (let i = 0; i < n; i++) {
      phase += f0 / SR;
      if (phase >= 1) phase -= 1;
      let v = 0;
      for (let h = 1; h <= 4; h++) v += Math.sin(2 * Math.PI * h * phase) / h;
      shaped[i] += v * 0.09;
    }
  }
  return shaped;
}

function rmsOver(x, from, to) {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
}

/**
 * Build one VCV speech fixture.
 * Timeline (2.4 s): 0.10-0.70 vowel A, 0.70-0.88 fricative, 0.88-1.50 vowel
 * I, 1.50-1.68 fricative, 1.68-2.30 vowel A. Two fricative tokens.
 */
function buildSpeechFixture(phoneme, level, f0, seed) {
  const p = PHONEMES[phoneme];
  const n = Math.round(DUR * SR);
  const clean = new Float32Array(n);
  const fricMask = new Uint8Array(n);
  const speechMask = new Uint8Array(n);
  const segments = [
    { from: 0.10, to: 0.70, kind: 'vowel', formants: VOWEL_A },
    { from: 0.70, to: 0.88, kind: 'fric' },
    { from: 0.88, to: 1.50, kind: 'vowel', formants: VOWEL_I },
    { from: 1.50, to: 1.68, kind: 'fric' },
    { from: 1.68, to: 2.30, kind: 'vowel', formants: VOWEL_A },
  ];
  // Vowel RMS target first (fricative level is relative to it).
  const vowelDb = level === 'loud' ? -12 : -32;
  const vowelTarget = Math.pow(10, vowelDb / 20);
  for (const seg of segments) {
    const from = Math.round(seg.from * SR);
    const to = Math.round(seg.to * SR);
    if (seg.kind === 'vowel') {
      const { signal } = vowelSegment(to - from, f0, seg.formants, seed + from);
      // Scale this vowel segment to the target RMS.
      const r = rmsOver(signal, 0, signal.length);
      const g = r > 0 ? vowelTarget / r : 0;
      for (let i = from; i < to; i++) {
        clean[i] += signal[i - from] * g;
        speechMask[i] = 1;
      }
    } else {
      const shaped = fricativeSegment(to - from, phoneme, f0, seed + from);
      const r = rmsOver(shaped, 0, shaped.length);
      const g = r > 0 ? (vowelTarget * p.gain) / r : 0;
      for (let i = from; i < to; i++) {
        clean[i] += shaped[i - from] * g;
        fricMask[i] = 1;
        speechMask[i] = 1;
      }
    }
  }
  // 5 ms crossfade-free joins are fine: segments abut at zero crossings of
  // the ramps (fricative ramps start/end at 0; vowel onsets are low).
  const { mix } = S.mixAtSnr(clean, S.whiteNoise(n, seed + 999), 5, speechMask);
  return {
    id: `${phoneme}-${level}-f${f0}`,
    phoneme,
    phonemeLabel: p.label,
    level,
    f0,
    kind: 'speech',
    clean,
    mix,
    fricMask,
    speechMask,
    fricSamples: [Math.round(0.70 * SR), Math.round(0.88 * SR)],
  };
}

/** Non-speech controls: same HF energy, no vowel context, no onsets. */
function buildControlFixture(kind, seed) {
  const n = Math.round(DUR * SR);
  const rand = S.prng(seed);
  let clean;
  let band = [3500, 9000];
  if (kind === 'hiss-s') {
    const noise = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let u = 0;
      while (u === 0) u = rand();
      noise[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    }
    clean = applyBiquad(noise, bandpass(6500, 3500));
    // Gate to 0.60 s in the middle (a hiss event, no speech around it).
    const from = Math.round(0.9 * SR);
    const to = Math.round(1.5 * SR);
    const gated = new Float32Array(n);
    for (let i = from; i < to; i++) gated[i] = clean[i];
    clean = gated;
  } else if (kind === 'hiss-flat') {
    clean = S.whiteNoise(n, seed);
    const from = Math.round(0.9 * SR);
    const to = Math.round(1.5 * SR);
    const gated = new Float32Array(n);
    for (let i = from; i < to; i++) gated[i] = clean[i] * 0.3;
    clean = gated;
    band = [1000, 9000];
  } else if (kind === 'hf-stationary') {
    // Constant 4-8 kHz noise for the whole fixture: no onset at all.
    const noise = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let u = 0;
      while (u === 0) u = rand();
      noise[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
    }
    clean = applyBiquad(noise, bandpass(6000, 4000));
    band = [3500, 9000];
  } else { // 'white-burst'
    clean = S.whiteNoise(n, seed);
    const from = Math.round(0.9 * SR);
    const to = Math.round(1.5 * SR);
    const gated = new Float32Array(n);
    for (let i = from; i < to; i++) gated[i] = clean[i] * 0.5;
    clean = gated;
    band = [1000, 12000];
  }
  S.normalizeRms(clean, -20);
  const mask = new Uint8Array(n);
  const from = Math.round(0.9 * SR);
  const to = kind === 'hf-stationary' ? n : Math.round(1.5 * SR);
  for (let i = from; i < to; i++) mask[i] = 1;
  // Controls are measured against their own mix (input): the "clean" is
  // the control signal itself; the mix adds nothing (the control IS the
  // noise to suppress). Attenuation = out vs in on the mask.
  return {
    id: `control-${kind}`,
    phoneme: kind,
    phonemeLabel: kind,
    level: 'control',
    f0: 0,
    kind: 'control',
    clean,
    mix: clean.slice(),
    fricMask: mask,
    speechMask: mask,
    controlBand: band,
    fricSamples: [from, to],
  };
}

function buildFricativeFixtures() {
  const fixtures = [];
  let seed = 4101;
  for (const phoneme of Object.keys(PHONEMES)) {
    for (const level of ['quiet', 'loud']) {
      fixtures.push(buildSpeechFixture(phoneme, level, 150, seed));
      seed += 17;
    }
  }
  // Extra voices on the loud sibilants (the defect stratum).
  for (const phoneme of ['s', 'sh']) {
    for (const f0 of [110, 210]) {
      fixtures.push(buildSpeechFixture(phoneme, 'loud', f0, seed));
      seed += 17;
    }
  }
  for (const kind of ['hiss-s', 'hiss-flat', 'hf-stationary', 'white-burst']) {
    fixtures.push(buildControlFixture(kind, seed));
    seed += 17;
  }
  return fixtures;
}

if (require.main === module) {
  const fixtures = buildFricativeFixtures();
  if (process.argv.includes('--list')) {
    for (const f of fixtures) {
      console.log(`${f.id}  ${f.kind}  ${f.phonemeLabel}  ${f.level}  f0=${f.f0}`);
    }
    console.log(`${fixtures.length} fixtures`);
  }
  const jsonIdx = process.argv.indexOf('--json');
  if (jsonIdx >= 0) {
    const out = {
      generatedAt: new Date().toISOString(),
      sampleRate: SR,
      durationSec: DUR,
      fixtures: fixtures.map((f) => ({
        id: f.id, phoneme: f.phoneme, level: f.level, f0: f.f0, kind: f.kind,
        fricSamples: f.fricSamples,
      })),
    };
    fs.writeFileSync(process.argv[jsonIdx + 1], `${JSON.stringify(out, null, 2)}\n`);
    console.log(`wrote ${process.argv[jsonIdx + 1]} (${fixtures.length} fixtures)`);
  }
}

module.exports = { buildFricativeFixtures, PHONEMES, SR, DUR };
