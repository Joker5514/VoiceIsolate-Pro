/**
 * VoiceIsolate Pro — Landing hero sculpture geometry (Layer 1: Core)
 *
 * One source for the Signal Glass L2 sculpture on the 1920 x 1200 frame, shared
 * by the SVG still (scripts/generate-hero-sculpture.mjs) and the WebGL render
 * (src/presentation/HeroSculpture3D.js), so the still, the 3D picture and the
 * HTML tags always agree. Pure: no DOM, no Web Audio, no I/O.
 *
 * The mixed recording enters at (0, 930) as a cyan + gold double helix, passes
 * the glass lens (x 990-1240) and exits right as two single ribbons: Clean
 * Voice at y 300 and Background at y 690.
 */
'use strict';

export const FRAME = Object.freeze({ width: 1920, height: 1200 });
export const SCULPTURE_COLORS = Object.freeze({ voice: '#22d3ee', bgst: '#f5b942', ref: '#c3cbd5', instrument: '#e8eef5' });
export const LENS = Object.freeze({ cx: 1115, cy: 510, rx: 100, ry: 205, rot: 16 });
export const HUB = Object.freeze([LENS.cx, LENS.cy]);
export const HELIX_TURNS = 6.5;

const HELIX_CTRL = [[-40, 935], [620, 990], [930, 800], HUB];
const VOICE_CTRL = [HUB, [1330, 470], [1610, 300], [1990, 296]];
const BG_CTRL = [HUB, [1330, 560], [1610, 690], [1990, 692]];

export function cubic(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/** Sample a cubic into n + 1 points with unit normals, arc-length fraction `s` and parameter `t`. */
export function sampleCurve(p0, p1, p2, p3, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) pts.push(cubic(p0, p1, p2, p3, i / n));
  let len = 0;
  const acc = [0];
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    acc.push(len);
  }
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], m = Math.hypot(dx, dy) || 1;
    return { p, n: [-dy / m, dx / m], s: acc[i] / len, t: i / n, len };
  });
}

export const smooth = (e0, e1, x) => { const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return k * k * (3 - 2 * k); };
export const offset = (c, d) => [c.p[0] + c.n[0] * d, c.p[1] + c.n[1] * d];

export const helixSamples = (n = 150) => sampleCurve(...HELIX_CTRL, n);
export const voiceSamples = (n = 64) => sampleCurve(...VOICE_CTRL, n);
export const bgSamples = (n = 64) => sampleCurve(...BG_CTRL, n);

/** Helix radius: full at entry, converging to zero inside the lens. */
export const helixAmp = (c) => 46 * (1 - smooth(0.8, 1, c.t)) * (1 - 0.3 * c.t);
export const voiceHalfWidth = (c) => (1.5 + 15 * Math.pow(c.t, 0.85)) * (0.4 + 0.6 * Math.abs(Math.cos(Math.PI * (1.15 * c.t + 0.18))));
export const bgHalfWidth = (c) => 1.5 + 13 * Math.pow(c.t, 0.85);

/**
 * One strand of the braid. sign +1 is cyan (continues as Clean Voice), -1 gold.
 * `xy` is the frame position, `z` the depth toward the viewer in frame px,
 * `depth` its normalised sign (front when > 0).
 */
export function helixStrand(sign, samples = helixSamples()) {
  return samples.map((c) => {
    const phi = 2 * Math.PI * HELIX_TURNS * c.s;
    const a = helixAmp(c);
    return { xy: offset(c, sign * a * Math.sin(phi)), z: sign * a * Math.cos(phi), depth: sign * Math.cos(phi), t: c.t, s: c.s };
  });
}

export const nearestX = (samples, x) => samples.reduce((best, c) => (Math.abs(c.p[0] - x) < Math.abs(best.p[0] - x) ? c : best));

/** Tags: `x`/`y` are the spec's text anchors; `target` is the ribbon point the leader meets. */
export function sculptureTags() {
  return [
    { id: 'ref', label: 'Original', x: 288, y: 792, target: nearestX(helixSamples(), 360).p, from: [330, 834] },
    { id: 'voice', label: 'Clean Voice', x: 1464, y: 196, target: nearestX(voiceSamples(), 1540).p, from: [1540, 236] },
    { id: 'bg', label: 'Background', x: 1276, y: 700, target: nearestX(bgSamples(), 1330).p, from: [1330, 700] },
  ];
}

/** mulberry32: deterministic particles for the still and the 3D dust. */
export function seededRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * CSS cubic-bezier(x1, y1, x2, y2) as a function of progress 0..1 (Newton +
 * bisection on x). The Signal Glass ease is cubic-bezier(0.2, 0.7, 0.2, 1).
 */
export function cubicBezier(x1, y1, x2, y2) {
  const bx = (t) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  const dx = (t) => 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
  return (x) => {
    if (!(x > 0)) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 6; i++) {
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= (bx(t) - x) / d;
    }
    if (!(t >= 0 && t <= 1) || Math.abs(bx(t) - x) > 1e-5) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 40; i++) { t = (lo + hi) / 2; if (bx(t) < x) lo = t; else hi = t; }
    }
    return by(t);
  };
}
export const signalGlassEase = cubicBezier(0.2, 0.7, 0.2, 1);
