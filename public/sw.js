// public/sw.js — VoiceIsolate Pro
// Canonical redirect shim. This file exists at the root scope so that any
// previously-cached clients that registered /sw.js keep a valid entry point.
// It immediately imports the real, full-featured Service Worker from /app/sw.js
// so ALL requests are handled by the canonical implementation — there is no
// duplicate logic or split caching between this file and /app/sw.js.
//
// WHY THIS PATTERN:
//   A browser can only register ONE SW per scope. If two files claim scope '/'
//   the second registration wins but the first stays in the cache until it
//   expires. Using importScripts() here means there is effectively ONE SW
//   implementation regardless of which URL the browser loaded.
importScripts('/app/sw.js');
