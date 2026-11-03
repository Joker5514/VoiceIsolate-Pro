/**
 * VoiceIsolate Pro — Read-Only Model & Capability Inventory Panel (Layer 4: Presentation)
 *
 * VIP-019: Renders a truthful, read-only inventory of models and runtime
 * processing capabilities derived directly from `src/core/ModelManifest.js`,
 * `src/core/CapabilityChecker.js`, `src/core/OrtStatus.js`, and same-origin
 * asset probes — never from a duplicated or hardcoded UI list.
 */
'use strict';

import {
  MODEL_MANIFEST,
  isInternalPartEntry,
  requiredAssetsForModel,
} from '../core/ModelManifest.js';
import {
  CAPABILITY_STATES,
  buildModelCapabilityInventory,
  checkCapabilities,
} from '../core/CapabilityChecker.js';
import {
  getOrtStatus,
  subscribeOrtStatus,
  probeWebGpuAvailable,
} from '../core/OrtStatus.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

const STATE_BADGE_META = Object.freeze({
  [CAPABILITY_STATES.LOADED]: { label: 'Loaded', cls: 'ok' },
  [CAPABILITY_STATES.INSTALLED]: { label: 'Installed', cls: 'ok' },
  [CAPABILITY_STATES.USABLE]: { label: 'Usable', cls: 'ok' },
  [CAPABILITY_STATES.UNAVAILABLE]: { label: 'Unavailable', cls: 'warn' },
  [CAPABILITY_STATES.UNSUPPORTED]: { label: 'Unsupported', cls: 'bad' },
});

/**
 * Probe same-origin presence of pinned model deliverables without downloading
 * full binaries (`HEAD` + CacheStorage check). Unpinned placeholder entries
 * (`sha256: null` or `sizeBytes: null`) are never probed and resolve to false.
 *
 * @param {object} [opts]
 * @param {object} [opts.manifest]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {object} [opts.global]
 * @returns {Promise<Record<string, boolean>>}
 */
export async function probeManifestAssetPresence(opts = {}) {
  const manifest = opts.manifest || MODEL_MANIFEST;
  const g = opts.global || globalThis;
  const fetchFn = opts.fetchImpl || (typeof g.fetch === 'function' ? g.fetch.bind(g) : null);
  /** @type {Record<string, boolean>} */
  const presence = {};
  const seenAssets = new Map();

  for (const [id, entry] of Object.entries(manifest)) {
    if (!entry || isInternalPartEntry(entry)) continue;
    for (const asset of requiredAssetsForModel(id, manifest)) {
      if (!asset.sha256Pinned || asset.sizeBytes === null || !asset.url.startsWith('/')) {
        presence[asset.id] = false;
        continue;
      }
      if (!seenAssets.has(asset.id)) {
        seenAssets.set(asset.id, asset);
      }
    }
  }

  await Promise.all([...seenAssets.values()].map(async (asset) => {
    // 1. Check CacheStorage if available (covers offline cached models).
    try {
      if (g.caches && typeof g.caches.match === 'function') {
        const cached = await g.caches.match(asset.url);
        if (cached && cached.ok) {
          presence[asset.id] = true;
          return;
        }
      }
    } catch { /* ignore CacheStorage restriction */ }

    // 2. Same-origin HEAD probe (zero audio egress, no payload download).
    if (!fetchFn) {
      presence[asset.id] = false;
      return;
    }
    try {
      const res = await fetchFn(asset.url, { method: 'HEAD', cache: 'no-cache' });
      if (!res || !res.ok) {
        presence[asset.id] = false;
        return;
      }
      const ctype = String(res.headers?.get?.('content-type') || '').toLowerCase();
      if (ctype.includes('text/html')) {
        // SPA fallback HTML must never masquerade as an ONNX binary.
        presence[asset.id] = false;
        return;
      }
      const lenHeader = res.headers?.get?.('content-length');
      if (lenHeader != null && lenHeader !== '') {
        const len = Number(lenHeader);
        if (Number.isFinite(len) && len < Math.min(asset.sizeBytes, 1024)) {
          presence[asset.id] = false;
          return;
        }
      }
      presence[asset.id] = true;
    } catch {
      presence[asset.id] = false;
    }
  }));

  return presence;
}

/**
 * Render an inventory snapshot as read-only HTML for `#capabilityPanel`.
 * @param {ReturnType<typeof buildModelCapabilityInventory>} inventory
 * @param {{ openDetails?: boolean }} [opts]
 * @returns {string}
 */
export function renderCapabilityInventoryHtml(inventory, opts = {}) {
  const { summary, runtimeCapabilities, models } = inventory;
  const openAttr = opts.openDetails ? ' open' : '';

  const modelRowsHtml = models.map((m) => {
    const badge = STATE_BADGE_META[m.state] || STATE_BADGE_META.unavailable;
    const assetsText = m.requiredAssets.map((a) => {
      const file = a.url ? a.url.split('/').pop() : a.id;
      const pin = a.sha256Pinned ? `sha256:${String(a.sha256).slice(0, 8)}…` : 'unpinned';
      return `${file} (${pin})`;
    }).join(', ');
    const fallbackHtml = (m.state === CAPABILITY_STATES.UNAVAILABLE || m.state === CAPABILITY_STATES.UNSUPPORTED)
      ? `<div class="vip-cap-row__fallback">Active fallback: <strong>${escapeHtml(m.fallback)}</strong></div>`
      : `<div class="vip-cap-row__fallback vip-cap-row__fallback--standby">Standby fallback: ${escapeHtml(m.fallback)}</div>`;
    const activeTag = m.inActiveChain
      ? ' <span class="cap-pill ok vip-cap-chain-tag">Active Chain</span>'
      : '';

    return `
      <div class="vip-cap-row" data-model-id="${escapeHtml(m.id)}" data-state="${escapeHtml(m.state)}" data-requirement="${escapeHtml(m.requirement)}">
        <div class="vip-cap-row__head">
          <span class="vip-cap-row__title"><strong>${escapeHtml(m.name)}</strong> <code>${escapeHtml(m.id)}</code>${activeTag}</span>
          <span class="vip-cap-row__badges">
            <span class="cap-pill ${m.requirement === 'required' ? 'req' : 'opt'}">${escapeHtml(m.requirement)}</span>
            <span class="cap-pill ${badge.cls}" data-role="state-badge">${escapeHtml(badge.label)}</span>
          </span>
        </div>
        <div class="vip-cap-row__meta">
          <span>Task: <strong>${escapeHtml(m.task)}</strong></span>
          <span>Backend: <strong>${escapeHtml(m.backend)}</strong></span>
          <span>Size: <strong>${escapeHtml(m.sizeLabel)}</strong></span>
          <span>License: <strong>${escapeHtml(m.license)}</strong></span>
        </div>
        <div class="vip-cap-row__meta">
          <span>Input constraints: ${escapeHtml(m.constraints.summary)}</span>
        </div>
        <div class="vip-cap-row__meta">
          <span>Required assets: <code>${escapeHtml(assetsText)}</code></span>
        </div>
        <div class="vip-cap-row__reason">${escapeHtml(m.reason)}</div>
        ${fallbackHtml}
      </div>`;
  }).join('');

  const runtimeRowsHtml = runtimeCapabilities.map((c) => {
    const badge = STATE_BADGE_META[c.state] || STATE_BADGE_META.unavailable;
    const showFallback = c.state === CAPABILITY_STATES.UNAVAILABLE || c.state === CAPABILITY_STATES.UNSUPPORTED;
    return `
      <div class="vip-cap-row vip-cap-row--runtime" data-capability-id="${escapeHtml(c.id)}" data-state="${escapeHtml(c.state)}">
        <div class="vip-cap-row__head">
          <span class="vip-cap-row__title"><strong>${escapeHtml(c.name)}</strong> <code>${escapeHtml(c.id)}</code></span>
          <span class="vip-cap-row__badges">
            <span class="cap-pill ${c.requirement === 'required' ? 'req' : 'opt'}">${escapeHtml(c.requirement)}</span>
            <span class="cap-pill ${badge.cls}" data-role="state-badge">${escapeHtml(badge.label)}</span>
          </span>
        </div>
        <div class="vip-cap-row__meta">
          <span>Task: <strong>${escapeHtml(c.task)}</strong></span>
          <span>Runtime: <strong>${escapeHtml(c.backend)}</strong></span>
        </div>
        <div class="vip-cap-row__reason">${escapeHtml(c.reason)}${showFallback ? ` · Active fallback: <strong>${escapeHtml(c.fallback)}</strong>` : ''}</div>
      </div>`;
  }).join('');

  return `
    <div class="cap-summary" role="group" aria-label="Capability summary">
      <span class="cap-pill ${summary.ready ? 'ok' : 'bad'}">Core ${summary.ready ? 'Ready' : 'Degraded'}</span>
      <span class="cap-pill ${summary.requiredModelsReady ? 'ok' : 'warn'}">Required Models ${summary.requiredModelsReadyCount}/${summary.requiredModelsTotal}</span>
      <span class="cap-pill ${summary.liveMix ? 'ok' : 'bad'}">Live-Mix</span>
      <span class="cap-pill ${summary.offlineMl ? 'ok' : 'warn'}">${escapeHtml(summary.ortBackend)}</span>
      <span class="cap-pill ${summary.webgpu ? 'ok' : 'warn'}">WebGPU ${summary.webgpu ? 'Usable' : 'Unsupported'}</span>
      <span class="cap-pill ${summary.sab ? 'ok' : 'warn'}">SAB ${summary.sab ? 'Usable' : 'Unsupported'}</span>
    </div>
    <details class="cap-details" data-testid="capability-inventory-details"${openAttr}>
      <summary>Model &amp; Capability Inventory (${summary.availableModelsCount}/${summary.totalModelsCount} models installed · ${summary.loadedModelsCount} loaded)</summary>
      <div class="vip-cap-inventory" role="region" aria-label="Read-only model and runtime capability inventory">
        <div class="vip-cap-section-label">Registered ML Models (derived from ModelManifest.js)</div>
        <div class="vip-cap-list" data-role="model-inventory-list">${modelRowsHtml}</div>
        <div class="vip-cap-section-label">Runtime &amp; DSP Capabilities</div>
        <div class="vip-cap-list" data-role="runtime-inventory-list">${runtimeRowsHtml}</div>
      </div>
    </details>`;
}

/**
 * Mount the live, read-only model/capability inventory into a container element.
 *
 * @param {HTMLElement|null} container
 * @param {{ app?: object, global?: object, fetchImpl?: typeof fetch }} [opts]
 * @returns {{ refresh: () => Promise<object>, destroy: () => void, getInventory: () => object|null }}
 */
export function mountModelCapabilityPanel(container, opts = {}) {
  const g = opts.global || globalThis;
  const app = opts.app || null;
  let destroyed = false;
  let assetPresence = {};
  let webgpuAdapterAvailable = null;
  let latestInventory = null;

  function collectRuntimeInputs() {
    const ort = getOrtStatus();
    const loaded = new Set(ort.modelsLoaded || []);
    if (Array.isArray(app?.activeModelChain)) {
      for (const id of app.activeModelChain) loaded.add(id);
    }
    const worklets = g.__vipWorkletStatus || {};
    return {
      global: g,
      assetPresence,
      loadedModels: [...loaded],
      ortProvider: ort.provider,
      webgpuAdapterAvailable,
      worklets: {
        gate: worklets.gate,
        deesser: worklets.deesser,
      },
      activeChain: Array.isArray(app?.activeModelChain) ? app.activeModelChain : [],
      isDesktop: Boolean(g.vipDesktop || g.__VIP_DESKTOP__),
      samDesktopWorkerReady: Boolean(g.__vipSamDesktopReady),
    };
  }

  function paint() {
    if (destroyed || !container) return null;
    const wasOpen = Boolean(container.querySelector('details.cap-details')?.open);
    const inputs = collectRuntimeInputs();
    latestInventory = buildModelCapabilityInventory(inputs);

    // Keep legacy `app._capabilityReport` truthful (derived from actual probe, never hardcoded).
    const modelBoolMap = {};
    for (const m of latestInventory.models) {
      modelBoolMap[m.id] = m.state === CAPABILITY_STATES.INSTALLED || m.state === CAPABILITY_STATES.LOADED;
    }
    const legacyReport = checkCapabilities({
      global: g,
      models: modelBoolMap,
      worklets: inputs.worklets,
    });
    if (app) {
      app._capabilityReport = legacyReport;
      app._capabilityInventory = latestInventory;
    }
    g.__vipCapabilityInventory = latestInventory;

    container.innerHTML = renderCapabilityInventoryHtml(latestInventory, { openDetails: wasOpen });
    try {
      g.dispatchEvent?.(new CustomEvent('vip:capabilityInventoryUpdated', { detail: latestInventory }));
    } catch { /* ignore non-EventTarget test globals */ }
    return latestInventory;
  }

  async function refresh() {
    if (destroyed) return latestInventory;
    paint();
    const [presence, gpuOk] = await Promise.all([
      probeManifestAssetPresence({ global: g, fetchImpl: opts.fetchImpl }),
      probeWebGpuAvailable().catch(() => false),
    ]);
    if (destroyed) return latestInventory;
    assetPresence = presence;
    webgpuAdapterAvailable = gpuOk;
    return paint();
  }

  const unsubOrt = subscribeOrtStatus(() => { paint(); });
  const onProcDone = () => { paint(); };
  try {
    g.addEventListener?.('vip:processingDone', onProcDone);
  } catch { /* ignore */ }

  void refresh();

  return {
    refresh,
    getInventory: () => latestInventory,
    destroy() {
      destroyed = true;
      unsubOrt();
      try { g.removeEventListener?.('vip:processingDone', onProcDone); } catch { /* ignore */ }
    },
  };
}

export default {
  probeManifestAssetPresence,
  renderCapabilityInventoryHtml,
  mountModelCapabilityPanel,
};
