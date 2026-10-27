/**
 * VoiceIsolate Pro — Motion policy (Layer 1: Core)
 *
 * One pure decision for how much interface motion a surface may run, from the
 * Signal Glass motion table (CLAUDE.md, design spec section 4):
 *
 *   hover / press   150 ms            reduced: instant
 *   toggle, segment 200 ms slide      reduced: instant swap
 *   drawer, sheet   300 ms            reduced: 120 ms fade
 *   section reveal  600-1200 ms (900 ms, 60 ms stagger), marketing only
 *   ease            expo-out cubic-bezier(0.16, 1, 0.3, 1); never linear or a
 *                   default keyword. Spring-back (pointer release) uses
 *                   MOTION_SPRING. This replaces the spec's (0.2, 0.7, 0.2, 1)
 *                   at Randy's request for a more premium feel.
 *
 * Two surfaces:
 *   - `marketing`: Landing story sections. Scroll entrances and slow ambient
 *     illustration motion are allowed when the tier can afford them.
 *   - `work`: Quick Clean, the Landing workspace and the Engineer Console.
 *     No camera movement and no always-on ambient motion except the empty-state
 *     illustration on HIGH; state-driven motion (drag-over, processing sweep,
 *     result reveal) only on HIGH and BALANCED. CONSTRAINED work areas run no
 *     animations at all, only instant-feeling state feedback transitions.
 *
 * `prefers-reduced-motion: reduce` beats every tier: no entrances, no ambient
 * or state animations, instant hover/toggle, sheets as a 120 ms fade.
 *
 * Tiers come from `PerformanceTier.js` and never change processed audio; this
 * module only changes pixels.
 */
'use strict';

import { PerformanceTier } from './PerformanceTier.js';

export const MOTION_EASE = 'cubic-bezier(0.16, 1, 0.3, 1)';
/** Quart-out for small state changes (press release, segment slide). */
export const MOTION_EASE_QUART = 'cubic-bezier(0.25, 1, 0.5, 1)';
/** Gentle overshoot used when a magnetic button or tilted card springs back. */
export const MOTION_SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
/** Symmetric in-out for slow loops (breathing rims). */
export const MOTION_EASE_LOOP = 'cubic-bezier(0.37, 0, 0.63, 1)';

/** Spec durations in milliseconds. */
export const MOTION_MS = Object.freeze({
  press: 150,
  toggle: 200,
  sheet: 300,
  sheetReduced: 120,
  reveal: 300,
  /** Landing story sections (600-1200 ms band). */
  revealMarketing: 900,
  stagger: 60,
  /** Longest stagger chain, so a 7-card row never trails for a second. */
  staggerMaxSteps: 6,
});

export const MotionLevel = Object.freeze({
  FULL: 'full',
  CALM: 'calm',
  STILL: 'still',
});

export const MotionSurface = Object.freeze({
  MARKETING: 'marketing',
  WORK: 'work',
});

const TIERS = new Set(Object.values(PerformanceTier));

function normaliseTier(tier) {
  return TIERS.has(tier) ? tier : PerformanceTier.BALANCED;
}

/**
 * @param {object} [input]
 * @param {boolean} [input.reducedMotion]  prefers-reduced-motion: reduce
 * @param {'HIGH'|'BALANCED'|'CONSTRAINED'} [input.tier]
 * @param {boolean} [input.saveData]       treated as CONSTRAINED
 * @param {'marketing'|'work'} [input.surface]
 * @returns {Readonly<{
 *   surface: string, tier: string, reduced: boolean, level: string,
 *   ease: string,
 *   durations: Readonly<{press:number, toggle:number, sheet:number, reveal:number, stagger:number}>,
 *   entrances: boolean, ambient: boolean, stateMotion: boolean,
 *   sheetFadeOnly: boolean, meterGlow: boolean, animations: boolean, pointerEffects: boolean
 * }>}
 */
export function resolveMotionPolicy(input = {}) {
  const surface = input.surface === MotionSurface.WORK ? MotionSurface.WORK : MotionSurface.MARKETING;
  const reduced = input.reducedMotion === true;
  const tier = input.saveData === true ? PerformanceTier.CONSTRAINED : normaliseTier(input.tier);
  const work = surface === MotionSurface.WORK;

  if (reduced) {
    return Object.freeze({
      surface, tier, reduced, level: MotionLevel.STILL, ease: MOTION_EASE,
      durations: Object.freeze({ press: 0, toggle: 0, sheet: MOTION_MS.sheetReduced, reveal: 0, stagger: 0 }),
      entrances: false, ambient: false, stateMotion: false,
      sheetFadeOnly: true, meterGlow: false, animations: false, pointerEffects: false,
    });
  }

  const constrained = tier === PerformanceTier.CONSTRAINED;
  const high = tier === PerformanceTier.HIGH;
  const durations = Object.freeze({
    press: MOTION_MS.press,
    toggle: MOTION_MS.toggle,
    sheet: MOTION_MS.sheet,
    reveal: work ? (constrained ? 0 : MOTION_MS.reveal) : MOTION_MS.revealMarketing,
    stagger: constrained ? 0 : MOTION_MS.stagger,
  });

  if (work) {
    const animations = !constrained;
    return Object.freeze({
      surface, tier, reduced,
      level: constrained ? MotionLevel.STILL : high ? MotionLevel.FULL : MotionLevel.CALM,
      ease: MOTION_EASE, durations,
      entrances: animations,
      // Empty-state illustrations only; never a working view.
      ambient: high,
      stateMotion: animations,
      sheetFadeOnly: constrained,
      meterGlow: high,
      animations,
      // Magnetic buttons and card tilt are Landing-only; never in a working view.
      pointerEffects: false,
    });
  }

  return Object.freeze({
    surface, tier, reduced,
    level: constrained ? MotionLevel.CALM : MotionLevel.FULL,
    ease: MOTION_EASE, durations,
    entrances: true,
    ambient: !constrained,
    stateMotion: !constrained,
    sheetFadeOnly: false,
    meterGlow: high,
    animations: true,
    pointerEffects: !constrained,
  });
}

/** Delay for the nth item of a staggered group (capped). */
export function staggerDelay(index, policy) {
  const step = policy?.durations?.stagger ?? 0;
  const i = Math.max(0, Math.min(MOTION_MS.staggerMaxSteps, Math.floor(Number(index) || 0)));
  return i * step;
}

/** CSS custom properties that publish a policy to stylesheets. */
export function motionCustomProperties(policy) {
  const d = policy.durations;
  return {
    '--vip-motion-press': `${d.press}ms`,
    '--vip-motion-toggle': `${d.toggle}ms`,
    '--vip-motion-sheet': `${d.sheet}ms`,
    '--vip-motion-reveal': `${d.reveal}ms`,
    '--vip-motion-stagger': `${d.stagger}ms`,
    '--vip-motion-ease': policy.ease,
    '--vip-motion-ease-quart': MOTION_EASE_QUART,
    '--vip-motion-spring': MOTION_SPRING,
    '--vip-motion-ease-loop': MOTION_EASE_LOOP,
  };
}

/**
 * Root data attributes. One page can hold both surfaces (Landing has story
 * sections and a workspace), so each surface publishes its own flags.
 */
export function motionDataAttributes(marketing, work) {
  return {
    'data-motion': marketing.level,
    'data-motion-work': work.level,
    'data-motion-tier': marketing.tier,
    'data-motion-ambient': marketing.ambient ? 'on' : 'off',
    'data-motion-work-ambient': work.ambient ? 'on' : 'off',
    'data-motion-work-state': work.stateMotion ? 'on' : 'off',
  };
}
