// model-loader.js — VoiceIsolate Pro
// Handles ONNX model fetching, caching, and progress broadcasting.
// All inference runs 100% locally via onnxruntime-web. No cloud APIs.

export const BROADCAST_CH = 'vip-model-progress';
export const MODEL_BASE_PATH = '/app/models/';
const CACHE_NAME = 'vip-models-v1';

/**
 * Full model registry.
 * priority: 'eager'  → fetched at boot (small models)
 * priority: 'lazy'   → deferred until first file drop (large models)
 */
let _registryPromise = null;
export async function getModelRegistry() {
  if (!_registryPromise) _registryPromise = fetch('/app/models-manifest.json', { credentials: 'omit' })
    .then((r) => { if (!r.ok) throw new Error(`Model manifest HTTP ${r.status}`); return r.json(); })
    .then((json) => Object.entries(json.models || {}).map(([id, m]) => ({
      id, filename: m.filename, sizeBytes: m.sizeBytes, sha256: m.sha256,
      shipped: m.shipped !== false, optional: m.optional === true,
      priority: m.eager ? 'eager' : 'lazy',
    })).filter((m) => m.shipped && !m.optional))
    .catch((err) => { _registryPromise = null; throw err; });
  return _registryPromise;
}

function broadcast(type, model, progress) {
  try {
    const bc = new BroadcastChannel(BROADCAST_CH);
    bc.postMessage({ type, model, progress });
    bc.close();
  } catch { /* BroadcastChannel unavailable */ }
}

async function verifyCachedModel(model, bytes) {
  if (bytes.byteLength !== model.sizeBytes || !/^[a-f0-9]{64}$/i.test(model.sha256 || '') || !globalThis.crypto?.subtle) return false;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('') === model.sha256;
}

async function fetchAndCache(model) {
  const url = `${MODEL_BASE_PATH}${model.filename}`;
  broadcast('start', model.id);
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url);
    if (cached && await verifyCachedModel(model, await cached.arrayBuffer())) {
      broadcast('cached', model.id, 100);
      return { id: model.id, ok: true, cached: true };
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // Stream with progress tracking
    const contentLength = response.headers.get('Content-Length');
    if (contentLength && response.body) {
      const total = parseInt(contentLength, 10);
      let loaded = 0;
      const reader = response.body.getReader();
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        broadcast('progress', model.id, Math.round((loaded / total) * 100));
      }
      const blob = new Blob(chunks);
      if (!await verifyCachedModel(model, await blob.arrayBuffer())) throw new Error(`Integrity verification failed for ${model.id}`);
      await cache.put(url, new Response(blob, {
        headers: { 'Content-Type': 'application/octet-stream', 'X-VIP-Provider': 'same-origin' },
      }));
      await cache.put(`/vip-model-cache/${model.id}`, new Response(blob, {
        headers: { 'Content-Type': 'application/octet-stream', 'X-VIP-Provider': 'same-origin' },
      }));
    } else {
      if (!await verifyCachedModel(model, await response.clone().arrayBuffer())) throw new Error(`Integrity verification failed for ${model.id}`);
      await cache.put(url, response.clone());
      await cache.put(`/vip-model-cache/${model.id}`, response.clone());
    }

    broadcast('done', model.id, 100);
    return { id: model.id, ok: true };
  } catch (err) {
    broadcast('error', model.id);
    console.error(`[model-loader] Failed to load ${model.id}:`, err);
    return { id: model.id, ok: false, error: err.message };
  }
}

/**
 * Load all EAGER models at app boot.
 * Returns { loaded: string[], failed: string[] }
 */
export async function loadEagerModels() {
  const eager = (await getModelRegistry()).filter(m => m.priority === 'eager');
  const results = await Promise.allSettled(eager.map(fetchAndCache));
  const loaded = [];
  const failed = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.ok) {
      loaded.push(r.value.id);
    } else {
      const id = r.status === 'fulfilled' ? r.value.id : '?';
      failed.push(id);
    }
  }
  return { loaded, failed };
}

/**
 * Load all LAZY models (called by pipeline-orchestrator on first file drop).
 * Returns { loaded: string[], failed: string[] }
 */
export async function loadLazyModels() {
  const lazy = (await getModelRegistry()).filter(m => m.priority === 'lazy');
  const results = await Promise.allSettled(lazy.map(fetchAndCache));
  const loaded = [];
  const failed = [];
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.ok) {
      loaded.push(r.value.id);
    } else {
      const id = r.status === 'fulfilled' ? r.value.id : '?';
      failed.push(id);
    }
  }
  return { loaded, failed };
}

/**
 * Retrieve a cached model ArrayBuffer for ORT session creation.
 * @param {string} modelId – model id from MODEL_REGISTRY
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function getCachedModelBuffer(modelId) {
  const model = (await getModelRegistry()).find(m => m.id === modelId);
  if (!model) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(`${MODEL_BASE_PATH}${model.filename}`);
    if (!response) return null;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== model.sizeBytes || !model.sha256 || !crypto?.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actual = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    return actual === model.sha256 ? bytes : null;
  } catch {
    return null;
  }
}
