// sw-register.js — VoiceIsolate Pro
// Registers the canonical Service Worker at /app/sw.js with scope '/'.
// The root /sw.js shim also delegates to /app/sw.js via importScripts(),
// so both registration paths converge on the same implementation.
// Initializes the 3-tier redundant model loader (window.ModelCDNLoader).
// All canonical CDN URLs live in models-manifest.json — no hardcoded URLs here.

/**
 * registerSW — registers /app/sw.js (canonical) and waits for it to control
 * this page. Returns the active ServiceWorkerRegistration, or null if
 * SW is unavailable.
 */
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    // Register the canonical SW directly. The /sw.js root shim also points
    // here via importScripts, so existing cached clients converge seamlessly.
    const reg = await navigator.serviceWorker.register('/app/sw.js', { scope: '/' });
    if (navigator.serviceWorker.controller) return reg;
    await new Promise((resolve) => {
      const onCtrl = () => {
        navigator.serviceWorker.removeEventListener('controllerchange', onCtrl);
        resolve();
      };
      navigator.serviceWorker.addEventListener('controllerchange', onCtrl);
      // safety timeout — don't block boot if SW takes too long
      setTimeout(resolve, 3000);
    });
    return reg;
  } catch (err) {
    console.warn('[sw-register] SW registration failed:', err.message);
    return null;
  }
}

export async function initModelLoader({
  progressBar = null,
  statusEl = null,
  onProgress = null,
  statusUI = null,
} = {}) {
  if (!window.ModelCDNLoader) {
    console.error('[sw-register] window.ModelCDNLoader is not available — make sure model-cdn-loader.js is loaded before sw-register.js');
    if (statusEl) statusEl.textContent = 'Model loader unavailable';
    return { loaded: [], failed: [] };
  }

  let manifest;
  try {
    manifest = await window.ModelCDNLoader.getManifest();
  } catch (err) {
    console.error('[sw-register] Failed to load models manifest:', err);
    if (statusEl) statusEl.textContent = 'Manifest load failed';
    return { loaded: [], failed: [] };
  }

  const allKeys = Object.keys(manifest.models || {});
  const eagerKeys = allKeys.filter(k => manifest.models[k].eager);
  const lazyKeys  = allKeys.filter(k => !manifest.models[k].eager);

  // Mark lazy models as pending immediately.
  for (const key of lazyKeys) {
    statusUI?.setStatus(key, 'pending');
  }

  // Mark eager models as loading (will flip to cached on success / error on failure).
  for (const key of eagerKeys) {
    statusUI?.setStatus(key, 'loading');
  }

  // Expose lazy loader for pipeline-orchestrator to call on first file drop.
  // Accepts a single modelKey + optional progress callback. Each invocation is idempotent
  // (the SW cache short-circuits subsequent calls).
  window._vipLoadLazyModels = async (modelKey, progressCb) => {
    if (!modelKey) {
      // Backwards-compat: load all lazy models if no key given
      const results = await Promise.allSettled(lazyKeys.map(async (k) => {
        statusUI?.setStatus(k, 'loading');
        try {
          await window.ModelCDNLoader.loadModel(k, (frac) => {
            statusUI?.setStatus(k, 'loading', frac * 100);
          });
          const provider = window.ModelCDNLoader.getModelProvider(k);
          statusUI?.setStatus(k, 'cached', undefined, provider);
          return { id: k, ok: true };
        } catch (err) {
          statusUI?.setStatus(k, 'error');
          return { id: k, ok: false, error: err.message };
        }
      }));
      return results.map(r => r.status === 'fulfilled' ? r.value : { ok: false });
    }
    statusUI?.setStatus(modelKey, 'loading');
    try {
      const ab = await window.ModelCDNLoader.loadModel(modelKey, (frac) => {
        if (progressCb) progressCb(frac);
        statusUI?.setStatus(modelKey, 'loading', frac * 100);
      });
      const provider = window.ModelCDNLoader.getModelProvider(modelKey);
      statusUI?.setStatus(modelKey, 'cached', undefined, provider);
      return ab;
    } catch (err) {
      statusUI?.setStatus(modelKey, 'error');
      throw err;
    }
  };

  // Eagerly fetch + cache the small models via the CDN waterfall.
  const loaded = [];
  const failed = [];
  await window.ModelCDNLoader.preloadEagerModels((key, status, provider) => {
    if (status === 'ok') {
      loaded.push(key);
      statusUI?.setStatus(key, 'cached', undefined, provider);
    } else {
      failed.push(key);
      statusUI?.setStatus(key, 'error');
    }
    if (onProgress) onProgress(key, status === 'ok' ? 100 : 0);
  });

  if (progressBar) progressBar.style.display = 'none';
  if (statusEl && failed.length === 0) {
    statusEl.textContent = 'Models ready';
  } else if (statusEl) {
    statusEl.textContent = `Models ready (${failed.length} failed)`;
  }

  return { loaded, failed };
}
