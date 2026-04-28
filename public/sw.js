// ─────────────────────────────────────────────────────────────────────────────
// sw.js — VoiceIsolate Pro Service Worker
//
// Responsibilities:
//   1. Serve /app/models/*.onnx from Cache API (populated by model-loader.js).
//      This intercepts every ort.InferenceSession.create('/app/models/X.onnx')
//      call from ml-worker.js and serves the binary from cache instead of
//      hitting the network or the placeholder stub in the repo.
//   2. Pass-through all other requests (no app-shell caching here — that's
//      handled by Vercel's CDN edge).
//   3. On activate, take immediate control (skipWaiting + clients.claim) so
//      the first page load after registration already benefits from caching.
//
// Security note: this SW only caches from the same origin plus the allow-listed
// HuggingFace CDN host. It never caches API responses.
// ─────────────────────────────────────────────────────────────────────────────

const CACHE_NAME    = 'vip-models-v1';
const MODEL_ROUTE   = /^\/app\/models\/.+\.onnx(\?.*)?$/;
const ALLOWED_HOSTS = [
  self.location.hostname,
  'huggingface.co',
];

// ── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  // Skip waiting so the new SW takes control immediately (no tab refresh needed).
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      // Take control of all existing clients immediately.
      self.clients.claim(),
      // Prune old cache versions on upgrade.
      caches.keys().then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith('vip-models-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
        )
      ),
    ])
  );
});

// ── Fetch interception ────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept same-origin ONNX model requests.
  if (url.origin !== self.location.origin) return;
  if (!MODEL_ROUTE.test(url.pathname)) return;

  event.respondWith(serveModel(request));
});

async function serveModel(request) {
  // 1. Try Cache API first (populated by model-loader.js on first run).
  const cached = await caches.match(request, { cacheName: CACHE_NAME, ignoreSearch: true });
  if (cached) {
    return cached;
  }

  // 2. Cache miss: either first run before model-loader finished, or a model
  //    that is still a placeholder. Fetch the real file from network if online.
  //    If offline / network error, return a graceful 503 instead of crashing ORT.
  try {
    const networkResp = await fetch(request);
    // Don't cache placeholder stubs (very small files < 2 KB).
    const cl = Number(networkResp.headers.get('content-length') || 0);
    if (networkResp.ok && (cl === 0 || cl > 2048)) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, networkResp.clone());
    }
    return networkResp;
  } catch (err) {
    console.warn('[sw] Model fetch failed (offline?):', request.url, err.message);
    return new Response(
      JSON.stringify({ error: 'Model unavailable offline', url: request.url }),
      {
        status:  503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
