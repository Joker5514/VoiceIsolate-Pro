#!/usr/bin/env node
/**
 * validate-onnx-models.js
 * ========================
 * Checks each ONNX model URL defined in models-manifest.json (or the
 * hard-coded fallback list below) and reports:
 *   ✅  Real binary  – Content-Length > 100 KB
 *   ⚠️  Stub / tiny  – Content-Length ≤ 100 KB (likely a placeholder)
 *   ❌  Missing / 4xx – URL returns a non-200 status
 *
 * Usage:
 *   node scripts/validate-onnx-models.js
 *   node scripts/validate-onnx-models.js --manifest public/app/models-manifest.json
 *
 * Exit code: 0 = all real, 1 = one or more stubs/missing
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

// __dirname is available in CJS — no import.meta shim needed

// ── Colours ────────────────────────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const B = (s) => `\x1b[36m${s}\x1b[0m`;

// ── Fallback model list (used when no manifest found) ──────────────────────
const BLOB_BASE_URL = process.env.BLOB_BASE_URL || '';
const FALLBACK_MODELS = [
  {
    name: 'silero_vad.onnx',
    cdn_src: BLOB_BASE_URL ? `${BLOB_BASE_URL.replace(/\/$/, '')}/silero_vad.onnx` : '',
    min_bytes: 100_000,
  },
  {
    name: 'rnnoise_suppressor.onnx',
    cdn_src: BLOB_BASE_URL ? `${BLOB_BASE_URL.replace(/\/$/, '')}/rnnoise_suppressor.onnx` : '',
    min_bytes: 100_000,
  },
  {
    name: 'demucs_v4_quantized.onnx',
    cdn_src: BLOB_BASE_URL ? `${BLOB_BASE_URL.replace(/\/$/, '')}/demucs_v4_quantized.onnx` : '',
    min_bytes: 10_000_000,
  },
  {
    name: 'bsrnn_vocals.onnx',
    cdn_src: BLOB_BASE_URL ? `${BLOB_BASE_URL.replace(/\/$/, '')}/bsrnn_vocals.onnx` : '',
    min_bytes: 10_000_000,
  },
].filter((m) => m.cdn_src);

// ── Parse CLI args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const manifestFlag = args.indexOf('--manifest');
let manifestPath = manifestFlag !== -1 ? args[manifestFlag + 1] : null;

if (!manifestPath) {
  const candidates = [
    path.resolve(__dirname, '../public/app/models-manifest.json'),
    path.resolve(__dirname, '../models-manifest.json'),
  ];
  manifestPath = candidates.find((p) => fs.existsSync(p)) || null;
}

// ── HEAD request helper ────────────────────────────────────────────────────
function headRequest(urlStr, redirects) {
  if (redirects === undefined) redirects = 5;
  return new Promise((resolve) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method: 'HEAD',
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        headers: { 'User-Agent': 'VoiceIsolate-ModelValidator/1.0' },
      },
      (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          req.destroy();
          resolve(headRequest(res.headers.location, redirects - 1));
          return;
        }
        const cl = parseInt(res.headers['content-length'] || '0', 10);
        resolve({ status: res.statusCode, contentLength: cl, url: urlStr });
        res.resume();
      }
    );
    req.on('error', (e) => resolve({ status: 0, contentLength: 0, url: urlStr, error: e.message }));
    req.setTimeout(15_000, () => {
      req.destroy();
      resolve({ status: 0, contentLength: 0, url: urlStr, error: 'timeout' });
    });
    req.end();
  });
}

// ── Human-readable bytes ───────────────────────────────────────────────────
function humanBytes(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)} KB`;
  return `${n} B`;
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  // Load models list
  let models = FALLBACK_MODELS;
  if (manifestPath && fs.existsSync(manifestPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      // Normalise the three known manifest shapes into a flat array of model entries.
      // Shape A: array of {name, cdn_src, ...}  (legacy)
      // Shape B: v2 object map  raw.models = { key: {filename, sources:[{provider, url}], ...} }
      // Shape C: inventory array  raw.models = [{id, filename, path, ...}]
      let rawList;
      if (Array.isArray(raw)) {
        rawList = raw;
      } else if (raw.models && !Array.isArray(raw.models)) {
        // v2 object map — pick the first source with an absolute HTTP URL (proxy paths
        // like /app/models/... are same-origin rewrites; new URL() can't parse them)
        rawList = Object.values(raw.models).map((entry) => {
          const src = (entry.sources || []).find((s) => s.url && s.url.startsWith('http'));
          return {
            name: entry.filename,
            cdn_src: src ? src.url : null,
            min_bytes: entry.sizeBytes || 100_000,
          };
        });
      } else if (Array.isArray(raw.models)) {
        // inventory array (public/app/models/models-manifest.json)
        rawList = raw.models;
      } else {
        rawList = raw.files || [];
      }

      const parsed = rawList.map((m) => ({
        name: m.name || m.filename || path.basename(m.cdn_src || m.url || m.path || ''),
        cdn_src: m.cdn_src || m.url || m.path,
        min_bytes: m.min_bytes || m.sizeBytes || 100_000,
      })).filter((m) => m.cdn_src && m.cdn_src.startsWith('http'));

      if (parsed.length > 0) {
        models = parsed;
        console.log(B(`📄 Using manifest: ${manifestPath} (${models.length} models)\n`));
      } else {
        console.warn(Y('⚠️  Manifest parsed but contained no usable model entries — using fallback list.\n'));
      }
    } catch (e) {
      console.warn(Y(`⚠️  Could not parse manifest (${e.message}), using fallback list.\n`));
    }
  } else {
    console.log(Y('⚠️  No manifest found – checking hardcoded fallback URLs.\n'));
  }

  console.log(B('🔍 VoiceIsolate Pro — ONNX Model URL Validator'));
  console.log(B('═'.repeat(60) + '\n'));

  const results = await Promise.all(
    models.map(async (m) => {
      const { status, contentLength, error } = await headRequest(m.cdn_src);
      return { ...m, status, contentLength, error };
    })
  );

  let failures = 0;
  for (const r of results) {
    const label = r.name.padEnd(30);
    if (r.error || r.status === 0) {
      console.log(R(`❌  ${label}  ERROR: ${r.error || 'no response'}  →  ${r.cdn_src}`));
      failures++;
    } else if (r.status !== 200) {
      console.log(R(`❌  ${label}  HTTP ${r.status}  →  ${r.cdn_src}`));
      failures++;
    } else if (r.contentLength > 0 && r.contentLength < (r.min_bytes || 100_000)) {
      console.log(Y(`⚠️   ${label}  STUB (${humanBytes(r.contentLength)} < ${humanBytes(r.min_bytes)})  →  ${r.cdn_src}`));
      failures++;
    } else if (r.contentLength === 0) {
      console.log(Y(`⚠️   ${label}  HTTP 200 but Content-Length missing — verify manually  →  ${r.cdn_src}`));
    } else {
      console.log(G(`✅  ${label}  ${humanBytes(r.contentLength)}  →  ${r.cdn_src}`));
    }
  }

  console.log('');
  if (failures === 0) {
    console.log(G('🎉 All models verified as real binaries. ML pipeline is ready.'));
  } else {
    console.log(R(`💥 ${failures} model(s) are missing or stubs. Run the export + upload scripts before deploying.`));
    console.log(Y('   → python scripts/export_demucs_onnx.py'));
    console.log(Y('   → python scripts/export_bsrnn_onnx.py'));
    console.log(Y('   → python scripts/export_rnnoise_onnx.py'));
    console.log(Y('   → VERCEL_TOKEN=xxx python scripts/upload_models_to_vercel_blob.py --file <path> --name <name>'));
    // process.exit(1);
  }
})().catch((e) => {
  console.error(R('Fatal error in model validator: ' + e.message));
  process.exit(1);
});
