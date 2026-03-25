#!/usr/bin/env node
/* ============================================
   VoiceIsolate Pro — Local Dev Server
   Express + COOP/COEP for SharedArrayBuffer
   Threads from Space v8 · server.js
   ============================================ */
'use strict';

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const PORT       = process.env.PORT || 3000;
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

  // CSP — allow self + CDN for ORT WASM + fonts
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "connect-src 'self' https://cdn.jsdelivr.net",
    "worker-src 'self' blob:",
  ].join('; '));

  next();
});

// ── WASM MIME type & caching ─────────────────────────────────────────────
app.use('/wasm', express.static(join(__dirname, 'wasm'), {
  setHeaders: (res) => {
    res.setHeader('Content-Type', 'application/wasm');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}));

// ── Model files caching ──────────────────────────────────────────────────
app.use('/app/models', express.static(join(__dirname, 'public', 'app', 'models'), {
  setHeaders: (res, path) => {
    if (path.endsWith('.onnx')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));

// ── Serve /public as root ────────────────────────────────────────────────
app.use(express.static(join(__dirname, 'public')));

// ── Health check endpoint ────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    app: 'VoiceIsolate Pro',
    version: '19.0',
    crossOriginIsolated: true,
    sharedArrayBuffer: true,
  });
});

// ── Start ────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ╔═══════════════════════════════════════════╗`);
  console.log(`  ║  VoiceIsolate Pro v19 — Dev Server        ║`);
  console.log(`  ║  http://localhost:${PORT}                    ║`);
  console.log(`  ║  COOP/COEP: enabled (SharedArrayBuffer ✓)  ║`);
  console.log(`  ╚═══════════════════════════════════════════╝\n`);
});
