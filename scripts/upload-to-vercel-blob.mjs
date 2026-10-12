#!/usr/bin/env node
// scripts/upload-to-vercel-blob.mjs
// Uploads ONNX models in public/app/models/ to Vercel Blob storage and points
// the `vercel-blob` source entries in public/app/models-manifest.json at the
// `/app/models/<filename>` proxy path (vercel.json maps that to the blob CDN;
// the raw CDN URL is never stored, so blob stores can be swapped).
//
// Explicit provisioning only — never run from server start-up:
//   node scripts/upload-to-vercel-blob.mjs            # plan: no token, no network, no writes
//   BLOB_READ_WRITE_TOKEN=… node scripts/upload-to-vercel-blob.mjs --yes
//   … --yes --force                                   # re-upload blobs that already exist
//
// Idempotent: a file whose blob already exists with the same size is skipped,
// and the manifest is rewritten only when an entry actually changes. Every
// file with a pinned sha256 in src/core/ModelManifest.js must match it before
// it is uploaded.
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MODELS_DIR = join(ROOT, 'public', 'app', 'models');
const MANIFEST_PATH = join(ROOT, 'public', 'app', 'models-manifest.json');

const args = new Set(process.argv.slice(2));
const CONFIRMED = args.has('--yes');
const FORCE = args.has('--force');

function listOnnxFiles() {
  if (!existsSync(MODELS_DIR)) throw new Error(`models directory not found at ${MODELS_DIR}`);
  return readdirSync(MODELS_DIR)
    .filter((name) => name.endsWith('.onnx'))
    .filter((name) => statSync(join(MODELS_DIR, name)).isFile());
}

async function pinnedHashes() {
  const { MODEL_MANIFEST } = await import(pathToFileURL(join(ROOT, 'src/core/ModelManifest.js')).href);
  const byFile = {};
  for (const entry of Object.values(MODEL_MANIFEST)) {
    if (entry?.url && entry.sha256) byFile[entry.url.split('/').pop()] = entry.sha256;
  }
  return byFile;
}

async function main() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  if (!manifest.models) throw new Error('Manifest has no `models` map (expected schemaVersion 2)');
  const before = JSON.stringify(manifest);
  const filenameToKey = {};
  for (const [key, entry] of Object.entries(manifest.models)) filenameToKey[entry.filename] = key;

  const files = listOnnxFiles();
  if (!files.length) {
    console.warn('WARN: no .onnx files found, nothing to upload.');
    return;
  }
  const pins = await pinnedHashes();
  const plan = [];
  for (const filename of files) {
    const buffer = readFileSync(join(MODELS_DIR, filename));
    const sha = createHash('sha256').update(buffer).digest('hex');
    if (pins[filename] && pins[filename] !== sha) {
      throw new Error(`${filename}: sha256 ${sha} does not match ModelManifest pin ${pins[filename]}; refusing to publish.`);
    }
    plan.push({ filename, buffer, sha, size: buffer.length, pinned: Boolean(pins[filename]) });
  }

  if (!CONFIRMED) {
    console.log('Plan (dry run — pass --yes to upload; no network calls were made):');
    for (const p of plan) console.log(`  ${p.filename}  ${p.size} bytes  sha256 ${p.sha}${p.pinned ? ' (pinned)' : ''}`);
    return;
  }
  const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
  if (!TOKEN) throw new Error('BLOB_READ_WRITE_TOKEN is not set.');
  const { put, list } = await import('@vercel/blob');

  for (const p of plan) {
    const existing = (await list({ prefix: p.filename, token: TOKEN })).blobs
      .find((b) => b.pathname === p.filename);
    if (existing && existing.size === p.size && !FORCE) {
      console.log(`skip ${p.filename} (already uploaded, ${p.size} bytes)`);
    } else {
      console.log(`upload ${p.filename} → vercel blob …`);
      await put(p.filename, p.buffer, {
        access: 'public',
        contentType: 'application/octet-stream',
        addRandomSuffix: false,
        token: TOKEN,
      });
    }
    const modelKey = filenameToKey[p.filename];
    if (!modelKey) continue;
    const proxyUrl = `/app/models/${p.filename}`;
    const sources = manifest.models[modelKey].sources || [];
    const blobSource = sources.find((s) => s.provider === 'vercel-blob');
    if (blobSource) blobSource.url = proxyUrl;
    else {
      sources.unshift({ provider: 'vercel-blob', url: proxyUrl });
      manifest.models[modelKey].sources = sources;
    }
  }

  if (JSON.stringify(manifest) !== before) {
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(`Manifest updated: ${MANIFEST_PATH} — review and commit it.`);
  } else {
    console.log('Manifest unchanged.');
  }
}

main().catch((err) => {
  console.error('Upload failed:', err?.message || err);
  process.exit(1);
});
