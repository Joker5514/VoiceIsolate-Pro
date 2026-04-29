// ────────────────────────────────────────────────────────────────────────────
// model-loader.js – VoiceIsolate Pro · Threads from Space v8
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ARCHITECTURE INVARIANT – DO NOT CHANGE WITHOUT READING MODELS.md      ║
// ║                                                                          ║
// ║  All .onnx models are served from /app/models/*.onnx on the SAME origin.║
// ║  Vercel rewrites that path to Vercel Blob storage (see vercel.json).    ║
// ║  From the browser's perspective it is a same-origin fetch – this is     ║
// ║  what keeps COEP (require-corp) satisfied and SharedArrayBuffer alive.  ║
// ║                                                                          ║
// ║  NEVER add an external src URL (huggingface.co, cdn.*, etc.) to         ║
// ║  MODEL_REGISTRY. Doing so will break COEP and kill the AudioWorklet.    ║
// ║  See MODELS.md for the full upload → rewrite → cache flow.             ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Model delivery flow (first run):
//   1. loadEagerModels() / loadLazyModels() fetch from /app/models/*.onnx
//   2. Vercel edge rewrite transparently proxies that path to Vercel Blob.
//   3. The response is stored in the Cache API under /app/models/*.onnx.
//   4. sw.js intercepts all future requests to /app/models/* and returns
//      the cached response → ZERO network after first visit.
//
// Model tiers:
//   EAGER  – silero_vad (2.2 MB), rnnoise (0.18 MB)  – loaded at boot
//   LAZY   – demucs_v4 (83 MB),  bsrnn (45 MB)        – loaded on file drop
// ────────────────────────────────────────────────────────────────────────────

export const CACHE_NAME   = 'vip-models-v1';
export const BROADCAST_CH = 'vip-model-progress';

// All paths are same-origin.  Vercel rewrites /app/models/* → Blob URL.
const MODEL_BASE_PATH = '/app/models/';

// ── Model registry ────────────────────────────────────────────────────────────
// `src` is intentionally absent from every entry.
// The fetch target is always MODEL_BASE_PATH + filename (same origin).
// To add a new model:
//   1. Run scripts/upload_models_to_vercel_blob.py to push the .onnx file.
//   2. Add the Blob URL returned to vercel.json rewrites (see MODELS.md).
//   3. Add an entry here with NO src field.
const MODEL_REGISTRY = [
  {
    id:       'silero_vad',
    filename: 'silero_vad.onnx',
    priority: 'eager',
    sizeMB:   2.2,
  },
  {
    id:       'rnnoise',
    filename: 'rnnoise_suppressor.onnx',
    priority: 'eager',
    sizeMB:   0.18,
  },
  {
    id:       'demucs_v4',
    filename: 'demucs_v4_quantized.onnx',
    priority: 'lazy',
    sizeMB:   83,
  },
  {
    id:       'bsrnn_vocals',
    filename: 'bsrnn_vocals.onnx',
    priority: 'lazy',
    sizeMB:   45,
  },
];

// ── Internal helpers ──────────────────────────────────────────────────────────

let _bc = null;
function _broadcast(detail) {
  if (!_bc) {
    try { _bc = new BroadcastChannel(BROADCAST_CH); } catch { /* SSR / test env */ }
  }
  try { _bc?.postMessage(detail); } catch { /* channel closed */ }
}

/**
 * Fetch a model from its same-origin /app/models/* path with streaming
 * progress tracking, then store the response in the Cache API.
 *
 * The actual bytes come from Vercel Blob storage via a Vercel edge rewrite –
 * the browser never sees a cross-origin URL.
 *
 * @param {Cache}  cache
 * @param {object} model  – entry from MODEL_REGISTRY
 * @returns {Promise<void>}
 */
async function _fetchAndCache(cache, model) {
  const { id, filename, sizeMB } = model;
  const url = MODEL_BASE_PATH + filename; // same-origin always

  _broadcast({ type: 'start', id, filename, sizeMB });

  // same-origin fetch – no 'cors' mode needed, COEP is satisfied automatically
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`[model-loader] HTTP ${response.status} fetching ${url}`);
  }

  const contentLength = Number(response.headers.get('content-length')) || sizeMB * 1024 * 1024;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    _broadcast({
      type:    'progress',
      id,
      filename,
      loaded:  received,
      total:   contentLength,
      percent: Math.round((received / contentLength) * 100),
    });
  }

  const blob = new Blob(chunks, { type: 'application/octet-stream' });
  const cachedResp = new Response(blob, {
    status:  200,
    headers: {
      'Content-Type':                'application/octet-stream',
      'Content-Length':              String(blob.size),
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control':               'public, max-age=86400, immutable',
    },
  });
  await cache.put(url, cachedResp);

  _broadcast({ type: 'done', id, filename, bytes: blob.size });
  console.info(`[model-loader] ✓ ${filename} (${(blob.size / 1024 / 1024).toFixed(1)} MB) cached`);
}

async function _isCached(cache, filename) {
  return !!(await cache.match(MODEL_BASE_PATH + filename));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * loadEagerModels()
 * Call at app boot. Downloads silero_vad + rnnoise on first run; no-op
 * on subsequent visits (served from Cache API by sw.js).
 */
export async function loadEagerModels() {
  const result = { loaded: [], skipped: [], failed: [] };
  let cache;
  try { cache = await caches.open(CACHE_NAME); }
  catch (err) {
    console.warn('[model-loader] Cache API unavailable:', err.message);
    return result;
  }

  for (const model of MODEL_REGISTRY.filter(m => m.priority === 'eager')) {
    if (await _isCached(cache, model.filename)) {
      result.skipped.push(model.id);
      _broadcast({ type: 'cached', id: model.id, filename: model.filename });
      continue;
    }
    try {
      await _fetchAndCache(cache, model);
      result.loaded.push(model.id);
    } catch (err) {
      result.failed.push(model.id);
      console.error(`[model-loader] ✗ ${model.filename}:`, err.message);
      _broadcast({ type: 'error', id: model.id, filename: model.filename, error: err.message });
    }
  }
  return result;
}

/**
 * loadLazyModels()
 * Call when the user drops an audio file. Downloads demucs_v4 + bsrnn
 * in parallel. No-op if already cached.
 *
 * @param {{ onProgress?: (detail: object) => void }} [opts]
 */
export async function loadLazyModels({ onProgress } = {}) {
  const result = { loaded: [], skipped: [], failed: [] };

  let localBc = null;
  if (typeof onProgress === 'function') {
    try {
      localBc = new BroadcastChannel(BROADCAST_CH);
      localBc.onmessage = (ev) => onProgress(ev.data);
    } catch { /* ignore */ }
  }

  let cache;
  try { cache = await caches.open(CACHE_NAME); }
  catch (err) {
    console.warn('[model-loader] Cache API unavailable:', err.message);
    localBc?.close();
    return result;
  }

  await Promise.allSettled(
    MODEL_REGISTRY.filter(m => m.priority === 'lazy').map(async (model) => {
      if (await _isCached(cache, model.filename)) {
        result.skipped.push(model.id);
        _broadcast({ type: 'cached', id: model.id, filename: model.filename });
        return;
      }
      try {
        await _fetchAndCache(cache, model);
        result.loaded.push(model.id);
      } catch (err) {
        result.failed.push(model.id);
        console.error(`[model-loader] ✗ ${model.filename}:`, err.message);
        _broadcast({ type: 'error', id: model.id, filename: model.filename, error: err.message });
      }
    })
  );

  localBc?.close();
  return result;
}

/** Returns cache status for all models. Useful for the diagnostic panel. */
export async function getModelStatus() {
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch { /* ignore */ }
  return Promise.all(
    MODEL_REGISTRY.map(async (m) => ({
      id:       m.id,
      filename: m.filename,
      priority: m.priority,
      sizeMB:   m.sizeMB,
      cached:   cache ? await _isCached(cache, m.filename) : false,
    }))
  );
}

/** Wipes the entire model cache. Use in the settings/diagnostics panel. */
export async function clearModelCache() {
  const deleted = await caches.delete(CACHE_NAME);
  console.info('[model-loader] Model cache cleared:', deleted);
  return deleted;
}
