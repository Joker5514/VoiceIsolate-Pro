// ─────────────────────────────────────────────────────────────────────────────
// sw.js — VoiceIsolate Pro App Service Worker
//
// REGISTRATION: no shipping page registers this worker today (registerSW() in
// sw-register.js has no caller), so the web app has no offline launch. It is
// kept correct for any client that registered it earlier and for enablement.
//
// Responsibilities:
//   1. Offline launch of both surfaces: install precaches PRECACHE_URLS, the
//      complete served code graph (landing, /app, /src, /lib JS/CSS/HTML/fonts)
//      stamped by scripts/sw-precache.cjs at build. Install fails if any entry
//      is missing, so an upgrade is atomic and the previous generation stays.
//   2. Never stale online: same-origin GETs are network-first; the cache is
//      only the offline fallback and is refreshed by every successful fetch.
//      A forgotten build stamp therefore cannot pin old code (the old cache-
//      first /app strategy served the first-installed app.js forever).
//   3. ONNX models are not cached here. MLWorker keeps them in IndexedDB keyed
//      by `id:sha256` and verifies every read; a cache-first copy here survived
//      a model replacement and was refused by that integrity check forever.
//   4. Cross-origin isolation headers on every response it serves.
//
// CACHE_VERSION is a content hash of every served non-model file, so any
// change produces a new worker script, a fresh precache and cleanup of old
// generations. Updates activate only after existing clients release the old
// worker (no skipWaiting), so a running Process never sees a mixed graph.
//
// Privacy: 100% local processing — no fetch() calls to external APIs.
// ─────────────────────────────────────────────────────────────────────────────

// Stamped by scripts/sw-precache.cjs (build.mjs, vercel-build.js). Unstamped
// in the dev tree: nothing is precached and the runtime cache still works.
const CACHE_VERSION = 'vip-app-dev';
const PRECACHE_URLS = [];

const CACHE_PREFIX = 'vip-app-';
const LEGACY_MODEL_CACHE_PREFIX = 'vip-models-';

/** Paths served by the static app (everything except API and model binaries). */
function isCacheable(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  if (p.startsWith('/api/')) return false;
  if (/^\/app\/models\/.+\.onnx$/.test(p)) return false;
  return true;
}

function withCrossOriginHeaders(response) {
  // Opaque responses (cross-origin no-cors) cannot be modified.
  if (response.type === 'opaque') return response;
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try {
      // cache.addAll is all-or-nothing: one missing asset rejects the install.
      await cache.addAll(PRECACHE_URLS.map((u) => new Request(u, { cache: 'reload' })));
    } catch (err) {
      await caches.delete(CACHE_VERSION);
      console.warn('[sw] precache failed; keeping the previous generation:', err?.message);
      throw err;
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((k) => (k.startsWith(CACHE_PREFIX) && k !== CACHE_VERSION)
        || k.startsWith(LEGACY_MODEL_CACHE_PREFIX))
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// ── Fetch interception ────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;
  const url = new URL(request.url);
  if (!isCacheable(url)) return;
  event.respondWith(networkFirst(request, url));
});

async function networkFirst(request, url) {
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE_VERSION).then((c) => c.put(request, copy)).catch(() => {});
    }
    return withCrossOriginHeaders(response);
  } catch (err) {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(request, { ignoreSearch: true })
      || (request.mode === 'navigate' && url.pathname.endsWith('/')
        ? await cache.match(`${url.pathname}index.html`)
        : undefined);
    if (cached) return withCrossOriginHeaders(cached);
    console.warn('[sw] offline and not cached:', url.pathname, err?.message);
    return new Response('Resource unavailable offline', { status: 503 });
  }
}
