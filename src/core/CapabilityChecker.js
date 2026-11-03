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

import {
  MODEL_MANIFEST,
  isOptionalModelEntry,
  isCompositeModelEntry,
  isInternalPartEntry,
  effectiveModelSizeBytes,
  requiredAssetsForModel,
  describeModelConstraints,
} from './ModelManifest.js';

/**
 * Canonical availability states for VIP-019 model & capability visibility.
 * - `loaded`:      actively instantiated in a worker or AudioWorklet graph
 * - `installed`:   asset bytes verified present locally + SHA-256 pinned
 * - `usable`:      runtime API / classical engine ready for execution
 * - `unavailable`: asset absent, unpinned placeholder, or failed load/probe
 * - `unsupported`: host browser/device lacks the required platform API
 */
export const CAPABILITY_STATES = Object.freeze({
  LOADED: 'loaded',
  INSTALLED: 'installed',
  USABLE: 'usable',
  UNAVAILABLE: 'unavailable',
  UNSUPPORTED: 'unsupported',
});

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

/**
 * Human-readable byte size formatter for model assets.
 * Returns `'Unknown (unshipped)'` when size is null/invalid.
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
export function formatModelBytes(bytes) {
  if (!Number.isInteger(bytes) || bytes <= 0) return 'Unknown (unshipped)';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function lookupAssetPresence(asset, modelId, assetPresence) {
  if (!assetPresence || typeof assetPresence !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(assetPresence, asset.id)) return assetPresence[asset.id];
  if (asset.url && Object.prototype.hasOwnProperty.call(assetPresence, asset.url)) return assetPresence[asset.url];
  if (Object.prototype.hasOwnProperty.call(assetPresence, modelId)) return assetPresence[modelId];
  return undefined;
}

/**
 * Build a read-only, truthful inventory of runtime capabilities and registered
 * models directly from the canonical `MODEL_MANIFEST` + runtime probes (VIP-019).
 *
 * Truthfulness guarantees:
 *  - Never invents models outside `manifest` (`MODEL_MANIFEST` by default).
 *  - Entries with `sha256: null` or `sizeBytes: null` are NEVER marked
 *    `installed`, `loaded`, or `usable` — even if `assetPresence` claims true.
 *  - Optional/unshipped models are `unavailable` unless verified present in
 *    `assetPresence` (or actively loaded with a valid SHA-256 pin).
 *  - Required models with missing assets report `unavailable` with the missing
 *    asset path and active fallback, and flip `summary.requiredModelsReady` false.
 *  - Unsupported platform backends (missing Worker/WASM, WebGPU, SAB, AudioWorklet)
 *    report `unsupported` with explicit reason and active fallback.
 *
 * @param {object} [opts]
 * @param {object} [opts.manifest] canonical model registry (defaults to MODEL_MANIFEST)
 * @param {object} [opts.global] global object for API probes
 * @param {Record<string, boolean|'present'|'missing'|'unprobed'>} [opts.assetPresence]
 * @param {boolean} [opts.assumeShippedPresent] only when true, unprobed shipped pinned models default to installed
 * @param {string[]} [opts.loadedModels] model IDs currently loaded in worker sessions
 * @param {'unknown'|'probing'|'webgpu'|'wasm'|'error'} [opts.ortProvider]
 * @param {boolean|null} [opts.webgpuAdapterAvailable] result of navigator.gpu.requestAdapter() when probed
 * @param {Record<string, boolean|null|undefined>} [opts.worklets] e.g. `{ gate: true, deesser: true }`
 * @param {string[]} [opts.activeChain] model IDs used in the active/most recent processing chain
 * @param {boolean} [opts.isDesktop] true inside Electron desktop shell
 * @param {boolean} [opts.samDesktopWorkerReady] true when Electron local Python SAM worker is healthy
 * @param {boolean} [opts.includeParts] include internal `-part` entries as standalone rows
 */
export function buildModelCapabilityInventory(opts = {}) {
  const manifest = opts.manifest || MODEL_MANIFEST;
  const g = opts.global || globalThis;
  const assetPresence = opts.assetPresence || null;
  const assumeShippedPresent = opts.assumeShippedPresent === true;
  const loadedSet = new Set(Array.isArray(opts.loadedModels) ? opts.loadedModels : []);
  const activeChainSet = new Set(Array.isArray(opts.activeChain) ? opts.activeChain : []);
  const ortProvider = String(opts.ortProvider || 'unknown').toLowerCase();
  const worklets = opts.worklets || {};
  const isDesktop = Boolean(opts.isDesktop);
  const samDesktopReady = Boolean(opts.samDesktopWorkerReady);

  const sab = probeSharedArrayBuffer(g);
  const audio = probeAudioApis(g);
  const compute = probeComputeApis(g);
  const ortSupported = compute.worker.available && compute.wasm.available;

  const webgpuSupported = opts.webgpuAdapterAvailable === false
    ? false
    : compute.webgpu.available;
  const activeRuntimeLabel = ortProvider === 'webgpu'
    ? 'ONNX Runtime WebGPU'
    : ortProvider === 'wasm'
      ? 'ONNX Runtime WASM'
      : ortSupported
        ? (webgpuSupported ? 'ONNX Runtime (WebGPU/WASM ready)' : 'ONNX Runtime (WASM ready)')
        : 'ONNX Runtime unsupported';

  const models = [];
  for (const [id, rawEntry] of Object.entries(manifest)) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    if (!opts.includeParts && isInternalPartEntry(rawEntry)) continue;

    const optional = isOptionalModelEntry(rawEntry);
    const requirement = optional ? 'optional' : 'required';
    const composite = isCompositeModelEntry(rawEntry);
    const rawAssets = requiredAssetsForModel(id, manifest);
    const sizeBytes = effectiveModelSizeBytes(id, manifest);
    const sizeLabel = sizeBytes
      ? `${formatModelBytes(sizeBytes)}${composite ? ` (${rawAssets.length} parts)` : ''}`
      : 'Unknown (unshipped)';
    const constraints = describeModelConstraints(id, manifest);
    const fallback = rawEntry.fallback || (optional
      ? 'Optional capability bypassed; core vocal pipeline remains active'
      : 'Engineer DSP fallback (dsp-worker.js)');
    const backend = rawEntry.backend || 'onnxruntime-web (webgpu -> wasm)';

    const assets = rawAssets.map((a) => {
      const p = lookupAssetPresence(a, id, assetPresence);
      const present = p === true || p === 'present'
        ? true
        : (p === false || p === 'missing')
          ? false
          : (assumeShippedPresent && !optional && a.sha256Pinned && a.sizeBytes !== null ? true : null);
      return Object.freeze({
        id: a.id,
        url: a.url,
        sizeBytes: a.sizeBytes,
        sha256: a.sha256,
        sha256Pinned: a.sha256Pinned,
        present,
      });
    });

    const allPinned = assets.length > 0 && assets.every((a) => a.sha256Pinned && a.sizeBytes !== null);
    const anyMissing = assets.some((a) => a.present === false);
    const allPresent = assets.length > 0 && assets.every((a) => a.present === true);

    const isLoadedInWorker = composite
      ? (loadedSet.has(id) || (assets.length > 0 && assets.every((a) => loadedSet.has(a.id))))
      : loadedSet.has(id);

    let state = CAPABILITY_STATES.UNAVAILABLE;
    let reason = '';

    if (id === 'sam_audio' && isDesktop && samDesktopReady) {
      state = CAPABILITY_STATES.USABLE;
      reason = 'Local Electron SAM Python worker active on loopback';
    } else if (!ortSupported) {
      state = CAPABILITY_STATES.UNSUPPORTED;
      reason = !compute.worker.available
        ? 'Browser/environment does not support Web Workers'
        : 'Browser/environment does not support WebAssembly';
    } else if (!allPinned) {
      state = CAPABILITY_STATES.UNAVAILABLE;
      reason = 'Unshipped placeholder — no pinned SHA-256 or verified ONNX binary';
    } else if (anyMissing) {
      state = CAPABILITY_STATES.UNAVAILABLE;
      const missingUrls = assets.filter((a) => a.present === false).map((a) => a.url || a.id);
      reason = optional
        ? `Optional asset not installed locally (${missingUrls.join(', ')})`
        : `Required model asset missing (${missingUrls.join(', ')})`;
    } else if (isLoadedInWorker) {
      state = CAPABILITY_STATES.LOADED;
      reason = `Loaded in worker session (${activeRuntimeLabel})`;
    } else if (allPresent) {
      state = CAPABILITY_STATES.INSTALLED;
      reason = composite
        ? `All ${assets.length} ONNX part files verified present & SHA-256 pinned`
        : `Verified present at ${assets[0].url} · SHA-256 pinned`;
    } else {
      state = CAPABILITY_STATES.UNAVAILABLE;
      reason = optional
        ? 'Optional model not bundled in default build (installable locally)'
        : 'Awaiting local asset verification probe';
    }

    models.push(Object.freeze({
      id,
      name: rawEntry.name || id,
      task: rawEntry.task || 'unknown',
      backend,
      runtimeProvider: state === CAPABILITY_STATES.LOADED ? activeRuntimeLabel : (ortSupported ? activeRuntimeLabel : 'unsupported'),
      state,
      requirement,
      optional,
      composite,
      requiredAssets: Object.freeze(assets),
      sizeBytes,
      sizeLabel,
      constraints: Object.freeze(constraints),
      license: rawEntry.license || 'Unspecified',
      reason,
      fallback,
      inActiveChain: activeChainSet.has(id),
    }));
  }

  const runtimeCapabilities = [
    Object.freeze({
      id: 'audioContext',
      name: 'Web Audio Real-Time Graph',
      task: 'live-mix-playback',
      backend: 'Web Audio API (AudioContext)',
      state: audio.audioContext.available ? CAPABILITY_STATES.USABLE : CAPABILITY_STATES.UNSUPPORTED,
      requirement: 'required',
      reason: audio.audioContext.reason,
      fallback: audio.audioContext.fallback || 'Offline WAV export only',
    }),
    Object.freeze({
      id: 'offlineAudioContext',
      name: 'Offline Mix & Sample-Rate Render',
      task: 'deterministic-export-render',
      backend: 'Web Audio API (OfflineAudioContext)',
      state: audio.offlineAudioContext.available ? CAPABILITY_STATES.USABLE : CAPABILITY_STATES.UNSUPPORTED,
      requirement: 'required',
      reason: audio.offlineAudioContext.reason,
      fallback: audio.offlineAudioContext.fallback || 'Direct Float32 buffer mixdown',
    }),
    Object.freeze({
      id: 'ortWasm',
      name: 'ONNX Runtime WebAssembly Engine',
      task: 'local-ml-inference',
      backend: 'Web Worker + WebAssembly',
      state: !ortSupported
        ? CAPABILITY_STATES.UNSUPPORTED
        : ortProvider === 'wasm'
          ? CAPABILITY_STATES.LOADED
          : CAPABILITY_STATES.USABLE,
      requirement: 'required',
      reason: !ortSupported
        ? (!compute.worker.available ? compute.worker.reason : compute.wasm.reason)
        : (ortProvider === 'wasm' ? 'Active execution provider in MLWorker' : 'Web Worker + WebAssembly available'),
      fallback: 'Classical SpectralCleanup / Engineer DSP fallback',
    }),
    Object.freeze({
      id: 'webgpu',
      name: 'WebGPU Hardware Acceleration',
      task: 'gpu-ml-inference',
      backend: 'navigator.gpu (ORT WebGPU EP)',
      state: ortProvider === 'webgpu'
        ? CAPABILITY_STATES.LOADED
        : webgpuSupported
          ? CAPABILITY_STATES.USABLE
          : CAPABILITY_STATES.UNSUPPORTED,
      requirement: 'optional',
      reason: ortProvider === 'webgpu'
        ? 'Active execution provider in MLWorker'
        : opts.webgpuAdapterAvailable === false
          ? 'navigator.gpu present but no compatible GPU adapter was returned'
          : compute.webgpu.reason,
      fallback: 'ONNX Runtime WASM (local CPU execution)',
    }),
    Object.freeze({
      id: 'sab',
      name: 'SharedArrayBuffer / Cross-Origin Isolation',
      task: 'multi-threaded-wasm-and-ring-buffers',
      backend: 'COOP/COEP + SharedArrayBuffer',
      state: sab.available ? CAPABILITY_STATES.USABLE : CAPABILITY_STATES.UNSUPPORTED,
      requirement: 'optional',
      reason: sab.reason,
      fallback: 'Single-thread WASM + transferable ArrayBuffers',
    }),
    Object.freeze({
      id: 'worklet:gate',
      name: 'Noise Gate AudioWorklet (vip-gate)',
      task: 'live-mix-dynamics',
      backend: 'AudioWorkletNode (GateProcessor.js)',
      state: !audio.audioWorklet.available
        ? CAPABILITY_STATES.UNSUPPORTED
        : worklets.gate === true
          ? CAPABILITY_STATES.LOADED
          : worklets.gate === false
            ? CAPABILITY_STATES.UNAVAILABLE
            : CAPABILITY_STATES.USABLE,
      requirement: 'optional',
      reason: !audio.audioWorklet.available
        ? audio.audioWorklet.reason
        : worklets.gate === true
          ? 'Loaded in PlaybackMixer AudioContext'
          : worklets.gate === false
            ? 'GateProcessor worklet failed to register'
            : 'AudioWorklet supported; loads when Live-Mix initializes',
      fallback: 'Clean bypass (speech preserved un-gated)',
    }),
    Object.freeze({
      id: 'worklet:deesser',
      name: 'De-Esser AudioWorklet (vip-deesser)',
      task: 'live-mix-sibilance-control',
      backend: 'AudioWorkletNode (DeEsserProcessor.js)',
      state: !audio.audioWorklet.available
        ? CAPABILITY_STATES.UNSUPPORTED
        : worklets.deesser === true
          ? CAPABILITY_STATES.LOADED
          : worklets.deesser === false
            ? CAPABILITY_STATES.UNAVAILABLE
            : CAPABILITY_STATES.USABLE,
      requirement: 'optional',
      reason: !audio.audioWorklet.available
        ? audio.audioWorklet.reason
        : worklets.deesser === true
          ? 'Loaded in PlaybackMixer AudioContext'
          : worklets.deesser === false
            ? 'DeEsserProcessor worklet failed to register'
            : 'AudioWorklet supported; loads when Live-Mix initializes',
      fallback: 'Peaking BiquadFilter sibilance shelf',
    }),
    Object.freeze({
      id: 'classical:usm',
      name: 'Universal Source Matrix (Classical NMF)',
      task: 'blind-and-query-guided-separation',
      backend: 'USMWorker (non-negative matrix factorization)',
      state: compute.worker.available ? CAPABILITY_STATES.USABLE : CAPABILITY_STATES.UNSUPPORTED,
      requirement: 'optional',
      reason: compute.worker.available
        ? 'Local NMF + acoustic prior separator available without optional ONNX weights'
        : compute.worker.reason,
      fallback: 'Primary vocal/noise stem chain',
    }),
  ];

  const requiredModels = models.filter((m) => m.requirement === 'required');
  const installedOrLoadedRequired = requiredModels.filter(
    (m) => m.state === CAPABILITY_STATES.INSTALLED || m.state === CAPABILITY_STATES.LOADED,
  );
  const installedOrLoadedAll = models.filter(
    (m) => m.state === CAPABILITY_STATES.INSTALLED || m.state === CAPABILITY_STATES.LOADED,
  );
  const loadedCount = models.filter((m) => m.state === CAPABILITY_STATES.LOADED).length;

  const summary = Object.freeze({
    ready: audio.audioContext.available && ortSupported && installedOrLoadedRequired.length === requiredModels.length,
    liveMix: audio.audioContext.available,
    offlineMl: ortSupported && installedOrLoadedRequired.length > 0,
    requiredModelsReady: installedOrLoadedRequired.length === requiredModels.length,
    requiredModelsReadyCount: installedOrLoadedRequired.length,
    requiredModelsTotal: requiredModels.length,
    availableModelsCount: installedOrLoadedAll.length,
    loadedModelsCount: loadedCount,
    totalModelsCount: models.length,
    ortBackend: activeRuntimeLabel,
    sab: sab.available,
    webgpu: ortProvider === 'webgpu' || webgpuSupported,
  });

  return Object.freeze({
    summary,
    runtimeCapabilities: Object.freeze(runtimeCapabilities),
    models: Object.freeze(models),
    generatedAt: Date.now(),
  });
}

export default {
  CAPABILITY_STATES,
  checkCapabilities,
  probeSharedArrayBuffer,
  probeAudioApis,
  probeComputeApis,
  formatCapabilityLines,
  formatModelBytes,
  buildModelCapabilityInventory,
};
