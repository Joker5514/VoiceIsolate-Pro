// REMOVED — this file has been consolidated into public/app/sw.js
// The canonical Service Worker is at /app/sw.js and is registered
// by public/app/sw-register.js with scope '/'.
//
// This stub exists only to prevent 404s during the cache transition period.
// It will be deleted once all clients have updated to the new registration.
// DO NOT ADD LOGIC HERE.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => clients.claim());
