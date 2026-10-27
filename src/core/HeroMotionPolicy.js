/**
 * VoiceIsolate Pro — Landing hero motion policy (Layer 1: Core)
 *
 * Decides how the decorative Landing hero sculpture may move. Pure: no DOM,
 * no Web Audio, importable in Node and workers. Visual only; it never changes
 * processed audio and nothing here reaches the audio graph.
 *
 * Opt-outs mirror the Engineer shell's hero video gate
 * (`public/app/app.js#shouldLoadHeroVideo`, CLAUDE.md §1.3.1): reduced motion,
 * Save-Data, 2G / slow-2G and offline all get the prerendered still. Tiers
 * follow the Signal Glass visual budget on `PerformanceTier`:
 *   HIGH        drift at display rate, bloom
 *   BALANCED    drift capped at 30 fps, no bloom, no backdrop blur
 *   CONSTRAINED static still
 */
'use strict';

import { PerformanceTier } from './PerformanceTier.js';

/** Signal Glass §4 "Landing hero": 12 s drift, 2 px max; particles 6 px parallax. */
export const HERO_DRIFT = Object.freeze({
  periodMs: 12000,
  bodyPx: 2,
  dustPx: 6,
  balancedFps: 30,
});

/**
 * @param {object} [s]
 * @param {boolean} [s.reducedMotion]  prefers-reduced-motion: reduce
 * @param {boolean} [s.saveData]       navigator.connection.saveData
 * @param {string}  [s.effectiveType]  navigator.connection.effectiveType
 * @param {boolean} [s.onLine]         navigator.onLine (false = offline)
 * @param {string}  [s.tier]           PerformanceTier value
 * @returns {{ motion: 'drift'|'still', fps: number, bloom: boolean, reason: string }}
 *   `fps` 0 means "display rate"; it is only meaningful when motion is 'drift'.
 */
export function selectHeroMotion(s = {}) {
  const tier = Object.values(PerformanceTier).includes(s.tier) ? s.tier : PerformanceTier.HIGH;
  const bloom = tier === PerformanceTier.HIGH;
  const still = (reason) => ({ motion: 'still', fps: 0, bloom, reason });
  if (s.reducedMotion === true) return still('reduced-motion');
  if (s.saveData === true) return still('save-data');
  if (typeof s.effectiveType === 'string' && /^(slow-)?2g$/.test(s.effectiveType)) return still('2g');
  if (s.onLine === false) return still('offline');
  if (tier === PerformanceTier.CONSTRAINED) return still('constrained-tier');
  if (tier === PerformanceTier.BALANCED) {
    return { motion: 'drift', fps: HERO_DRIFT.balancedFps, bloom, reason: 'balanced-tier' };
  }
  return { motion: 'drift', fps: 0, bloom, reason: 'high-tier' };
}

/**
 * Unit drift at time `ms`: a slow 12 s Lissajous whose length never exceeds 1,
 * so `bodyPx` / `dustPx` are hard maxima. Starts at the origin.
 * @param {number} ms
 * @returns {{ x: number, y: number }}
 */
export function heroDriftOffset(ms) {
  const theta = (2 * Math.PI * (Number(ms) || 0)) / HERO_DRIFT.periodMs;
  return { x: 0.9 * Math.sin(theta), y: 0.42 * Math.sin(2 * theta) };
}

/**
 * Render budget for the WebGL hero. Only a 'drift' policy may render in 3D;
 * every still keeps the SVG and never downloads Three.js.
 *   HIGH      DPR <= 1.75, ~4.2 MP backbuffer, bloom glow, full dust
 *   BALANCED  DPR <= 1.25, ~2.2 MP, no glow, 30 fps
 *   narrow    (band layout, < 901 px) lower dust count and DPR <= 1.25
 * @param {{ motion: string, fps: number, bloom: boolean }} policy  selectHeroMotion() result
 * @param {object} [s]
 * @param {boolean} [s.webgl2]        a WebGL2 context can be created
 * @param {number}  [s.viewportWidth] CSS px
 * @returns {{ renderer: '3d'|'svg', dprCap: number, maxPixels: number, particles: number, glow: boolean, fps: number, reason: string }}
 */
export function selectHeroRenderer(policy, s = {}) {
  const svg = (reason) => ({ renderer: 'svg', dprCap: 1, maxPixels: 0, particles: 0, glow: false, fps: policy?.fps || 0, reason });
  if (!policy || policy.motion !== 'drift') return svg('still');
  if (s.webgl2 !== true) return svg('no-webgl2');
  // Software rasterisers (SwiftShader, llvmpipe, WARP) run WebGL on the CPU and
  // starve the page's main thread; the SVG drift is the smoother experience there.
  if (s.software === true) return svg('software-gl');
  const narrow = Number(s.viewportWidth) > 0 && s.viewportWidth < 901;
  const high = policy.bloom === true;
  return {
    renderer: '3d',
    dprCap: high && !narrow ? 1.75 : 1.25,
    maxPixels: high && !narrow ? 4.2e6 : 2.2e6,
    particles: narrow ? 220 : high ? 900 : 480,
    glow: high,
    fps: policy.fps,
    reason: narrow ? 'narrow' : high ? 'high' : 'balanced',
  };
}

/** Device pixel ratio for a backbuffer of `w` x `h` CSS px under a renderer budget. */
export function heroPixelRatio(budget, w, h, devicePixelRatio = 1) {
  const dpr = Math.min(Number(devicePixelRatio) || 1, budget.dprCap || 1);
  const area = Math.max(1, w * h);
  const fit = Math.sqrt((budget.maxPixels || area) / area);
  return Math.max(0.5, Math.min(dpr, fit));
}

/** Entrance timing (Signal Glass ease, cubic-bezier(0.2, 0.7, 0.2, 1)). */
export const HERO_ENTRANCE = Object.freeze({ durationMs: 1400, crossfadeMs: 600 });
