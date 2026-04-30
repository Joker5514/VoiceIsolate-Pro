// ────────────────────────────────────────────────────────────────────────────
// model-loader.js – VoiceIsolate Pro · Threads from Space v8
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ARCHITECTURE INVARIANT — DO NOT REINTRODUCE EXTERNAL CDNs               ║
// ║                                                                          ║
// ║  All .onnx models are served from /app/models/*.onnx on the SAME origin. ║
// ║  Vercel either serves the file directly from public/app/models/ or       ║
// ║  rewrites the path to a Vercel Blob URL configured in vercel.json.       ║
// ║  From the browser the fetch is always same-origin — this is what keeps   ║
// ║  COEP (require-corp) satisfied and SharedArrayBuffer alive.              ║
// ║                                                                          ║
// ║  NEVER add an external src URL (huggingface.co, cdn.*, etc.) to          ║
// ║  MODEL_REGISTRY. Doing so will break COEP and kill the AudioWorklet.     ║
// ║  See MODELS.md for the upload → rewrite → cache flow.                    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// First-run model delivery:
//   1. fetch('/app/models/<filename>.onnx')           ← same-origin URL
//   2. Vercel either serves the bundled file or rewrites to Vercel Blob.
//   3. Response is stored in the Cache API (CACHE_NAME).
//   4. On every subsequent visit sw.js intercepts the fetch and returns the
//      cached binary — ZERO network thereafter.
//   5. Progress is broadcast via a BroadcastChannel so the UI can show a
//      real download bar instead of a spinner.
//
// Model tiers loaded at different times:
//   EAGER  – silero_vad (2.2 MB), rnnoise (0.18 MB)  – loaded at app boot
//   LAZY   – demucs_v4 (83 MB),  bsrnn (45 MB)        – loaded after upload
// ────────────────────────────────────────────────────────────────────────────

export const CACHE_NAME       = 'vip-models-v1';
export const BROADCAST_CH     = 'vip-model-progress';
const MODEL_BASE_PATH         = '/app/models/';

// All entries fetch from MODEL_BASE_PATH + filename.  No external `src` field.
// To add a new model:
//   1. Run scripts/upload_models_to_vercel_blob.py to push the .onnx file to
//      Vercel Blob storage and capture the returned public Blob URL.
//   2. Add a `/app/models/<filename>` rewrite to vercel.json pointing at that
//      Blob URL (see MODELS.md).
//   3. Add an entry below — no `src` field needed; the path is implicit.
const MODEL_REGISTRY = [
  {
    id:       'silero_vad',
    filename: 'silero_vad.onnx',
    // Committed in repo (2.2 MB) — served directly by Vercel from public/app/models/.
    localOnly: true,
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
 * progress, then store the response in the Cache API.
 *
 * The actual bytes come either directly from the Vercel deployment or are
 * proxied via a vercel.json rewrite to Vercel Blob storage. The browser
 * never sees a cross-origin URL.
 *
 * @param {Cache}  cache
 * @param {object} model  – entry from MODEL_REGISTRY
 * @returns {Promise<void>}
 */
async function _fetchAndCache(cache, model) {
  const { id, filename, sizeMB } = model;
  const url = MODEL_BASE_PATH + filename; // same-origin always

  _broadcast({ type: 'start', id, filename, sizeMB });

  // same-origin fetch — no `cors` mode needed; COEP is satisfied automatically.
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`[model-loader] HTTP ${response.status} fetching ${url}`);
  }

  // Stream-read to track download progress.
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

  // Assemble and store in Cache API so sw.js can intercept /app/models/*.onnx.
  const blob       = new Blob(chunks, { type: 'application/octet-stream' });
  const cachedResp = new Response(blob, {
    status:  200,
    headers: {
      'Content-Type':                 'application/octet-stream',
      'Content-Length':               String(blob.size),
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control':                'public, max-age=86400, immutable',
    },
  });
  await cache.put(url, cachedResp);

  _broadcast({ type: 'done', id, filename, bytes: blob.size });
  console.info(`[model-loader] ✓ ${filename} (${(blob.size / 1024 / 1024).toFixed(1)} MB) cached as ${url}`);
}

/**
 * Returns true if model is already present in Cache API.
 */
async function _isCached(cache, filename) {
  const match = await cache.match(MODEL_BASE_PATH + filename);
  return !!match;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * loadEagerModels()
 * Call this at app boot (before ml-worker.js init).
 * Downloads silero_vad and rnnoise on first run; no-op on subsequent runs.
 *
 * @returns {Promise<{ loaded: string[], skipped: string[], failed: string[] }>}
 */
export async function loadEagerModels() {
  const result = { loaded: [], skipped: [], failed: [] };

  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch (err) {
    console.warn('[model-loader] Cache API unavailable:', err.message);
    // Gracefully degrade – ml-worker will hit 404s and fall back to classical DSP.
    return result;
  }

  const eagerModels = MODEL_REGISTRY.filter(m => m.priority === 'eager');

  for (const model of eagerModels) {
    if (model.localOnly) {
      // Already served from the repo – nothing to fetch.
      result.skipped.push(model.id);
      continue;
    }

    const alreadyCached = await _isCached(cache, model.filename);
    if (alreadyCached) {
      result.skipped.push(model.id);
      _broadcast({ type: 'cached', id: model.id, filename: model.filename });
      console.info(`[model-loader] ${model.filename} already cached, skipping download`);
      continue;
    }

    try {
      await _fetchAndCache(cache, model);
      result.loaded.push(model.id);
    } catch (err) {
      result.failed.push(model.id);
      console.error(`[model-loader] Failed to fetch ${model.filename}:`, err.message);
      _broadcast({ type: 'error', id: model.id, filename: model.filename, error: err.message });
    }
  }

  return result;
}

/**
 * loadLazyModels()
 * Call this when the user drops an audio file (before Creator/Forensic processing starts).
 * Downloads demucs_v4 and bsrnn_vocals in parallel with a combined progress bar.
 * No-op if already cached.
 *
 * @param {{ onProgress?: (detail: object) => void }} [opts]
 * @returns {Promise<{ loaded: string[], skipped: string[], failed: string[] }>}
 */
export async function loadLazyModels({ onProgress } = {}) {
  const result = { loaded: [], skipped: [], failed: [] };

  // Wire optional caller progress callback into the BroadcastChannel.
  let localBc = null;
  if (typeof onProgress === 'function') {
    try {
      localBc = new BroadcastChannel(BROADCAST_CH);
      localBc.onmessage = (ev) => onProgress(ev.data);
    } catch { /* ignore */ }
  }

  let cache;
  try {
    cache = await caches.open(CACHE_NAME);
  } catch (err) {
    console.warn('[model-loader] Cache API unavailable:', err.message);
    localBc?.close();
    return result;
  }

  const lazyModels = MODEL_REGISTRY.filter(m => m.priority === 'lazy');

  await Promise.allSettled(
    lazyModels.map(async (model) => {
      const alreadyCached = await _isCached(cache, model.filename);
      if (alreadyCached) {
        result.skipped.push(model.id);
        _broadcast({ type: 'cached', id: model.id, filename: model.filename });
        return;
      }
      try {
        await _fetchAndCache(cache, model);
        result.loaded.push(model.id);
      } catch (err) {
        result.failed.push(model.id);
        console.error(`[model-loader] Failed to fetch ${model.filename}:`, err.message);
        _broadcast({ type: 'error', id: model.id, filename: model.filename, error: err.message });
      }
    })
  );

  localBc?.close();
  return result;
}

/**
 * getModelStatus()
 * Returns cache status for all models. Useful for the diagnostic panel.
 *
 * @returns {Promise<Array<{ id, filename, priority, sizeMB, cached: boolean }>>}
 */
export async function getModelStatus() {
  let cache = null;
  try { cache = await caches.open(CACHE_NAME); } catch { /* ignore */ }

  return Promise.all(
    MODEL_REGISTRY.map(async (m) => ({
      id:       m.id,
      filename: m.filename,
      priority: m.priority,
      sizeMB:   m.sizeMB,
      cached:   m.localOnly ? true : (cache ? await _isCached(cache, m.filename) : false),
    }))
  );
}

/**
 * clearModelCache()
 * Wipes the entire model cache. Use in settings/diagnostics panel.
 */
export async function clearModelCache() {
  const deleted = await caches.delete(CACHE_NAME);
  console.info('[model-loader] Model cache cleared:', deleted);
  return deleted;
}
