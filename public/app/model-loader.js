// ────────────────────────────────────────────────────────────────────────────
// model-loader.js — VoiceIsolate Pro · Threads from Space v13
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  ARCHITECTURE INVARIANT — VERCEL BLOB IS THE SOLE MODEL SOURCE           ║
// ║                                                                          ║
// ║  All .onnx models are fetched at the SAME-ORIGIN path /app/models/*.onnx.║
// ║  vercel.json rewrites transparently proxy those paths to public Vercel   ║
// ║  Blob URLs (placeholders <BLOB_*_URL> — replace before deploy).          ║
// ║                                                                          ║
// ║  From the browser the fetch is always same-origin, so COEP               ║
// ║  (require-corp) is satisfied and crossOriginIsolated stays true,         ║
// ║  which is required for SharedArrayBuffer between the AudioWorklet and    ║
// ║  the ML worker. NEVER add cross-origin model URLs (huggingface.co, any   ║
// ║  CDN). Doing so will break SAB and silently kill the AudioWorklet path.  ║
// ║  See MODELS.md for the upload → rewrite → cache flow.                    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Network footprint (only allowed traffic):
//   GET /app/models/<filename>.onnx   → resolved by vercel.json rewrite to
//                                       Vercel Blob; cached in Cache API.
// No audio, features, masks, or telemetry ever leave this origin.
// ────────────────────────────────────────────────────────────────────────────

export const CACHE_NAME       = 'vip-models-v1';
export const BROADCAST_CH     = 'vip-model-progress';
export const MODEL_BASE_PATH  = '/app/models/';

// Minimum bytes for a .onnx response to be treated as real (not a placeholder
// stub). Demucs/BSRNN are tens of MB; RNNoise is ~180 KB. Anything < 50 KB is
// almost certainly a 404 HTML body or a placeholder file accidentally checked in.
const PLACEHOLDER_GUARD_BYTES = 50 * 1024;

// Single source of truth for model identity, filename, and lifecycle priority.
// Filenames here MUST match models-manifest.json and ml-worker.js MODEL_FILES.
// To add a model:
//   1. python scripts/upload_models_to_vercel_blob.py --file ./<file>.onnx
//   2. Add a rewrite to vercel.json: /app/models/<file>.onnx → <BLOB_URL>
//   3. Append an entry below.
const MODEL_REGISTRY = [
  {
    id:         'silero_vad',
    filename:   'silero_vad.onnx',
    priority:   'eager',
    sizeMB:     2.2,
    // Committed in repo and served directly from public/app/models/.
    // No vercel.json rewrite needed.
    localOnly:  true,
  },
  {
    id:         'rnnoise',
    filename:   'rnnoise_suppressor.onnx',
    priority:   'eager',
    sizeMB:     0.18,
    // Resolved by vercel.json → <BLOB_RNNOISE_URL>
  },
  {
    id:         'demucs_v4',
    filename:   'demucs_v4_quantized.onnx',
    priority:   'lazy',
    sizeMB:     83,
    // Resolved by vercel.json → <BLOB_DEMUCS_URL>
  },
  {
    id:         'bsrnn_vocals',
    filename:   'bsrnn_vocals.onnx',
    priority:   'lazy',
    sizeMB:     45,
    // Resolved by vercel.json → <BLOB_BSRNN_URL>
  },
];

// ── Internal helpers ────────────────────────────────────────────────────────

let _bc = null;
function _broadcast(detail) {
  if (!_bc) {
    try { _bc = new BroadcastChannel(BROADCAST_CH); } catch { /* SSR / test env */ }
  }
  try { _bc?.postMessage(detail); } catch { /* channel closed */ }
}

/**
 * Stream a model from /app/models/<filename>, push progress events,
 * verify size against the placeholder guard, and store in Cache API
 * (vip-models-v1) so sw.js can serve it on subsequent visits.
 *
 * @param {Cache}  cache
 * @param {object} model  – entry from MODEL_REGISTRY
 * @returns {Promise<void>}
 * @throws if the response is missing, an HTML/error body, or smaller
 *         than PLACEHOLDER_GUARD_BYTES (likely a stub).
 */
async function _fetchAndCache(cache, model) {
  const { id, filename, sizeMB } = model;
  // Same-origin only. vercel.json rewrites resolve this to Vercel Blob.
  const url = MODEL_BASE_PATH + filename;

  _broadcast({ type: 'start', id, filename, sizeMB });

  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    const err = `HTTP ${response.status} fetching ${filename}`;
    _broadcast({ type: 'error', id, filename, error: err });
    throw new Error(err);
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

  // Placeholder guard: any response materially smaller than expected is
  // almost certainly a stub or HTML 404 body. Surface a hard error so we
  // never cache and silently ship a broken model.
  if (received < PLACEHOLDER_GUARD_BYTES) {
    const err =
      `Refusing to cache ${filename}: response is ${received} bytes ` +
      `(< ${PLACEHOLDER_GUARD_BYTES}-byte placeholder threshold). ` +
      `Verify vercel.json rewrite for /app/models/${filename} points at a real Vercel Blob URL.`;
    _broadcast({ type: 'error', id, filename, error: err });
    throw new Error(err);
  }

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
  console.info(`[model-loader] ✓ ${filename} (${(blob.size / 1024 / 1024).toFixed(2)} MB) cached`);
}

async function _isCached(cache, filename) {
  const match = await cache.match(MODEL_BASE_PATH + filename);
  return !!match;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * loadEagerModels()
 * Call once at app boot, AFTER the service worker is controlling the page.
 * Downloads silero_vad (local) and rnnoise (Blob) on first run; no-op after.
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
    return result; // graceful degrade — ml-worker will surface 404s if needed
  }

  for (const model of MODEL_REGISTRY.filter(m => m.priority === 'eager')) {
    if (model.localOnly) {
      result.skipped.push(model.id);
      continue;
    }
    if (await _isCached(cache, model.filename)) {
      result.skipped.push(model.id);
      _broadcast({ type: 'cached', id: model.id, filename: model.filename });
      console.info(`[model-loader] ${model.filename} already cached`);
      continue;
    }
    try {
      await _fetchAndCache(cache, model);
      result.loaded.push(model.id);
    } catch (err) {
      result.failed.push(model.id);
      console.error(`[model-loader] ${model.filename} failed:`, err.message);
    }
  }

  return result;
}

/**
 * loadLazyModels()
 * Call when the user drops a file or selects a Studio/Forensic preset.
 * Demucs and BSRNN are downloaded in parallel; combined progress comes
 * through the BROADCAST_CH BroadcastChannel.
 *
 * @param {{ onProgress?: (detail: object) => void }} [opts]
 * @returns {Promise<{ loaded: string[], skipped: string[], failed: string[] }>}
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
  try {
    cache = await caches.open(CACHE_NAME);
  } catch (err) {
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
        console.error(`[model-loader] ${model.filename} failed:`, err.message);
      }
    })
  );

  localBc?.close();
  return result;
}

/**
 * getModelStatus()
 * Returns cache status for all models. Used by the diagnostic / Engineer panel.
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

// Exported for the model-registry-consistency test and any UI panel that
// needs a static read of the registry without round-tripping the cache.
export { MODEL_REGISTRY };
