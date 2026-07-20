/**
 * VoiceIsolate Pro — Capability Checker (Layer 1: Core)
 *
 * Probes runtime features for DSP / ML / worklet / SAB paths and returns a
 * structured registry. Pure probes where possible; browser-only checks are
 * guarded so this module stays importable in Node tests.
 *
 * Contract: every entry is { id, available, reason, fallback }.
 */
'use strict';

/**
 * @typedef {{ id: string, available: boolean, reason: string, fallback: string|null }} CapabilityEntry
 * @typedef {{ capabilities: Record<string, CapabilityEntry>, summary: { ready: boolean, liveMix: boolean, offlineMl: boolean, sab: boolean, webgpu: boolean } }} CapabilityReport
 */

function entry(id, available, reason, fallback = null) {
  return Object.freeze({ id, available: Boolean(available), reason: String(reason || ''), fallback });
}

/** Detect SharedArrayBuffer usability (COOP/COEP cross-origin isolation). */
export function probeSharedArrayBuffer(g = globalThis) {
  try {
    if (typeof g.SharedArrayBuffer === 'undefined') {
      return entry('sab', false, 'SharedArrayBuffer undefined', 'message-port');
    }
    // crossOriginIsolated is the reliable browser signal for usable SAB.
    if (typeof g.crossOriginIsolated === 'boolean' && !g.crossOriginIsolated) {
      return entry('sab', false, 'Page is not cross-origin isolated', 'message-port');
    }
    // Smoke-allocate to catch partially broken environments.
    const _probe = new g.SharedArrayBuffer(8);
    void _probe;
    return entry('sab', true, 'SharedArrayBuffer available', null);
  } catch (err) {
    return entry('sab', false, err && err.message ? err.message : 'SAB probe failed', 'message-port');
  }
}

/** AudioContext / OfflineAudioContext / AudioWorklet probes. */
export function probeAudioApis(g = globalThis) {
  const AC = g.AudioContext || g.webkitAudioContext;
  const OAC = g.OfflineAudioContext || g.webkitOfflineAudioContext;
  const hasAC = typeof AC === 'function';
  const hasOAC = typeof OAC === 'function';
  let worklet = false;
  let workletReason = 'AudioWorklet not available';
  if (hasAC) {
    try {
      // Do not construct AudioContext in Node; only check prototype when possible.
      worklet = !!(AC.prototype && 'audioWorklet' in AC.prototype);
      if (worklet) workletReason = 'AudioWorklet present on AudioContext';
    } catch {
      worklet = false;
    }
  }
  return {
    audioContext: entry('audioContext', hasAC, hasAC ? 'AudioContext available' : 'AudioContext missing', null),
    offlineAudioContext: entry(
      'offlineAudioContext',
      hasOAC,
      hasOAC ? 'OfflineAudioContext available' : 'OfflineAudioContext missing',
      'worker-render',
    ),
    audioWorklet: entry(
      'audioWorklet',
      worklet,
      workletReason,
      'bypass-gate-deess',
    ),
  };
}

/** WebGPU / WebGL2 / Worker / WASM probes. */
export function probeComputeApis(g = globalThis) {
  const webgpu = !!(g.navigator && g.navigator.gpu);
  const webgl2 = (() => {
    try {
      if (typeof g.document === 'undefined') return false;
      const c = g.document.createElement('canvas');
      return !!(c.getContext && (c.getContext('webgl2') || c.getContext('experimental-webgl2')));
    } catch {
      return false;
    }
  })();
  const worker = typeof g.Worker === 'function';
  const wasm = typeof g.WebAssembly === 'object' && typeof g.WebAssembly.instantiate === 'function';
  return {
    webgpu: entry('webgpu', webgpu, webgpu ? 'navigator.gpu present' : 'WebGPU unavailable', 'wasm'),
    webgl2: entry('webgl2', webgl2, webgl2 ? 'WebGL2 available' : 'WebGL2 unavailable', 'wasm'),
    worker: entry('worker', worker, worker ? 'Web Workers available' : 'Workers unavailable', 'main-thread-fallback'),
    wasm: entry('wasm', wasm, wasm ? 'WebAssembly available' : 'WebAssembly unavailable', null),
  };
}

/**
 * Build a full capability report for the current environment.
 * @param {object} [opts]
 * @param {typeof globalThis} [opts.global]
 * @param {Record<string, boolean>} [opts.models] optional model availability map
 * @param {Record<string, boolean>} [opts.worklets] optional worklet load results
 * @returns {CapabilityReport}
 */
export function checkCapabilities(opts = {}) {
  const g = opts.global || globalThis;
  const models = opts.models || {};
  const worklets = opts.worklets || {};

  const sab = probeSharedArrayBuffer(g);
  const audio = probeAudioApis(g);
  const compute = probeComputeApis(g);

  /** @type {Record<string, CapabilityEntry>} */
  const capabilities = {
    sab,
    ...audio,
    ...compute,
  };

  for (const [id, ok] of Object.entries(models)) {
    capabilities[`model:${id}`] = entry(
      `model:${id}`,
      ok,
      ok ? `Model ${id} ready` : `Model ${id} missing or failed integrity`,
      'classical-dsp',
    );
  }

  for (const [id, ok] of Object.entries(worklets)) {
    capabilities[`worklet:${id}`] = entry(
      `worklet:${id}`,
      ok,
      ok ? `Worklet ${id} loaded` : `Worklet ${id} failed to load`,
      'bypass',
    );
  }

  const anyModel = Object.keys(models).length === 0
    ? true
    : Object.values(models).some(Boolean);

  const summary = Object.freeze({
    ready: capabilities.audioContext.available && capabilities.worker.available,
    liveMix: capabilities.audioContext.available,
    offlineMl: capabilities.worker.available && anyModel && capabilities.wasm.available,
    sab: sab.available,
    webgpu: compute.webgpu.available,
  });

  return Object.freeze({
    capabilities: Object.freeze(capabilities),
    summary,
    timestamp: Date.now(),
  });
}

/**
 * Human-readable lines for UI status panels.
 * @param {CapabilityReport} report
 * @returns {string[]}
 */
export function formatCapabilityLines(report) {
  if (!report || !report.capabilities) return [];
  return Object.values(report.capabilities).map((c) => {
    const mark = c.available ? 'OK' : '—';
    const fb = !c.available && c.fallback ? ` (fallback: ${c.fallback})` : '';
    return `[${mark}] ${c.id}: ${c.reason}${fb}`;
  });
}

export default {
  checkCapabilities,
  probeSharedArrayBuffer,
  probeAudioApis,
  probeComputeApis,
  formatCapabilityLines,
};
