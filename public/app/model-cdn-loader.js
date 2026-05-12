// model-cdn-loader.js — VoiceIsolate Pro
// ============================================================
// LOCAL-PROCESSING COMPLIANCE NOTE:
// This file fetches ONNX *model weight files* (binary .onnx blobs)
// from a CDN waterfall on first use. It does NOT transmit any user
// audio data or processing results to any external server.
//
// Audio processing remains 100% local:
//   - AudioWorkletProcessor runs in the browser audio thread.
//   - ONNX Runtime Web executes model inference in a local Worker.
//   - Model weights are cached in the SW Cache (Cache API) after
//     first download — subsequent sessions are fully offline.
//
// The CDN waterfall order is:
//   1. SW Cache (Cache API) — zero network, instant
//   2. Vercel Blob proxied via /app/models/ rewrite (same-origin)
//   3. Cloudflare R2 (CORS whitelisted in vercel.json connect-src)
//   4. HuggingFace Hub (last resort)
//
// See docs/MODEL_DELIVERY.md for full architecture details.
// ============================================================

(function() {
  'use strict';

  // Provider priority order. vercel-blob first (proxied via /app/models/ rewrite —
  // satisfies CSP connect-src 'self'). r2 second. huggingface last (Xet redirect
  // layer can cause CORS issues on large files).
  const PROVIDER_PRIORITY = ['vercel-blob', 'r2', 'huggingface'];

  // In-memory registry of which providers are known-healthy this session
  const providerHealth = { 'vercel-blob': true, 'r2': true, 'huggingface': true };

  // Track which provider served each model in this session (for diagnostics)
  const modelProviderMap = {};

  // Service Worker cache name — must match sw-register.js
  const CACHE_NAME = 'vip-models-v1';

  /**
   * fetchWithFallback — tries each source URL in priority order.
   * On network error or non-2xx, marks that provider degraded and tries next.
   * Returns: { arrayBuffer: ArrayBuffer, provider: string, url: string }
   */
  async function fetchWithFallback(modelKey, manifest, onProgress) {
    const entry = manifest.models[modelKey];
    if (!entry) throw new Error(`Unknown model key: ${modelKey}`);

    // Sort sources by PROVIDER_PRIORITY, healthy providers first
    const sorted = [...entry.sources].sort((a, b) => {
      const ai = PROVIDER_PRIORITY.indexOf(a.provider);
      const bi = PROVIDER_PRIORITY.indexOf(b.provider);
      const ahealthy = providerHealth[a.provider] ? 0 : 1;
      const bhealthy = providerHealth[b.provider] ? 0 : 1;
      return ahealthy - bhealthy || ai - bi;
    });

    let lastError;
    for (const source of sorted) {
      try {
        console.log(`[ModelCDN] Trying ${source.provider} for ${modelKey}: ${source.url}`);
        const ab = await fetchWithProgress(source.url, entry.sizeBytes, onProgress);
        providerHealth[source.provider] = true;
        modelProviderMap[modelKey] = source.provider;
        console.log(`[ModelCDN] ✓ ${modelKey} loaded from ${source.provider}`);
        return { arrayBuffer: ab, provider: source.provider, url: source.url };
      } catch (err) {
        console.warn(`[ModelCDN] ✗ ${source.provider} failed for ${modelKey}:`, err.message);
        providerHealth[source.provider] = false;
        lastError = err;
      }
    }
    throw new Error(`All CDN sources failed for ${modelKey}. Last error: ${lastError && lastError.message}`);
  }

  /**
   * fetchWithProgress — fetch with XHR-style progress reporting.
   * Falls back to plain fetch() if ReadableStream is unavailable.
   */
  async function fetchWithProgress(url, expectedBytes, onProgress) {
    const resp = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);

    if (!resp.body || !onProgress) {
      return resp.arrayBuffer();
    }

    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;
    const total = parseInt(resp.headers.get('content-length') || expectedBytes, 10);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress(received / total, received, total);
    }

    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    return merged.buffer;
  }

  /**
   * loadModel — main entry point called by sw-register.js / pipeline-orchestrator.js
   * Checks SW cache first, then falls back to CDN waterfall.
   * Caches result in SW cache on success.
   */
  async function loadModel(modelKey, onProgress) {
    const manifest = await getManifest();

    // Check SW cache first (zero network for returning users)
    const cacheStorage = (typeof caches !== 'undefined') ? caches : null;
    if (cacheStorage) {
      try {
        const cache = await cacheStorage.open(CACHE_NAME);
        const cachedResp = await cache.match(`/vip-model-cache/${modelKey}`);
        if (cachedResp) {
          console.log(`[ModelCDN] ${modelKey} served from SW cache`);
          if (onProgress) onProgress(1, 1, 1);
          const provider = cachedResp.headers.get('X-VIP-Provider') || 'cache';
          modelProviderMap[modelKey] = provider;
          return await cachedResp.arrayBuffer();
        }
      } catch (e) { /* SW cache unavailable, fall through */ }
    }

    // CDN waterfall (only on first load)
    const { arrayBuffer, provider, url } = await fetchWithFallback(modelKey, manifest, onProgress);

    // Store in SW cache for next time (fire and forget)
    try {
      if (cacheStorage) {
        const cache = await cacheStorage.open(CACHE_NAME);
        const resp = new Response(arrayBuffer.slice(0), {
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-VIP-Provider': provider,
            'X-VIP-Source-URL': url
          }
        });
        await cache.put(`/vip-model-cache/${modelKey}`, resp);
      }
    } catch (e) { console.warn('[ModelCDN] SW cache write failed:', e); }

    return arrayBuffer;
  }

  /**
   * preloadEagerModels — called on app boot, loads all eager:true models
   */
  async function preloadEagerModels(onModelReady) {
    const manifest = await getManifest();
    const eager = Object.entries(manifest.models).filter(([, v]) => v.eager);
    await Promise.all(eager.map(async ([key]) => {
      try {
        await loadModel(key);
        if (onModelReady) onModelReady(key, 'ok', modelProviderMap[key]);
      } catch (err) {
        console.error(`[ModelCDN] Failed to preload ${key}:`, err);
        if (onModelReady) onModelReady(key, 'error', null);
      }
    }));
  }

  function getProviderHealthReport() {
    return { ...providerHealth };
  }

  function getModelProvider(modelKey) {
    return modelProviderMap[modelKey] || null;
  }

  let _manifest = null;
  async function getManifest() {
    if (_manifest) return _manifest;
    const resp = await fetch('/app/models-manifest.json');
    if (!resp.ok) throw new Error('Cannot load models-manifest.json');
    _manifest = await resp.json();
    return _manifest;
  }

  window.ModelCDNLoader = {
    loadModel,
    preloadEagerModels,
    getProviderHealthReport,
    getModelProvider,
    getManifest,
    PROVIDER_PRIORITY,
    providerHealth,
    modelProviderMap
  };
})();
