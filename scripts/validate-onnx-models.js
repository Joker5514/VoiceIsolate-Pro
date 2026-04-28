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

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Colours ────────────────────────────────────────────────────────────────
const G = (s) => `\x1b[32m${s}\x1b[0m`;
const Y = (s) => `\x1b[33m${s}\x1b[0m`;
const R = (s) => `\x1b[31m${s}\x1b[0m`;
const B = (s) => `\x1b[36m${s}\x1b[0m`;

// ── Fallback model list (used when no manifest found) ──────────────────────
const FALLBACK_MODELS = [
  {
    name: 'silerovad.onnx',
    cdn_src: 'https://huggingface.co/datasets/Joker5514/models/resolve/main/silerovad.onnx',
    min_bytes: 100_000,   // ~2.2 MB real
  },
  {
    name: 'rnnoisesuppressor.onnx',
    cdn_src: 'https://huggingface.co/datasets/Joker5514/models/resolve/main/rnnoisesuppressor.onnx',
    min_bytes: 100_000,   // ~180 KB real
  },
  {
    name: 'demucsv4quantized.onnx',
    cdn_src: 'https://huggingface.co/datasets/Joker5514/models/resolve/main/demucsv4quantized.onnx',
    min_bytes: 10_000_000, // ~83 MB real
  },
  {
    name: 'bsrnnvocals.onnx',
    cdn_src: 'https://huggingface.co/datasets/Joker5514/models/resolve/main/bsrnnvocals.onnx',
    min_bytes: 10_000_000, // ~45 MB real
  },
];

// ── Parse CLI args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const manifestFlag = args.indexOf('--manifest');
let manifestPath = manifestFlag !== -1 ? args[manifestFlag + 1] : null;

// Auto-detect manifest
if (!manifestPath) {
  const candidates = [
    path.resolve(__dirname, '../public/app/models-manifest.json'),
    path.resolve(__dirname, '../models-manifest.json'),
  ];
  manifestPath = candidates.find((p) => fs.existsSync(p)) || null;
}

// ── Load models list ───────────────────────────────────────────────────────
let models = FALLBACK_MODELS;
if (manifestPath && fs.existsSync(manifestPath)) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // Support both array format and { models: [] } wrapper
    const list = Array.isArray(raw) ? raw : (raw.models || raw.files || FALLBACK_MODELS);
    if (list.length > 0) {
      models = list.map((m) => ({
        name: m.name || m.filename || path.basename(m.cdn_src || m.url || ''),
        cdn_src: m.cdn_src || m.url,
        min_bytes: m.min_bytes || 100_000,
      })).filter((m) => m.cdn_src);
      console.log(B(`📄 Using manifest: ${manifestPath} (${models.length} models)\n`));
    }
  } catch (e) {
    console.warn(Y(`⚠️  Could not parse manifest (${e.message}), using fallback list.\n`));
  }
} else {
  console.log(Y(`⚠️  No manifest found – checking hardcoded fallback URLs.\n`));
}

// ── HEAD request helper ────────────────────────────────────────────────────
function headRequest(urlStr, redirects = 5) {
  return new Promise((resolve) => {
    const parsed = new URL(urlStr);
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = mod.request(
      { method: 'HEAD', hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { 'User-Agent': 'VoiceIsolate-ModelValidator/1.0' } },
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
    req.setTimeout(15_000, () => { req.destroy(); resolve({ status: 0, contentLength: 0, url: urlStr, error: 'timeout' }); });
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
    // HuggingFace sometimes omits Content-Length on large LFS files; treat as soft warning
    console.log(Y(`⚠️   ${label}  HTTP 200 but Content-Length missing (LFS redirect?) — verify manually  →  ${r.cdn_src}`));
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
  console.log(Y('   → python scripts/upload_models_to_huggingface.py'));
  process.exit(1);
}
