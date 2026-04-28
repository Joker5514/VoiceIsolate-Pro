/**
 * ort-loader.js — ONNX Runtime Web bootstrap shim for VoiceIsolate Pro
 *
 * Strategy (in order):
 *   1. Try to load /lib/ort.min.js (local, zero-network, CSP-safe)
 *   2. If that 404s, warn loudly and fall back to CDN (only acceptable
 *      during development; production MUST have ort.min.js committed locally)
 *
 * Usage in ml-worker.js:
 *   importScripts('/lib/ort-loader.js');
 *   // ort is now available as globalThis.ort
 *
 * To install ort.min.js locally (REQUIRED for production):
 *   curl -L https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.min.js \
 *        -o public/lib/ort.min.js
 *
 *   Then commit:
 *   git add public/lib/ort.min.js
 *   git commit -m "feat: add ort.min.js local bundle (ONNX Runtime Web v1.17.3)"
 *
 * File size: ~5.1 MB (well under GitHub's 100 MB limit)
 * SHA-256 (v1.17.3): verify after download with `sha256sum public/lib/ort.min.js`
 */

(function ortBootstrap() {
  'use strict';

  const LOCAL_PATH  = '/lib/ort.min.js';
  const CDN_URL     = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.3/dist/ort.min.js';
  const ORT_VERSION = '1.17.3';

  // Already loaded?
  if (typeof globalThis.ort !== 'undefined') {
    console.info('[ort-loader] ort already present, skipping bootstrap.');
    return;
  }

  /**
   * Attempt importScripts from a given URL.
   * Returns true on success, false on failure.
   */
  function tryImport(url) {
    try {
      importScripts(url); // synchronous inside a Worker
      return true;
    } catch (e) {
      return false;
    }
  }

  // --- Attempt 1: local bundle (CSP-safe, zero network) ---
  if (tryImport(LOCAL_PATH)) {
    console.info(`[ort-loader] Loaded ONNX Runtime Web v${ORT_VERSION} from local bundle.`);
    return;
  }

  // --- Total failure: no CDN fallback — would bypass CSP and supply-chain trust ---
  const msg =
    '[ort-loader] FATAL: Cannot load ONNX Runtime Web from local path or CDN.\n' +
    'ML pipeline (Demucs, BSRNN, Silero VAD) will be unavailable.\n' +
    'Fix: commit public/lib/ort.min.js to your repository.';
  console.error(msg);

  // Surface the error to the main thread via a custom event if possible
  if (typeof self !== 'undefined' && self.postMessage) {
    self.postMessage({ type: 'ORT_LOAD_FAILED', message: msg });
  }
})();
