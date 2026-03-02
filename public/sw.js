/**
 * VoiceIsolate Pro v14.0 — Service Worker
 *
 * Dual responsibility:
 *  1. Inject COOP/COEP headers for every response so SharedArrayBuffer is
 *     available on GitHub Pages (which doesn't support custom HTTP headers).
 *     SharedArrayBuffer is required for ffmpeg.wasm and ONNX Runtime WASM threads.
 *  2. Provide PWA offline caching with appropriate strategies.
 *
 * Caching strategies:
 *   - ML models & WASM binaries  → cache-first (large, versioned by URL)
 *   - CDN assets (ffmpeg core)   → cache-first
 *   - App shell (hashed JS/CSS)  → cache-first (Vite hash = eternal cache)
 *   - Navigation                 → network-first with offline fallback
 */

const CACHE_NAME = 'voiceisolate-v14';

const COOP_HEADERS = {
  'Cross-Origin-Opener-Policy':   'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

// Resources to pre-cache on install (static app shell)
const PRECACHE_URLS = [
  '/VoiceIsolate-Pro/',
  '/VoiceIsolate-Pro/index.html',
  '/VoiceIsolate-Pro/manifest.json',
  '/VoiceIsolate-Pro/favicon.svg',
];

// ── Install ──────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('[SW v14] Pre-cache failed (non-fatal):', err);
      })
    )
  );
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Clone a Response and inject COOP/COEP headers so the browser treats the
 * document as cross-origin isolated (enables SharedArrayBuffer on GitHub Pages).
 */
function addCoopCoep(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(COOP_HEADERS)) headers.set(k, v);
  return new Response(response.body, {
    status:     response.status,
    statusText: response.statusText,
    headers,
  });
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle GET
  if (request.method !== 'GET') return;

  const isSameOrigin = url.origin === self.location.origin;
  const isAllowedCDN = url.hostname === 'cdn.jsdelivr.net' || url.hostname === 'unpkg.com';

  if (!isSameOrigin && !isAllowedCDN) return;

  // ── ML models, WASM, CDN assets → cache-first ─────────────────────────────
  if (
    url.pathname.includes('/models/') ||
    url.pathname.endsWith('.onnx')    ||
    url.pathname.endsWith('.wasm')    ||
    isAllowedCDN
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return addCoopCoep(cached);
        const response = await fetch(request);
        if (response.ok) cache.put(request, response.clone());
        return addCoopCoep(response);
      })
    );
    return;
  }

  // ── Navigation → network-first + COOP/COEP injection ─────────────────────
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            caches.open(CACHE_NAME).then((c) => c.put(request, response.clone()));
          }
          return addCoopCoep(response);
        })
        .catch(async () => {
          const cached = await caches.match('/VoiceIsolate-Pro/index.html');
          return cached
            ? addCoopCoep(cached)
            : new Response('Offline', { status: 503 });
        })
    );
    return;
  }

  // ── App shell assets → cache-first + COOP/COEP injection ─────────────────
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return addCoopCoep(cached);
      try {
        const response = await fetch(request);
        if (response.ok && response.type === 'basic') cache.put(request, response.clone());
        return addCoopCoep(response);
      } catch {
        return new Response('Offline', { status: 503 });
      }
    })
  );
});
