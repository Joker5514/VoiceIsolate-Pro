/**
 * VoiceIsolate Pro — STFT cycle budget (Layer 1: Core)
 *
 * Tracks independent forward-STFT owners so Process / Analyze never silently
 * stack unlimited spectral transforms (audit F-02).
 *
 * Rules:
 *   • Each owner may run at most one forward STFT per job token unless elevated.
 *   • Live-Mix worklets never appear here (time-domain only).
 *   • This is an observability + soft-guard layer; hard product limits use
 *     process flags (skipCleanupAfterUSM, etc.) rather than throwing mid-audio.
 *
 * Pure module: no DOM, no Web Audio, no I/O.
 */
'use strict';

/** Known STFT owners (single-pass modules). */
export const STFT_OWNERS = Object.freeze({
  ENGINEER: 'engineer-spectral',
  CLEANUP: 'spectral-cleanup',
  USM: 'universal-source-matrix',
  FFT_BRIDGE: 'fft-bridge',
  OFFLINE: 'offline-processor',
  DSP_CORE: 'dsp-core',
  ML_BSRNN: 'ml-bsrnn-internal',
});

/**
 * Recommended maximum distinct STFT owners per user Process click.
 * Analyze/USM may run separately; Process should prefer ML + one spectral stage.
 */
export const PROCESS_STFT_OWNER_BUDGET = 2;

/**
 * @typedef {{ owner: string, at: number, detail?: string }} StftEvent
 */

/**
 * Create a budget tracker for one Analyze/Process job.
 * @param {{ maxOwners?: number, label?: string }} [opts]
 */
export function createStftBudget(opts = {}) {
  const maxOwners = Math.max(1, opts.maxOwners ?? PROCESS_STFT_OWNER_BUDGET);
  const label = opts.label || 'job';
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {StftEvent[]} */
  const events = [];
  let warnings = [];

  return {
    label,
    maxOwners,

    /**
     * Record a forward STFT for an owner.
     * @param {string} owner
     * @param {string} [detail]
     * @returns {{ allowed: boolean, count: number, ownerCount: number, warning?: string }}
     */
    record(owner, detail) {
      const key = String(owner || 'unknown');
      const next = (counts.get(key) || 0) + 1;
      counts.set(key, next);
      events.push({ owner: key, at: Date.now(), detail: detail || '' });
      const ownerCount = counts.size;
      let warning;
      if (ownerCount > maxOwners) {
        warning = `[STFT-budget:${label}] ${ownerCount} owners > max ${maxOwners} `
          + `(latest=${key}${detail ? ` ${detail}` : ''})`;
        warnings.push(warning);
      }
      if (next > 1) {
        const multi = `[STFT-budget:${label}] owner "${key}" ran forward STFT ${next}× in one job`;
        warnings.push(multi);
        warning = warning ? `${warning}; ${multi}` : multi;
      }
      return {
        allowed: ownerCount <= maxOwners && next <= 1,
        count: next,
        ownerCount,
        warning,
      };
    },

    /** @returns {string[]} */
    owners() {
      return [...counts.keys()];
    },

    /** @returns {Record<string, number>} */
    snapshot() {
      const out = {};
      for (const [k, v] of counts) out[k] = v;
      return out;
    },

    /** @returns {StftEvent[]} */
    getEvents() {
      return events.slice();
    },

    /** @returns {string[]} */
    getWarnings() {
      return warnings.slice();
    },

    /**
     * Whether another owner would exceed the budget.
     * @param {string} owner
     */
    wouldExceed(owner) {
      const key = String(owner || 'unknown');
      if (counts.has(key)) return (counts.get(key) || 0) >= 1;
      return counts.size >= maxOwners;
    },

    reset() {
      counts.clear();
      events.length = 0;
      warnings = [];
    },
  };
}

/**
 * Soft decision helper for Process path composition.
 * @param {{ ranUSM?: boolean, ranCleanup?: boolean, needEngineerSpectral?: boolean }} flags
 * @returns {{ runEngineerSpectral: boolean, runCleanup: boolean, reason: string }}
 */
export function planProcessSpectral(flags = {}) {
  const ranUSM = !!flags.ranUSM;
  const ranCleanup = !!flags.ranCleanup;
  const needEngineer = flags.needEngineerSpectral !== false;

  // Prefer a single reconstructive spectral stage after ML.
  // If SpectralCleanup already ran on stems, skip a second full STFT unless
  // Engineer isolation params demand it.
  if (ranCleanup && !needEngineer) {
    return {
      runEngineerSpectral: false,
      runCleanup: false,
      reason: 'cleanup-already-applied',
    };
  }
  if (ranUSM && !needEngineer) {
    return {
      runEngineerSpectral: false,
      runCleanup: !ranCleanup,
      reason: 'usm-stems-live-mix-only',
    };
  }
  return {
    runEngineerSpectral: needEngineer,
    runCleanup: !ranCleanup && !needEngineer,
    reason: needEngineer ? 'engineer-single-spectral' : 'cleanup-only',
  };
}
