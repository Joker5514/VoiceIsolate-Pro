// model-cdn-loader.js — VoiceIsolate Pro
// ============================================================
// LOCAL-PROCESSING COMPLIANCE NOTE:
// This loader is now same-origin only. Models may be fetched exclusively from
// /app/models/*.onnx (or served from the SW Cache keyed by that same-origin URL).
// No direct external CDN / Blob / HuggingFace / jsDelivr / unpkg fetches are allowed.
// ============================================================

(function() {
  'use strict';

  const PROVIDER_PRIORITY = ['same-origin'];

  // In-memory registry of which providers are known-healthy this session.
  // Start undefined until first successful probe / fetch so UI can show "unknown"
  // then flip to healthy/degraded — never leave the panel stuck forever.
  const providerHealth = { 'same-origin': null };

  // Track which provider served each model in this session (for diagnostics)
  const modelProviderMap = {};

  let _healthProbePromise = null;

  /**
   * probeSameOriginHealth — lightweight HEAD/GET of models-manifest.json so
   * Local Model Health leaves "unknown" on boot (web / Electron vip:// / Capacitor).
   */
  async function probeSameOriginHealth() {
    if (_healthProbePromise) return _healthProbePromise;
    _healthProbePromise = (async () => {
      try {
        const urls = [
          '/app/models-manifest.json',
          './models-manifest.json',
          '/app/models/models-manifest.json',
        ];
        let ok = false;
        for (const url of urls) {
          try {
            const resp = await fetch(url, {
              method: 'GET',
              credentials: 'omit',
              cache: 'no-cache',
            });
            if (resp.ok) {
              ok = true;
              break;
            }
          } catch {
            /* try next */
          }
        }
        providerHealth['same-origin'] = ok;
        return ok;
      } catch {
        providerHealth['same-origin'] = false;
        return false;
      } finally {
        // Allow a later re-probe after network reconnect
        setTimeout(() => { _healthProbePromise = null; }, 30_000);
      }
    })();
    return _healthProbePromise;
  }

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

    const localSources = (Array.isArray(entry.sources) ? entry.sources : [])
      .filter((source) => !source?.provider || source.provider === 'same-origin')
      .map((source) => ({
        provider: 'same-origin',
        url: typeof source?.url === 'string' ? source.url : '',
      }))
      .filter((source) => /^\/app\/models\/[^?#]+\.onnx$/i.test(source.url));

    if (localSources.length === 0 && entry.filename) {
      localSources.push({ provider: 'same-origin', url: `/app/models/${entry.filename}` });
    }
    if (localSources.length === 0) {
      throw new Error(`No same-origin model sources available for ${modelKey}`);
    }

    // Sort sources by PROVIDER_PRIORITY, healthy providers first
    const sorted = [...localSources].sort((a, b) => {
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
    throw new Error(`All local model sources failed for ${modelKey}. Last error: ${lastError && lastError.message}`);
  }

  /**
   * fetchWithProgress — fetch with XHR-style progress reporting.
   * Falls back to plain fetch() if ReadableStream is unavailable.
   */
  async function fetchWithProgress(url, expectedBytes, onProgress) {
    if (!/^\/app\/models\/[^?#]+\.onnx$/i.test(url)) {
      throw new Error(`Rejected non-local model URL: ${url}`);
    }
    const resp = await fetch(url, { credentials: 'omit' });
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

    // Same-origin model path (only on first load)
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
    const candidates = [
      '/app/models-manifest.json', // canonical
      './models-manifest.json',
      '/app/models/models-manifest.json',
    ];
    let lastErr;
    for (const MANIFEST_URL of candidates) {
      try {
        const resp = await fetch(MANIFEST_URL, { credentials: 'omit' });
        if (!resp.ok) {
          lastErr = new Error(`HTTP ${resp.status} for ${MANIFEST_URL}`);
          continue;
        }
        const json = await resp.json();
        providerHealth['same-origin'] = true;
        if (Array.isArray(json?.models)) {
          _manifest = {
            ...json,
            models: Object.fromEntries(json.models.map((entry) => [entry.id, {
              filename: entry.filename,
              eager: entry.load_priority === 'eager' || entry.eager === true,
              sources: [{ provider: 'same-origin', url: entry.path || `/app/models/${entry.filename}` }],
            }])),
          };
        } else {
          _manifest = json;
        }
        return _manifest;
      } catch (err) {
        lastErr = err;
      }
    }
    providerHealth['same-origin'] = false;
    throw lastErr || new Error('Cannot load models-manifest.json');
  }

  window.ModelCDNLoader = {
    loadModel,
    preloadEagerModels,
    getProviderHealthReport,
    getModelProvider,
    getManifest,
    probeSameOriginHealth,
    PROVIDER_PRIORITY,
    providerHealth,
    modelProviderMap
  };

  // Non-blocking boot probe so Local Model Health leaves "unknown" quickly.
  if (typeof window !== 'undefined') {
    void probeSameOriginHealth();
  }
})();
