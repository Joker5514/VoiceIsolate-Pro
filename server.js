#!/usr/bin/env node
/* ============================================
   VoiceIsolate Pro v24.0 — Local Dev Server
   Express 5 + COOP/COEP for SharedArrayBuffer
   Threads from Space v13 · server.js
   Mobile-ready: Capacitor Android/iOS support
   ============================================ */
'use strict';

import express from 'express';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import apiRouter from './api-routes/index.js';
import { securityHeaders } from './server/securityHeaders.js';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// ── Auto-upload models to Vercel Blob on first load ─────────────────────
if (process.env.BLOB_READ_WRITE_TOKEN && process.env.NODE_ENV !== 'test') {
  console.log('[setup-blob] BLOB_READ_WRITE_TOKEN detected. Checking and uploading models to Vercel Blob...');
  const child = spawn('node', [join(__dirname, 'scripts', 'upload-to-vercel-blob.mjs')], {
    stdio: 'inherit',
    env: process.env
  });
  child.on('close', (code) => {
    console.log(`[setup-blob] upload process exited with code ${code}`);
  });
}

const BLOB_MODEL_BASE = process.env.BLOB_BASE_URL
  || 'https://3jq9akm8vl1tub82.public.blob.vercel-storage.com';

const PORT       = process.env.PORT || 3000;
const APP_VERSION = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;
const app        = express();
app.disable('x-powered-by');

// ── Security headers (Layer 0 — see server/securityHeaders.js) ──────────
app.use(securityHeaders());

// ── API Routes ──────────────────────────────────────────────────────────
app.use('/api', apiRouter);

// ── Blob proxy for large ONNX models not committed locally (Demucs, diarization) ──
async function proxyOnnxFromBlob(req, res, next) {
  const filename = req.params.filename;
  if (!filename || !filename.endsWith('.onnx')) return next();
  const localPath = join(__dirname, 'public', 'app', 'models', filename);
  const altLocal = join(__dirname, 'public', 'models', filename);
  if (existsSync(localPath) || existsSync(altLocal)) return next();
  try {
    const upstream = await fetch(`${BLOB_MODEL_BASE.replace(/\/$/, '')}/${filename}`);
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Model not found: ${filename}` });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), res);
    } else {
      res.end(Buffer.from(await upstream.arrayBuffer()));
    }
  } catch (err) {
    next(err);
  }
}

app.get('/app/models/:filename', proxyOnnxFromBlob);
app.get('/models/:filename', proxyOnnxFromBlob);

// ── Model files caching ──────────────────────────────────────────────────
app.use('/app/models', express.static(join(__dirname, 'public', 'app', 'models'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.onnx')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    }
  }
}));

app.use('/models', express.static(join(__dirname, 'public', 'models'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.onnx')) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    }
  },
}));

// ── Serve /src (4-layer Stem-Split & Live-Mix modules — see CLAUDE.md) ──
// AudioWorklet addModule requires correct JS MIME + CORP for COEP pages.
app.use('/src', express.static(join(__dirname, 'src'), {
  setHeaders: (res, filePath) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
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
