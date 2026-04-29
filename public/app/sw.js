// ─────────────────────────────────────────────────────────────────────────────
// sw.js — VoiceIsolate Pro App Service Worker
//
// Responsibilities:
//   1. Inject Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers
//      on all responses so crossOriginIsolated === true, enabling SharedArrayBuffer
//      for AudioWorklet ↔ ML-thread communication.
//   2. Pre-cache all static app assets on install (app shell).
//   3. Serve ONNX model files via cache-first strategy (large binaries — aggressive caching).
//   4. Serve index.html via network-first strategy (always fresh).
//   5. On activate: skipWaiting + clients.claim for zero-downtime updates.
//
// Privacy: 100% local processing — no fetch() calls to external APIs.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION  = 'vip-app-v1';
const MODEL_CACHE    = 'vip-models-v1';

// Static app-shell assets to pre-cache on install.
// Only files that actually exist in the repo are listed here.
const APP_SHELL = [
  '/app/',
  '/app/index.html',
  '/app/app.js',
  '/app/style.css',
  '/app/dsp-core.js',
  '/app/dsp-processor.js',
  '/app/dsp-worker.js',
  '/app/pipeline-orchestrator.js',
  '/app/pipeline-state.js',
  '/app/ml-worker.js',
  '/app/ml-worker-fetch-cache.js',
  '/app/ring-buffer.js',
  '/app/batch-orchestrator.js',
  '/app/batch-processor.js',
  '/app/visuals.js',
  '/app/analytics.js',
  '/app/license-manager.js',
  '/app/paywall.js',
  '/app/sw-register.js',
  '/app/model-loader.js',
  '/app/vip-boot.js',
  '/app/session-persist.js',
  '/app/slider-map.js',
  '/app/processing-overlay.js',
];

// ── COOP / COEP headers required for SharedArrayBuffer ───────────────────────

/**
 * Wrap a Response, adding the Cross-Origin isolation headers required for
 * SharedArrayBuffer to be available in the page (crossOriginIsolated === true).
 * Non-opaque (same-origin) responses are cloned; opaque responses are returned
 * unmodified because their headers cannot be read or modified.
 */
function withCrossOriginHeaders(response) {
  // Opaque responses (cross-origin no-cors) cannot be modified.
  if (response.type === 'opaque') return response;

  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy',   'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');

  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers,
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Pre-cache app shell; individual failures are tolerated (assets may not
      // exist yet on first deploy or in local dev).
      Promise.allSettled(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[sw] Pre-cache miss (non-fatal):', url, err.message);
          })
        )
      )
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Take immediate control of all open clients — no tab refresh needed.
      self.clients.claim(),
      // Remove stale cache versions.
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) =>
              (k.startsWith('vip-app-') && k !== CACHE_VERSION) ||
              (k.startsWith('vip-models-') && k !== MODEL_CACHE)
            )
            .map((k) => caches.delete(k))
        )
      ),
    ])
  );
});

// ── Fetch interception ────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle same-origin requests.
  if (!request.url.startsWith(self.location.origin)) return;

  const url = new URL(request.url);

  // Strategy 1: Cache-first for ONNX model files (large binaries).
  if (/^\/app\/models\/.+\.onnx(\?.*)?$/.test(url.pathname)) {
    event.respondWith(serveModelCacheFirst(request));
    return;
  }

  // Strategy 2: Network-first for the app's index.html (always fresh).
  if (url.pathname === '/app/' || url.pathname === '/app/index.html') {
    event.respondWith(serveNetworkFirst(request));
    return;
  }

  // Strategy 3: Cache-first for all other app-shell assets.
  if (url.pathname.startsWith('/app/')) {
    event.respondWith(serveAppShellCacheFirst(request));
    return;
  }
});

// ── Strategies ────────────────────────────────────────────────────────────────

/**
 * Cache-first for ONNX models. Falls back to network on miss, caches the result.
 * Returns a graceful 503 if both cache and network fail (offline).
 */
async function serveModelCacheFirst(request) {
  const modelCache = await caches.open(MODEL_CACHE);
  const cached = await modelCache.match(request, { ignoreSearch: true });
  if (cached) return withCrossOriginHeaders(cached);

  try {
    const networkResp = await fetch(request);
    // Don't cache placeholder stubs (< 2 KB). Use parseInt with fallback to 0.
    const cl = parseInt(networkResp.headers.get('content-length') || '0', 10) || 0;
    if (networkResp.ok && (cl === 0 || cl > 2048)) {
      await modelCache.put(request, networkResp.clone());
    }
    return withCrossOriginHeaders(networkResp);
  } catch (err) {
    console.warn('[sw] Model fetch failed (offline?):', request.url, err.message);
    return new Response(
      JSON.stringify({ error: 'Model unavailable offline', url: request.url }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Network-first for index.html. Falls back to cache if network unavailable.
 */
async function serveNetworkFirst(request) {
  try {
    const networkResp = await fetch(request);
    if (networkResp.ok) {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(request, networkResp.clone());
    }
    return withCrossOriginHeaders(networkResp);
  } catch {
    const appCache = await caches.open(CACHE_VERSION);
    const cached = await appCache.match(request);
    if (cached) return withCrossOriginHeaders(cached);
    return new Response('Service unavailable offline', { status: 503 });
  }
}

/**
 * Cache-first for app-shell assets. Falls back to network on miss.
 */
async function serveAppShellCacheFirst(request) {
  const appCache = await caches.open(CACHE_VERSION);
  const cached = await appCache.match(request);
  if (cached) return withCrossOriginHeaders(cached);

  try {
    const networkResp = await fetch(request);
    if (networkResp.ok) {
      const cache = await caches.open(CACHE_VERSION);
      await cache.put(request, networkResp.clone());
    }
    return withCrossOriginHeaders(networkResp);
  } catch (err) {
    console.warn('[sw] App-shell fetch failed:', request.url, err.message);
    return new Response('Resource unavailable offline', { status: 503 });
  }
}
