#!/usr/bin/env node
/* ============================================
   VoiceIsolate Pro v24.0 — Local Dev Server
   Express 5 + COOP/COEP for SharedArrayBuffer
   Threads from Space v13 · server.js
   Mobile-ready: Capacitor Android/iOS support
   ============================================ */
'use strict';

import express from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import apiRouter from './api/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const PORT       = process.env.PORT || 3000;
const APP_VERSION = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;
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

// ── API Routes ──────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Model files caching ──────────────────────────────────────────────────
app.use('/app/models', express.static(join(__dirname, 'public', 'app', 'models'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.onnx')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    }
  }
}));

// ── Serve /public ────────────────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.js') && filePath.includes('worker')) {
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    }
  }
}));

// ── Health check endpoint ────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── Start ────────────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`VoiceIsolate Pro Dev Server running on port ${PORT}`);
  });
}
export { app };
