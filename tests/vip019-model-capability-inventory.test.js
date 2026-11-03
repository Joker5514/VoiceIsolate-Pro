/**
 * tests/vip019-model-capability-inventory.test.js
 *
 * VIP-019 — Engineer model/capability visibility:
 *  - Derived strictly from `src/core/ModelManifest.js` + runtime probes (no hardcoded UI lists)
 *  - Distinguishes `loaded`, `installed`, `usable`, `unavailable`, and `unsupported`
 *  - Never marks absent, unpinned (`sha256: null`), or HTML-fallback assets as installed/available
 *  - Explains unavailability reason and active fallback for every model & runtime capability
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let MODEL_MANIFEST;
let isInternalPartEntry;
let CAPABILITY_STATES;
let buildModelCapabilityInventory;
let probeManifestAssetPresence;
let renderCapabilityInventoryHtml;
let mountModelCapabilityPanel;

function makeFullGlobal({ webgpu = false, sab = false, worker = true, wasm = true, worklet = true } = {}) {
  function FakeAudioContext() {}
  if (worklet) {
    FakeAudioContext.prototype.audioWorklet = {};
  }
  return {
    AudioContext: FakeAudioContext,
    OfflineAudioContext: function FakeOfflineAudioContext() {},
    AudioWorkletNode: worklet ? function FakeAudioWorkletNode() {} : undefined,
    Worker: worker ? function FakeWorker() {} : undefined,
    WebAssembly: wasm ? { compile: () => {}, instantiate: () => {} } : undefined,
    SharedArrayBuffer: sab ? SharedArrayBuffer : undefined,
    crossOriginIsolated: sab,
    navigator: webgpu ? { gpu: { requestAdapter: async () => ({}) } } : {},
  };
}

function shippedPresenceMap() {
  return {
    vad: true,
    vad_int8: true,
    rnnoise: true,
    bsrnn_vocals: true,
    dfn3_enc: true,
    dfn3_erb_dec: true,
    dfn3_df_dec: true,
    demucs: false,
    ecapa_tdnn: false,
  };
}

beforeAll(async () => {
  ({ MODEL_MANIFEST, isInternalPartEntry } = await import('../src/core/ModelManifest.js'));
  ({ CAPABILITY_STATES, buildModelCapabilityInventory } = await import('../src/core/CapabilityChecker.js'));
  ({
    probeManifestAssetPresence,
    renderCapabilityInventoryHtml,
    mountModelCapabilityPanel,
  } = await import('../src/presentation/ModelCapabilityPanel.js'));
});

describe('VIP-019 canonical model & capability inventory', () => {
  test('inventory covers every user-facing entry in MODEL_MANIFEST with zero drift', () => {
    const inv = buildModelCapabilityInventory({
      global: makeFullGlobal(),
      assetPresence: shippedPresenceMap(),
      ortProvider: 'wasm',
    });
    const expectedIds = Object.entries(MODEL_MANIFEST)
      .filter(([, e]) => !isInternalPartEntry(e))
      .map(([id]) => id);
    expect(inv.models.map((m) => m.id)).toEqual(expectedIds);

    for (const m of inv.models) {
      expect(typeof m.name).toBe('string');
      expect(typeof m.task).toBe('string');
      expect(typeof m.backend).toBe('string');
      expect(Object.values(CAPABILITY_STATES)).toContain(m.state);
      expect(['required', 'optional']).toContain(m.requirement);
      expect(Array.isArray(m.requiredAssets)).toBe(true);
      expect(m.requiredAssets.length).toBeGreaterThan(0);
      expect(typeof m.sizeLabel).toBe('string');
      expect(typeof m.constraints.summary).toBe('string');
      expect(typeof m.reason).toBe('string');
      expect(m.reason.length).toBeGreaterThan(0);
      expect(typeof m.fallback).toBe('string');
      expect(m.fallback.length).toBeGreaterThan(0);
    }
  });

  test('required shipped models report installed while optional/unshipped and unpinned models report unavailable', () => {
    const inv = buildModelCapabilityInventory({
      global: makeFullGlobal(),
      assetPresence: shippedPresenceMap(),
      ortProvider: 'wasm',
    });
    const byId = Object.fromEntries(inv.models.map((m) => [m.id, m]));

    // Shipped required models (including composite deepfilternet3) are installed
    for (const reqId of ['vad', 'vad_int8', 'rnnoise', 'bsrnn_vocals', 'deepfilternet3']) {
      expect(byId[reqId].requirement).toBe('required');
      expect(byId[reqId].state).toBe(CAPABILITY_STATES.INSTALLED);
    }
    expect(byId.deepfilternet3.sizeBytes).toBe(1954042 + 3292397 + 3340803);
    expect(byId.deepfilternet3.sizeLabel).toContain('3 parts');

    // Optional unshipped models are unavailable (never falsely claimed available)
    for (const optId of ['demucs', 'ecapa_tdnn']) {
      expect(byId[optId].requirement).toBe('optional');
      expect(byId[optId].state).toBe(CAPABILITY_STATES.UNAVAILABLE);
      expect(byId[optId].reason).toMatch(/optional asset not installed/i);
    }

    // Unpinned placeholder entries are unavailable with unknown size
    for (const stubId of ['bsrnn_complex', 'sam_audio', 'universal_separator']) {
      expect(byId[stubId].requirement).toBe('optional');
      expect(byId[stubId].state).toBe(CAPABILITY_STATES.UNAVAILABLE);
      expect(byId[stubId].sizeBytes).toBeNull();
      expect(byId[stubId].sizeLabel).toBe('Unknown (unshipped)');
      expect(byId[stubId].reason).toMatch(/unshipped placeholder|no pinned sha-256/i);
    }

    expect(inv.summary.requiredModelsReady).toBe(true);
    expect(inv.summary.ready).toBe(true);
  });

  test('unpinned stub models NEVER report installed or loaded even if assetPresence or loadedModels claims true', () => {
    const inv = buildModelCapabilityInventory({
      global: makeFullGlobal(),
      assetPresence: {
        ...shippedPresenceMap(),
        bsrnn_complex: true,
        sam_audio: true,
        universal_separator: true,
      },
      loadedModels: ['bsrnn_complex', 'universal_separator'],
      ortProvider: 'wasm',
    });
    const byId = Object.fromEntries(inv.models.map((m) => [m.id, m]));
    expect(byId.bsrnn_complex.state).toBe(CAPABILITY_STATES.UNAVAILABLE);
    expect(byId.sam_audio.state).toBe(CAPABILITY_STATES.UNAVAILABLE);
    expect(byId.universal_separator.state).toBe(CAPABILITY_STATES.UNAVAILABLE);
  });

  test('missing required model asset flips requiredModelsReady false and surfaces fallback', () => {
    const inv = buildModelCapabilityInventory({
      global: makeFullGlobal(),
      assetPresence: {
        ...shippedPresenceMap(),
        bsrnn_vocals: false,
        dfn3_erb_dec: false,
      },
      ortProvider: 'wasm',
    });
    const byId = Object.fromEntries(inv.models.map((m) => [m.id, m]));
    expect(byId.bsrnn_vocals.state).toBe(CAPABILITY_STATES.UNAVAILABLE);
    expect(byId.bsrnn_vocals.reason).toMatch(/required model asset missing/i);
    expect(byId.bsrnn_vocals.fallback).toMatch(/DSP fallback/i);

    // Composite DeepFilterNet3 fails closed when any of its 3 part files is missing
    expect(byId.deepfilternet3.state).toBe(CAPABILITY_STATES.UNAVAILABLE);
    expect(byId.deepfilternet3.reason).toContain('dfn3_erb_dec.onnx');

    expect(inv.summary.requiredModelsReady).toBe(false);
    expect(inv.summary.ready).toBe(false);
  });

  test('loaded worker sessions transition pinned models from installed to loaded', () => {
    const inv = buildModelCapabilityInventory({
      global: makeFullGlobal({ webgpu: true }),
      assetPresence: { ...shippedPresenceMap(), ecapa_tdnn: true },
      loadedModels: ['bsrnn_vocals', 'dfn3_enc', 'dfn3_erb_dec', 'dfn3_df_dec'],
      activeChain: ['bsrnn_vocals'],
      ortProvider: 'webgpu',
      worklets: { gate: true, deesser: false },
    });
    const byId = Object.fromEntries(inv.models.map((m) => [m.id, m]));
    expect(byId.bsrnn_vocals.state).toBe(CAPABILITY_STATES.LOADED);
    expect(byId.bsrnn_vocals.inActiveChain).toBe(true);
    expect(byId.deepfilternet3.state).toBe(CAPABILITY_STATES.LOADED);
    expect(byId.ecapa_tdnn.state).toBe(CAPABILITY_STATES.INSTALLED);

    const rtById = Object.fromEntries(inv.runtimeCapabilities.map((c) => [c.id, c]));
    expect(rtById.webgpu.state).toBe(CAPABILITY_STATES.LOADED);
    expect(rtById['worklet:gate'].state).toBe(CAPABILITY_STATES.LOADED);
    expect(rtById['worklet:deesser'].state).toBe(CAPABILITY_STATES.UNAVAILABLE);
  });

  test('unsupported platform APIs mark dependent models and runtime capabilities unsupported', () => {
    const inv = buildModelCapabilityInventory({
      global: makeFullGlobal({ worker: false, wasm: false, webgpu: false, sab: false, worklet: false }),
      assetPresence: shippedPresenceMap(),
    });
    for (const m of inv.models) {
      expect(m.state).toBe(CAPABILITY_STATES.UNSUPPORTED);
      expect(m.reason).toMatch(/does not support Web Workers|WebAssembly/i);
    }
    const rtById = Object.fromEntries(inv.runtimeCapabilities.map((c) => [c.id, c]));
    expect(rtById.ortWasm.state).toBe(CAPABILITY_STATES.UNSUPPORTED);
    expect(rtById.webgpu.state).toBe(CAPABILITY_STATES.UNSUPPORTED);
    expect(rtById.sab.state).toBe(CAPABILITY_STATES.UNSUPPORTED);
    expect(rtById['worklet:gate'].state).toBe(CAPABILITY_STATES.UNSUPPORTED);
    expect(inv.summary.ready).toBe(false);
  });

  test('probeManifestAssetPresence rejects 404s, SPA HTML fallbacks, and never probes unpinned placeholders', async () => {
    const requestedUrls = [];
    const presence = await probeManifestAssetPresence({
      global: {},
      fetchImpl: async (url) => {
        requestedUrls.push(url);
        if (url.includes('demucs') || url.includes('ecapa')) {
          return { ok: false, status: 404, headers: { get: () => null } };
        }
        if (url.includes('rnnoise')) {
          // Simulate misconfigured SPA rewrite returning index.html with 200 OK
          return {
            ok: true,
            status: 200,
            headers: { get: (k) => (k === 'content-type' ? 'text/html; charset=utf-8' : '1200') },
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: (k) => (k === 'content-type' ? 'application/octet-stream' : null) },
        };
      },
    });

    // Unpinned entries must never be network-probed
    expect(requestedUrls.some((u) => u.includes('bsrnn_vocals_complex'))).toBe(false);
    expect(requestedUrls.some((u) => u.includes('sam_audio'))).toBe(false);
    expect(requestedUrls.some((u) => u.includes('universal-separator'))).toBe(false);

    expect(presence.bsrnn_vocals).toBe(true);
    expect(presence.demucs).toBe(false);
    expect(presence.ecapa_tdnn).toBe(false);
    expect(presence.rnnoise).toBe(false);
    expect(presence.bsrnn_complex).toBe(false);
  });

  test('rendered HTML and analysis-workspace source have zero hardcoded available model overrides', () => {
    const inv = buildModelCapabilityInventory({
      global: makeFullGlobal(),
      assetPresence: shippedPresenceMap(),
      ortProvider: 'wasm',
    });
    const html = renderCapabilityInventoryHtml(inv, { openDetails: true });
    expect(html).toContain('data-model-id="bsrnn_vocals" data-state="installed"');
    expect(html).toContain('data-model-id="demucs" data-state="unavailable"');
    expect(html).toContain('data-model-id="universal_separator" data-state="unavailable"');
    expect(html).toContain('Active fallback:');

    // Guard against regression of the old hardcoded `{ demucs: true }` block in analysis-workspace.js
    const workspaceSrc = fs.readFileSync(path.join(ROOT, 'public/app/lib/analysis-workspace.js'), 'utf8');
    expect(workspaceSrc).toContain('mountModelCapabilityPanel');
    expect(workspaceSrc).not.toMatch(/demucs\s*:\s*true/);
  });

  test('mountModelCapabilityPanel updates app._capabilityInventory from live probe', async () => {
    const container = { innerHTML: '', querySelector: () => null };
    const app = { activeModelChain: ['bsrnn_vocals'] };
    const panel = mountModelCapabilityPanel(container, {
      app,
      global: makeFullGlobal(),
      fetchImpl: async (url) => ({
        ok: !url.includes('demucs') && !url.includes('ecapa'),
        status: url.includes('demucs') || url.includes('ecapa') ? 404 : 200,
        headers: { get: () => 'application/octet-stream' },
      }),
    });
    const inv = await panel.refresh();
    expect(inv.summary.requiredModelsReady).toBe(true);
    expect(app._capabilityInventory).toBe(inv);
    expect(app._capabilityReport.capabilities['model:demucs'].available).toBe(false);
    expect(app._capabilityReport.capabilities['model:bsrnn_vocals'].available).toBe(true);
    expect(container.innerHTML).toContain('Active Chain');
    panel.destroy();
  });
});
