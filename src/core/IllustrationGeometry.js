/**
 * VoiceIsolate Pro — Illustration geometry (Layer 1: Core)
 *
 * Deterministic path data for the decorative Signal Glass illustrations
 * (layered waveforms, ribbons, ticks). Pure string math: no DOM, no audio,
 * no randomness that differs between runs, so the same markup ships every
 * time and tests can pin it. These shapes are drawings, not measurements.
 */
'use strict';

/** Small seeded PRNG (mulberry32). */
export function seededRandom(seed) {
  let a = (Number(seed) >>> 0) || 1;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n) => Math.round(n * 10) / 10;

/**
 * Envelope shapes for drawn signals.
 *  - speech: bursty syllables with gaps (the voice)
 *  - bed:    steady low texture (the background)
 *  - mix:    both together (the original recording)
 */
export function envelopeAt(kind, t, rand) {
  const syll = Math.max(0, Math.sin(t * Math.PI * 9.5)) ** 1.6;
  const phrase = 0.55 + 0.45 * Math.sin(t * Math.PI * 2.2 + 0.6);
  const speech = syll * phrase;
  const bed = 0.32 + 0.12 * Math.sin(t * Math.PI * 23) + 0.1 * rand();
  if (kind === 'speech') return Math.min(1, speech * 1.05);
  if (kind === 'bed') return Math.min(1, bed);
  return Math.min(1, 0.72 * speech + 0.48 * bed);
}

/**
 * Mirrored bar waveform as one path ("M x y1 V y2" per bar).
 * @param {object} o
 * @param {number} o.x @param {number} o.y  centre line start
 * @param {number} o.width @param {number} o.height  full height
 * @param {number} [o.bars] @param {'speech'|'bed'|'mix'} [o.kind] @param {number} [o.seed]
 */
export function barWavePath({ x, y, width, height, bars = 64, kind = 'mix', seed = 1 }) {
  const rand = seededRandom(seed);
  const step = width / Math.max(1, bars - 1);
  const parts = [];
  for (let i = 0; i < bars; i++) {
    const t = i / Math.max(1, bars - 1);
    const amp = Math.max(0.04, envelopeAt(kind, t, rand) * (0.75 + 0.25 * rand()));
    const h = (height / 2) * amp;
    const px = r1(x + i * step);
    parts.push(`M${px} ${r1(y - h)}V${r1(y + h)}`);
  }
  return parts.join('');
}

/**
 * Smooth filled envelope (upper and mirrored lower edge) as one closed path.
 */
export function envelopePath({ x, y, width, height, points = 48, kind = 'mix', seed = 1 }) {
  const rand = seededRandom(seed);
  const top = [];
  const bottom = [];
  for (let i = 0; i < points; i++) {
    const t = i / Math.max(1, points - 1);
    const amp = Math.max(0.03, envelopeAt(kind, t, rand));
    const h = (height / 2) * amp;
    const px = r1(x + t * width);
    top.push(`${px} ${r1(y - h)}`);
    bottom.push(`${px} ${r1(y + h)}`);
  }
  return `M${top.join('L')}L${bottom.reverse().join('L')}Z`;
}

/**
 * A ribbon centre line: cubic from (x0,y0) to (x1,y1) with a gentle S.
 */
export function ribbonPath(x0, y0, x1, y1, bend = 0.45) {
  const dx = x1 - x0;
  return `M${r1(x0)} ${r1(y0)}C${r1(x0 + dx * bend)} ${r1(y0)} ${r1(x1 - dx * bend)} ${r1(y1)} ${r1(x1)} ${r1(y1)}`;
}

/**
 * Oscillating strand along a straight run, for helix and texture lines.
 */
export function strandPath({ x, y, width, amplitude, cycles = 3, phase = 0, points = 40 }) {
  const out = [];
  for (let i = 0; i < points; i++) {
    const t = i / Math.max(1, points - 1);
    const px = x + t * width;
    const py = y + Math.sin(t * Math.PI * 2 * cycles + phase) * amplitude;
    out.push(`${i ? 'L' : 'M'}${r1(px)} ${r1(py)}`);
  }
  return out.join('');
}

/** Evenly spaced tick marks along x as one path. */
export function tickPath({ x, y, width, count, major = 4, minorH = 3, majorH = 7 }) {
  const parts = [];
  for (let i = 0; i < count; i++) {
    const px = r1(x + (width * i) / Math.max(1, count - 1));
    const h = i % major === 0 ? majorH : minorH;
    parts.push(`M${px} ${r1(y)}V${r1(y + h)}`);
  }
  return parts.join('');
}
