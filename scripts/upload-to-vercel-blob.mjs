#!/usr/bin/env node
// scripts/upload-to-vercel-blob.mjs
// Uploads ONNX models in models/ to Vercel Blob storage and rewrites the
// `vercel-blob` source entries in public/app/models-manifest.json.
//
// NOTE: per the redundant-CDN design, manifest source[0].url stays as the
// `/app/models/<filename>` proxy path (the rewrite in vercel.json maps that
// to the actual blob CDN host). We do NOT store the raw blob CDN URL in the
// manifest — the proxy lets us swap blob stores without rebuilding clients.
//
// Required env var:
//   BLOB_READ_WRITE_TOKEN  – Vercel Blob read/write token
//
// Usage:
//   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_... node scripts/upload-to-vercel-blob.mjs
import { put } from '@vercel/blob';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, '..', 'public', 'app', 'models');
const MANIFEST_PATH = join(__dirname, '..', 'public', 'app', 'models-manifest.json');

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
if (!TOKEN) {
  console.error('ERROR: BLOB_READ_WRITE_TOKEN env var is not set.');
  console.error('Usage: BLOB_READ_WRITE_TOKEN=vercel_blob_rw_... node scripts/upload-to-vercel-blob.mjs');
  process.exit(1);
}

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found at ${MANIFEST_PATH}`);
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
}

function saveManifest(manifest) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nManifest updated: ${MANIFEST_PATH}`);
}

function listOnnxFiles() {
  if (!existsSync(MODELS_DIR)) {
    console.error(`ERROR: models/ directory not found at ${MODELS_DIR}`);
    process.exit(1);
  }
  return readdirSync(MODELS_DIR)
    .filter(name => name.endsWith('.onnx'))
    .filter(name => statSync(join(MODELS_DIR, name)).isFile());
}

async function main() {
  const manifest = loadManifest();
  if (!manifest.models) {
    throw new Error('Manifest has no `models` map (expected schemaVersion 2)');
  }

  const onnxFiles = listOnnxFiles();
  if (onnxFiles.length === 0) {
    console.warn('WARN: no .onnx files found in models/, nothing to upload.');
    return;
  }

  // Build filename → modelKey reverse lookup from manifest
  const filenameToKey = {};
  for (const [key, entry] of Object.entries(manifest.models)) {
    filenameToKey[entry.filename] = key;
  }

  for (const filename of onnxFiles) {
    const filePath = join(MODELS_DIR, filename);
    console.log(`Uploading ${filename} → vercel blob ...`);
    const buffer = readFileSync(filePath);
    const { url: blobUrl } = await put(filename, buffer, {
      access: 'public',
      contentType: 'application/octet-stream',
      addRandomSuffix: false,
      token: TOKEN,
    });
    console.log(`  raw blob URL: ${blobUrl}`);

    const modelKey = filenameToKey[filename];
    if (!modelKey) {
      console.warn(`  (no manifest entry for ${filename}, skipping manifest update)`);
      continue;
    }
    // Per design: manifest stays as the proxy path so vercel.json rewrite handles it.
    const proxyUrl = `/app/models/${filename}`;
    const sources = manifest.models[modelKey].sources || [];
    const blobSource = sources.find(s => s.provider === 'vercel-blob');
    if (blobSource) {
      blobSource.url = proxyUrl;
    } else {
      sources.unshift({ provider: 'vercel-blob', url: proxyUrl });
      manifest.models[modelKey].sources = sources;
    }
  }

  saveManifest(manifest);
  console.log('\nNext steps:');
  console.log('  1. Update vercel.json rewrite destination with your blob store hostname');
  console.log('     (the /app/models/:model proxy maps to https://<store>.public.blob.vercel-storage.com/models/:model)');
  console.log('  2. Commit public/app/models-manifest.json');
  console.log('  3. Push to deploy');
}

main().catch(err => {
  console.error('Upload failed:', err);
  process.exit(1);
});
