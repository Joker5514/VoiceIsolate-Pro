'use strict';

/**
 * Engineer Mode worklet diagnostics — maps PlaybackMixer load states onto
 * cockpit engine pills (GATE, DEESS, aggregate WORKLET).
 */

/** @type {readonly { id: string, pillId: string, label: string, mixerKey: string }[]} */
export const WORKLET_PILLS = Object.freeze([
  { id: 'vip-gate', pillId: 'engGatePill', label: 'GATE', mixerKey: 'gate' },
  { id: 'vip-deesser', pillId: 'engDeessPill', label: 'DEESS', mixerKey: 'deEsser' },
]);

/**
 * @param {'pending'|'loaded'|'failed'|'bypassed'|string} loadState
 * @returns {'pending'|'loading'|'ready'|'error'|'unavailable'}
 */
export function mapLoadStateToPill(loadState) {
  switch (loadState) {
    case 'loaded': return 'ready';
    case 'pending': return 'loading';
    case 'failed': return 'error';
    case 'bypassed': return 'unavailable';
    default: return 'pending';
  }
}

/**
 * @param {Record<string, { state?: string }>} status
 * @returns {'pending'|'loading'|'ready'|'error'|'unavailable'}
 */
export function aggregateWorkletPill(status = {}) {
  const states = WORKLET_PILLS.map((w) => status[w.mixerKey]?.state || 'pending');
  if (states.some((s) => s === 'failed')) return 'error';
  if (states.some((s) => s === 'pending')) return 'loading';
  if (states.every((s) => s === 'loaded' || s === 'bypassed')) return 'ready';
  return 'pending';
}

/**
 * Read live worklet status from the Engineer Mode bridge (if booted).
 * @returns {Record<string, { state: string, node: boolean }>}
 */
export function readWorkletStatusFromApp(app = globalThis._vipApp) {
  const bridge = app?._bridge;
  if (bridge && typeof bridge.getWorkletStatus === 'function') {
    return bridge.getWorkletStatus();
  }
  const mixer = bridge?.mixer;
  if (mixer && typeof mixer.getWorkletStatus === 'function') {
    return mixer.getWorkletStatus();
  }
  return {
    gate: { state: 'pending', node: false },
    deEsser: { state: 'pending', node: false },
  };
}

/**
 * Poll bridge/mixer worklet load states and update cockpit pills.
 * @param {object} [opts]
 * @param {(id: string, state: string) => void} [opts.setPill]
 * @param {() => object|null} [opts.getApp]
 * @returns {() => void} stop handle
 */
export function startWorkletStatusDriver(opts = {}) {
  const setPill = opts.setPill || globalThis._setVipEnginePill;
  const getApp = opts.getApp || (() => globalThis._vipApp);
  if (typeof setPill !== 'function') return () => {};

  const hasWorkletApi = typeof globalThis.AudioWorkletNode !== 'undefined'
    && typeof globalThis.AudioContext !== 'undefined'
    && AudioContext?.prototype?.audioWorklet != null;

  if (!hasWorkletApi) {
    setPill('engWorkletPill', 'error');
    for (const w of WORKLET_PILLS) setPill(w.pillId, 'error');
    return () => {};
  }

  setPill('engWorkletPill', 'loading');
  for (const w of WORKLET_PILLS) setPill(w.pillId, 'loading');

  let ticks = 0;
  // Keep polling long enough that late ensureCtx()/bridge boot still paints pills.
  // (~5 min @ 250ms) — stop early once both worklets settle.
  const MAX_TICKS = 1200;

  const iv = setInterval(() => {
    ticks += 1;
    const status = readWorkletStatusFromApp(getApp());
    setPill('engWorkletPill', aggregateWorkletPill(status));

    for (const w of WORKLET_PILLS) {
      const entry = status[w.mixerKey] || { state: 'pending' };
      setPill(w.pillId, mapLoadStateToPill(entry.state));
      const el = globalThis.document?.getElementById?.(w.pillId);
      if (el) {
        el.title = `${w.id} — ${entry.state}${entry.node ? ' (active)' : ''}`;
      }
    }

    const allSettled = WORKLET_PILLS.every((w) => {
      const s = status[w.mixerKey]?.state;
      return s && s !== 'pending';
    });
    if (allSettled || ticks >= MAX_TICKS) clearInterval(iv);
  }, 250);

  if (typeof globalThis !== 'undefined') {
    globalThis._vipWorkletStatusIv = iv;
  }

  return () => clearInterval(iv);
}

export default {
  WORKLET_PILLS,
  mapLoadStateToPill,
  aggregateWorkletPill,
  readWorkletStatusFromApp,
  startWorkletStatusDriver,
};