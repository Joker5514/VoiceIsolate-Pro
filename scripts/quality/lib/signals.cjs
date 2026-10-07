'use strict';
/**
 * Deterministic, license-free synthetic fixtures with known ground truth.
 *
 * These are speech-*like* proxies (source-filter synthesis), not recorded
 * speech. They pin regressions in the shipped DSP/ML path; they do not
 * replace listening tests or a recorded-speech corpus.
 */
const SR = 48000;

function prng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function gaussian(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/** RBJ constant-0-dB-peak band-pass biquad coefficients. */
function bandpass(f, bw, sr = SR) {
  const w = 2 * Math.PI * f / sr;
  const q = f / bw;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  return { b0: alpha / a0, b2: -alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 };
}

const VOWELS = [
  [730, 1090, 2440], // a
  [270, 2290, 3010], // i
  [300, 870, 2240], // u
  [530, 1840, 2480], // e
  [570, 840, 2410], // o
];
const FORMANT_BW = [90, 110, 160];
const FORMANT_GAIN = [1, 0.6, 0.35];

/**
 * Syllable plan shared by voiced and whispered synthesis so a fixture's
 * activity map is known exactly.
 */
function syllablePlan(seconds, seed) {
  const rand = prng(seed);
  const plan = [];
  let t = 0.15;
  while (t < seconds - 0.3) {
    const words = 2 + Math.floor(rand() * 3);
    for (let w = 0; w < words && t < seconds - 0.3; w++) {
      const dur = 0.17 + rand() * 0.1;
      plan.push({
        start: t,
        dur,
        vowel: Math.floor(rand() * VOWELS.length),
        fricative: rand() < 0.45,
        level: 0.7 + rand() * 0.3,
      });
      t += dur + 0.02;
    }
    t += 0.15 + rand() * 0.2;
  }
  return plan;
}

function envelopeAt(plan, i) {
  const t = i / SR;
  for (const s of plan) {
    if (t >= s.start && t < s.start + s.dur) {
      const x = (t - s.start) / s.dur;
      return { syl: s, env: Math.sin(Math.PI * x) ** 0.6 * s.level, x };
    }
  }
  return null;
}

/**
 * Voiced (or whispered) synthetic talker.
 * @param {{ seconds:number, seed?:number, f0?:number, whisper?:boolean, formantScale?:number }} o
 * @returns {{ signal: Float32Array, active: Uint8Array, fricative: Uint8Array }}
 */
function talker({ seconds, seed = 1, f0 = 125, whisper = false, formantScale = 1 }) {
  const n = Math.round(seconds * SR);
  const plan = syllablePlan(seconds, seed);
  const rand = prng(seed * 7919 + 13);
  const out = new Float32Array(n);
  const active = new Uint8Array(n);
  const fric = new Uint8Array(n);
  const state = FORMANT_BW.map(() => ({ x1: 0, x2: 0, y1: 0, y2: 0 }));
  const fs = { x1: 0, x2: 0, y1: 0, y2: 0 };
  const fricCoef = bandpass(6000, 4000);
  let phase = 0;
  let curVowel = -1;
  let coefs = null;
  for (let i = 0; i < n; i++) {
    const e = envelopeAt(plan, i);
    let src = 0;
    let fr = 0;
    if (e) {
      active[i] = 1;
      if (e.syl.vowel !== curVowel) {
        curVowel = e.syl.vowel;
        coefs = VOWELS[curVowel].map((f, k) => bandpass(f * formantScale, FORMANT_BW[k]));
      }
      const t = i / SR;
      if (whisper) {
        src = gaussian(rand) * 0.5;
      } else {
        const f = f0 * (1 + 0.08 * Math.sin(2 * Math.PI * 0.7 * t) + 0.03 * Math.sin(2 * Math.PI * 3.1 * t));
        phase += f / SR;
        if (phase >= 1) phase -= 1;
        // Band-limited sawtooth: harmonics to 7 kHz, glottal-ish -1.2 slope.
        const H = Math.floor(7000 / f);
        for (let h = 1; h <= H; h++) src += Math.sin(2 * Math.PI * h * phase) / Math.pow(h, 1.2);
        src *= 0.35;
      }
      // Fricative onset (first 35% of the syllable), broadband 4–8 kHz.
      if (e.syl.fricative && e.x < 0.35) {
        fr = gaussian(rand) * 0.22 * Math.sin(Math.PI * (e.x / 0.35));
        fric[i] = 1;
      }
    }
    let y = 0;
    if (coefs) {
      for (let k = 0; k < coefs.length; k++) {
        const c = coefs[k];
        const s = state[k];
        const v = c.b0 * src + c.b2 * s.x2 - c.a1 * s.y1 - c.a2 * s.y2;
        s.x2 = s.x1; s.x1 = src; s.y2 = s.y1; s.y1 = v;
        y += v * FORMANT_GAIN[k];
      }
    }
    const fv = fricCoef.b0 * fr + fricCoef.b2 * fs.x2 - fricCoef.a1 * fs.y1 - fricCoef.a2 * fs.y2;
    fs.x2 = fs.x1; fs.x1 = fr; fs.y2 = fs.y1; fs.y1 = fv;
    out[i] = (e ? e.env : 0) * y * (whisper ? 2.2 : 1) + fv;
  }
  return { signal: normalizeRms(out, whisper ? -32 : -20, active), active, fricative: fric };
}

function rms(x, mask) {
  let s = 0; let c = 0;
  for (let i = 0; i < x.length; i++) if (!mask || mask[i]) { s += x[i] * x[i]; c++; }
  return Math.sqrt(s / Math.max(1, c));
}

/** Scale so the RMS over `mask` (or whole signal) equals `db` dBFS. */
function normalizeRms(x, db, mask) {
  const r = rms(x, mask);
  const g = r > 0 ? Math.pow(10, db / 20) / r : 0;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

function whiteNoise(n, seed) {
  const rand = prng(seed);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = gaussian(rand);
  return x;
}

/** Fan/HVAC: low-passed brown noise + broadband hiss + weak 120 Hz motor tone. */
function hvac(n, seed) {
  const rand = prng(seed);
  const x = new Float32Array(n);
  let b = 0; let lp = 0;
  for (let i = 0; i < n; i++) {
    const g = gaussian(rand);
    b = 0.995 * b + g * 0.1;
    lp = 0.9 * lp + 0.1 * g;
    x[i] = b + 0.6 * lp + 0.08 * g + 0.05 * Math.sin(2 * Math.PI * 120 * i / SR);
  }
  return x;
}

function hum(n, f = 60) {
  const x = new Float32Array(n);
  const amps = [1, 0.5, 0.35, 0.2, 0.12];
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 0; h < amps.length; h++) v += amps[h] * Math.sin(2 * Math.PI * f * (h + 1) * i / SR);
    x[i] = v;
  }
  return x;
}

/** Instrumental bed: sustained sawtooth triads that change every 0.5 s. */
function music(n, seed) {
  const rand = prng(seed);
  const x = new Float32Array(n);
  const roots = [110, 130.81, 146.83, 164.81, 98];
  const seg = Math.round(0.5 * SR);
  for (let s0 = 0; s0 < n; s0 += seg) {
    const r = roots[Math.floor(rand() * roots.length)];
    const notes = [r, r * 1.26, r * 1.5, r * 2];
    for (let i = s0; i < Math.min(n, s0 + seg); i++) {
      const t = i / SR;
      let v = 0;
      for (const f of notes) {
        const H = Math.floor(5000 / f);
        for (let h = 1; h <= H; h += 1) v += Math.sin(2 * Math.PI * f * h * t) / h;
      }
      const local = (i - s0) / seg;
      x[i] = v * (0.6 + 0.4 * Math.exp(-6 * local));
    }
  }
  return x;
}

/** Exponential-decay noise impulse response, RT60 in seconds. */
function roomIr(rt60, seed) {
  const n = Math.round(rt60 * 1.2 * SR);
  const rand = prng(seed);
  const ir = new Float32Array(n);
  ir[0] = 1;
  const k = 6.907755 / (rt60 * SR);
  for (let i = Math.round(0.004 * SR); i < n; i++) ir[i] = gaussian(rand) * Math.exp(-k * i) * 0.12;
  return ir;
}

/** Direct convolution restricted to the IR support (fixtures are short). */
function convolve(x, h) {
  const y = new Float32Array(x.length);
  const taps = [];
  for (let j = 0; j < h.length; j++) if (Math.abs(h[j]) > 1e-5) taps.push(j);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    for (const j of taps) {
      if (i + j >= y.length) break;
      y[i + j] += xi * h[j];
    }
  }
  return y;
}

/** Scale `noise` to the requested SNR relative to `speech` (active-speech RMS). */
function mixAtSnr(speech, noise, snrDb, active) {
  const ps = rms(speech, active);
  const pn = rms(noise);
  const g = pn > 0 ? ps / pn / Math.pow(10, snrDb / 20) : 0;
  const mix = new Float32Array(speech.length);
  const scaled = new Float32Array(speech.length);
  for (let i = 0; i < mix.length; i++) {
    scaled[i] = noise[i] * g;
    mix[i] = speech[i] + scaled[i];
  }
  return { mix, noise: scaled };
}

module.exports = {
  SR, prng, talker, whiteNoise, hvac, hum, music, roomIr, convolve, mixAtSnr, normalizeRms, rms,
};
