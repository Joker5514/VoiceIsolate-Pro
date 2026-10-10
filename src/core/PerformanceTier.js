/**
 * VoiceIsolate Pro — Performance tier (Layer 1: Core)
 *
 * One place that decides how much main-thread memory and visual work a device
 * can afford. Tiers trade cache size and visualization fidelity first; they
 * never change processed audio (the ML/DSP output is identical on every tier).
 *
 * `selectPerformanceTier` is pure. `readDeviceSignals` only reads guarded
 * globals so the module stays importable in Node and workers.
 */
'use strict';

export const PerformanceTier = Object.freeze({
  HIGH: 'HIGH',
  BALANCED: 'BALANCED',
  CONSTRAINED: 'CONSTRAINED',
});

const MB = 1024 * 1024;

/**
 * Per-tier budgets. `stemCacheBytes` caps the in-memory MLStemCache: each
 * entry is a full-length clean + noise copy (230 MB for 5 min of 48 kHz
 * stereo), and a mobile tab is killed well before a desktop one.
 */
export const TIER_BUDGETS = Object.freeze({
  HIGH: Object.freeze({ stemCacheBytes: Infinity }),
  BALANCED: Object.freeze({ stemCacheBytes: 384 * MB }),
  CONSTRAINED: Object.freeze({ stemCacheBytes: 160 * MB }),
});

/**
 * @param {object} [s]
 * @param {number} [s.deviceMemory]        GiB (Chromium only; undefined elsewhere)
 * @param {number} [s.hardwareConcurrency] logical cores
 * @param {boolean} [s.coarsePointer]      primary pointer is touch
 * @param {number} [s.viewportWidth]       CSS px
 * @param {boolean} [s.saveData]           user asked for reduced data
 * @returns {'HIGH'|'BALANCED'|'CONSTRAINED'}
 */
export function selectPerformanceTier(s = {}) {
  const mem = Number(s.deviceMemory);
  const cores = Number(s.hardwareConcurrency);
  if ((mem > 0 && mem <= 2) || (cores > 0 && cores <= 2) || s.saveData === true) {
    return PerformanceTier.CONSTRAINED;
  }
  const touchSized = s.coarsePointer === true && Number(s.viewportWidth) > 0 && s.viewportWidth < 1024;
  if ((mem > 0 && mem <= 4) || (cores > 0 && cores <= 4) || touchSized) {
    return PerformanceTier.BALANCED;
  }
  return PerformanceTier.HIGH;
}

/** @param {'HIGH'|'BALANCED'|'CONSTRAINED'} tier */
export function tierBudgets(tier) {
  return TIER_BUDGETS[tier] || TIER_BUDGETS.HIGH;
}

/** Feature-detected signals only; no user-agent sniffing. */
export function readDeviceSignals(g = globalThis) {
  const nav = g.navigator || {};
  let coarsePointer = false;
  try {
    coarsePointer = typeof g.matchMedia === 'function' && g.matchMedia('(pointer: coarse)').matches;
  } catch {
    coarsePointer = false;
  }
  return {
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    hardwareConcurrency: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    coarsePointer,
    viewportWidth: typeof g.innerWidth === 'number' ? g.innerWidth : undefined,
    saveData: nav.connection?.saveData === true,
  };
}

/** @returns {'HIGH'|'BALANCED'|'CONSTRAINED'} */
export function detectPerformanceTier(g = globalThis) {
  return selectPerformanceTier(readDeviceSignals(g));
}
