#!/usr/bin/env node
/* ============================================
   VoiceIsolate Pro v21.0 — Local Dev Server
   Express + COOP/COEP for SharedArrayBuffer
   Threads from Space v10 · server.js
   Mobile-ready: Capacitor Android/iOS support
   ============================================ */
'use strict';

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const PORT       = process.env.PORT || 3000;
const APP_VERSION = '22.1.0'; // FIX 9: updated from 21.0.0
const app        = express();

// ── Cross-Origin Isolation (required for SharedArrayBuffer) ──────────────
app.use((_req, res, next) => {
  // Core isolation headers — SharedArrayBuffer needs both
  res.setHeader('Cross-Origin-Opener-Policy',   'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy',  'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy',   'same-origin');

  // Security hardening
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options',        'DENY');
  res.setHeader('Referrer-Policy',         'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy',      'microphone=(self), camera=(), geolocation=()');

  // FIX 3: CSP — local-only; no CDN, no telemetry (ONNX Runtime is vendored at /lib/ort.min.js)
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "connect-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "wasm-src 'self'",
  ].join('; '));

  next();
});

// ── WASM MIME type & caching ─────────────────────────────────────────────
app.use('/wasm', express.static(join(__dirname, 'wasm'), {
  setHeaders: (res) => {
    res.setHeader('Content-Type', 'application/wasm');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
}));

// ── Model files caching ──────────────────────────────────────────────────
app.use('/app/models', express.static(join(__dirname, 'public', 'app', 'models'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.onnx')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    }
  }
}));

// ── FIX 6: Serve only allowlisted root-level runtime files ─────────────────
// Root-level files must be served BEFORE /public to avoid 404s
const ROOT_STATIC_ALLOWLIST = new Set([
  'app.js',
  'dsp-worker.js',
  'ml-worker.js',
]);

function setRootAssetHeaders(res, filePath) {
  if (filePath.endsWith('worker.js') || filePath.includes('processor.js')) {
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  }
  if (filePath.endsWith('.wasm')) {
    res.setHeader('Content-Type', 'application/wasm');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const requestedPath = req.path.replace(/^\/+/, '');

  // Only allow single-segment root files; never expose directories or arbitrary repo files.
  if (!requestedPath || requestedPath.includes('/')) return next();

  const isAllowedRootRuntimeAsset =
    ROOT_STATIC_ALLOWLIST.has(requestedPath) ||
    requestedPath.endsWith('worker.js') ||
    requestedPath.includes('processor.js');

  if (!isAllowedRootRuntimeAsset) return next();

  const filePath = join(__dirname, requestedPath);
  setRootAssetHeaders(res, filePath);
  res.sendFile(filePath, (err) => {
    if (err) next();
  });
});
// ── Serve /public as fallback ────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') && filePath.includes('worker')) {
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    }
  }
}));

// ── Health check endpoint ────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'VoiceIsolate Pro',
    version: APP_VERSION,
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
    features: {
      // FIX 9: Updated from stale '32-stage Octa-Pass' / v21 values
      dsp: '35-stage Deca-Pass',
      ml: 'ONNX Runtime Web v1.18.0 (WebGPU/WASM)',
      vad: 'Silero VAD v5',
      separation: 'Demucs v4 + BSRNN ensemble',
      mobile: 'Capacitor Android/iOS',
      architecture: 'Threads from Space v11',
    },
    timestamp: new Date().toISOString(),
  });
});

// ── API: version info ────────────────────────────────────────────────────
app.get('/api/version', (_req, res) => {
  res.json({ version: APP_VERSION, name: 'VoiceIsolate Pro' });
});

// ── Start ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`VoiceIsolate Pro Dev Server running on port ${PORT}`);
});
