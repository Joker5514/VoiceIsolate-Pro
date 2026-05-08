// sw-register.js — VoiceIsolate Pro
// Registers the Service Worker and orchestrates model loading.

import { loadEagerModels, BROADCAST_CH } from './model-loader.js';

const CACHE_NAME = 'vip-models-v1';
const EAGER_KEYS = ['rnnoise', 'nsnet2', 'silero_vad'];
const LAZY_KEYS  = ['demucs', 'bsrnn'];

async function fetchAndCacheModel(key, url, statusUI) {
  if (!url) return;
  try {
    statusUI?.setStatus(key, 'loading');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const cache = await caches.open(CACHE_NAME);
    await cache.put(`/app/models/${key}.onnx`, response.clone());
    statusUI?.setStatus(key, 'cached');
  } catch (err) {
    console.error(`[sw-register] Failed to cache model ${key}:`, err);
    statusUI?.setStatus(key, 'error');
  }
}

async function loadManifest() {
  try {
    const res = await fetch('/app/models-manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.warn('[sw-register] Could not load models-manifest.json:', err);
    return {};
  }
}

export async function initModelLoader({
  progressBar = null,
  statusEl = null,
  onProgress = null,
  statusUI = null,
} = {}) {
  // Listen to BroadcastChannel for progress events from model-loader.
  let bc = null;
  try {
    bc = new BroadcastChannel(BROADCAST_CH);
    bc.onmessage = (ev) => {
      const { type, model, progress } = ev.data || {};
      if (type === 'progress' && onProgress) onProgress(model, progress);
      if (type === 'start')    statusUI?.setStatus(model, 'loading');
      if (type === 'done')     statusUI?.setStatus(model, 'cached');
      if (type === 'cached')   statusUI?.setStatus(model, 'cached');
      if (type === 'error')    statusUI?.setStatus(model, 'error');
    };
  } catch { /* BroadcastChannel unavailable */ }

  // Load the blob manifest to get canonical URLs.
  const manifest = await loadManifest();

  // Mark lazy models as pending immediately.
  for (const key of LAZY_KEYS) {
    statusUI?.setStatus(key, 'pending');
  }

  // Expose lazy loader for pipeline-orchestrator to call on first file drop.
  window._vipLoadLazyModels = async () => {
    window._vipLoadLazyModels = null; // only run once
    for (const key of LAZY_KEYS) {
      const modelUrl = `/app/models/${key === 'demucs' ? 'demucs_v4_quantized' : 'bsrnn_quantized'}.onnx`;
      await fetchAndCacheModel(key, modelUrl, statusUI);
    }
  };

  // Eagerly fetch + cache the small models.
  const eagerPromises = EAGER_KEYS.map(key => {
    const fileMap = { rnnoise: 'rnnoise', nsnet2: 'nsnet2', silero_vad: 'silero_vad' };
    const modelUrl = `/app/models/${fileMap[key]}.onnx`;
    return fetchAndCacheModel(key, modelUrl, statusUI);
  });
  await Promise.allSettled(eagerPromises);

  // Also run the legacy loadEagerModels for backward compat.
  const result = await loadEagerModels();
  if (progressBar) progressBar.style.display = 'none';
  if (statusEl && result.failed.length === 0) {
    statusEl.textContent = 'Models ready';
  }
  bc?.close();
  return result;
}
