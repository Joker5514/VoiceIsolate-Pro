/**
 * VoiceIsolate Pro v14.0 — Service Worker
 * PWA offline strategy:
 *   - App shell (HTML, CSS, JS) → cache-first (Vite hashes ensure freshness)
 *   - ML models (/models/*.onnx) → cache-first (large, rarely change)
 *   - ffmpeg.wasm CDN assets → cache-first (versioned CDN URLs)
 *   - Navigation requests → network-first with offline fallback
 *
 * NOTE: Because Vite emits hashed filenames, updating the CACHE_NAME
 * on each deploy is sufficient to bust old assets.
 */

const CACHE_NAME = 'voiceisolate-v14';

// Resources to pre-cache on install (static app shell)
const PRECACHE_URLS = [
  '/VoiceIsolate-Pro/',
  '/VoiceIsolate-Pro/index.html',
  '/VoiceIsolate-Pro/manifest.json',
  '/VoiceIsolate-Pro/favicon.svg',
];

// Install — pre-cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch((err) => {
        console.warn('[SW v14] Some assets failed to pre-cache:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate — delete all caches that don't match CACHE_NAME
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — routing strategy
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip cross-origin requests (except known CDN assets for ffmpeg/onnx)
  const isSameOrigin = url.origin === self.location.origin;
  const isAllowedCDN =
    url.hostname === 'cdn.jsdelivr.net' ||
    url.hostname === 'unpkg.com';

  if (!isSameOrigin && !isAllowedCDN) return;

  // ML models and CDN assets — cache-first (large binaries, versioned URLs)
  if (
    url.pathname.includes('/models/') ||
    url.pathname.endsWith('.onnx') ||
    url.pathname.endsWith('.wasm') ||
    isAllowedCDN
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) =>
        cache.match(request).then((cached) => {
          if (cached) return cached;
          return fetch(request).then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // Navigation requests — network-first with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((c) => c.put(request, clone));
          }
          return response;
        })
        .catch(() => caches.match('/VoiceIsolate-Pro/index.html')
          .then((cached) => cached ?? new Response('Offline', { status: 503 }))
        )
    );
    return;
  }

  // App shell assets (JS, CSS, fonts, icons) — cache-first
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok && response.type === 'basic') {
            cache.put(request, response.clone());
          }
          return response;
        }).catch(() => new Response('Offline', { status: 503 }));
      })
    )
  );
});
