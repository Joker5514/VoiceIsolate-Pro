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
export const MODEL_REGISTRY = [
  // EAGER — small, load immediately
  { id: 'rnnoise',    filename: 'rnnoise_suppressor.onnx',  priority: 'eager' },
  { id: 'silero_vad', filename: 'silero_vad.onnx',          priority: 'eager' },
  // LAZY — large, defer until first audio drop
  { id: 'demucs',     filename: 'demucs_v4_quantized.onnx', priority: 'lazy'  },
  { id: 'bsrnn',      filename: 'bsrnn_vocals.onnx',        priority: 'lazy'  },
];

function broadcast(type, model, progress) {
  try {
    const bc = new BroadcastChannel(BROADCAST_CH);
    bc.postMessage({ type, model, progress });
    bc.close();
  } catch { /* BroadcastChannel unavailable */ }
}

async function fetchAndCache(model) {
  const url = `${MODEL_BASE_PATH}${model.filename}`;
  broadcast('start', model.id);
  try {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url);
    if (cached) {
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
      await cache.put(url, new Response(blob, {
        headers: { 'Content-Type': 'application/octet-stream' },
      }));
    } else {
      await cache.put(url, response.clone());
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
  const eager = MODEL_REGISTRY.filter(m => m.priority === 'eager');
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
  const lazy = MODEL_REGISTRY.filter(m => m.priority === 'lazy');
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
  const model = MODEL_REGISTRY.find(m => m.id === modelId);
  if (!model) return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(`${MODEL_BASE_PATH}${model.filename}`);
    if (!response) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}
