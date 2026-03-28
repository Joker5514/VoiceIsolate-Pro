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
const APP_VERSION = '21.0.0';
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

  // CSP — allow self + CDN for ORT WASM + fonts
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: mediastream:",
    "connect-src 'self' https://cdn.jsdelivr.net https://va.vercel-scripts.com",
    "worker-src 'self' blob:",
    "wasm-src 'self' https://cdn.jsdelivr.net",
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

// ── Serve /public as root ────────────────────────────────────────────────
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
      dsp: '32-stage Octa-Pass',
      ml: 'ONNX Runtime Web (WebGPU/WASM)',
      vad: 'Silero VAD v5',
      mobile: 'Capacitor Android/iOS',
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
  console.log(`\n  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║  VoiceIsolate Pro v${APP_VERSION} — Dev Server    ║`);
  console.log(`  ║  http://localhost:${PORT}                       ║`);
  console.log(`  ║  COOP/COEP: enabled (SharedArrayBuffer ✓)     ║`);
  console.log(`  ║  Mobile: Capacitor Android/iOS ready          ║`);
  console.log(`  ╚══════════════════════════════════════════════╝\n`);
});
