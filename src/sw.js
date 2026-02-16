/**
 * VoiceIsolate Pro v9.0 — Service Worker
 * Enables offline-first PWA with cache-first strategy for app shell
 * and network-first for dynamic resources (ML models, etc.).
 */

const CACHE_NAME = 'voiceisolate-v9';
const APP_SHELL = [
  '/',
  '/index.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/ui/controls.js',
  '/js/ui/visualizer.js',
  '/js/export/encoders.js',
  '/js/ml/model-manager.js',
  '/js/utils/audio-utils.js',
  '/js/utils/crypto-utils.js',
  '/js/utils/db.js',
  '/js/workers/dispatcher-worker.js',
  '/js/workers/dsp-worker.js',
  '/js/dsp/nodes/decode.js',
  '/js/dsp/nodes/fft.js',
  '/js/dsp/nodes/hum-removal.js',
  '/js/dsp/nodes/noise-profile.js',
  '/js/dsp/nodes/normalize.js',
  '/js/dsp/nodes/spectral-gate.js',
  '/js/dsp/nodes/spectral-subtraction.js',
  '/js/dsp/nodes/vad.js',
  '/js/dsp/nodes/voiceprint.js',
  '/manifest.json',
];

// Install — cache app shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL).catch((err) => {
        console.warn('[SW] Some assets failed to cache during install:', err);
      });
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch — cache-first for app shell, network-first for other requests
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip cross-origin requests (except fonts)
  if (url.origin !== self.location.origin && !url.hostname.includes('fonts.googleapis.com') && !url.hostname.includes('fonts.gstatic.com')) {
    return;
  }

  // Font requests — cache-first with long TTL
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        });
      })
    );
    return;
  }

  // App shell — cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        // Cache successful responses
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback for navigation requests
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      });
    })
  );
});
