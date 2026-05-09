#!/usr/bin/env node
// scripts/upload-to-r2.mjs
// Uploads ONNX model files to Cloudflare R2 (S3-compatible) and rewrites the
// `r2` source URLs in public/app/models-manifest.json.
//
// Required env vars:
//   R2_ACCOUNT_ID         – Cloudflare account ID (from R2 dashboard)
//   R2_ACCESS_KEY_ID      – R2 API token Access Key
//   R2_SECRET_ACCESS_KEY  – R2 API token Secret
//   R2_BUCKET_NAME        – e.g. voice-isolate-models
//   R2_PUBLIC_URL         – Public base URL, e.g. https://models.voiceisolatepro.com
//                          or https://<bucket>.r2.dev
//
// Usage:
//   R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \
//   R2_BUCKET_NAME=voice-isolate-models R2_PUBLIC_URL=https://models.voiceisolatepro.com \
//   node scripts/upload-to-r2.mjs

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, '..', 'models');
const MANIFEST_PATH = join(__dirname, '..', 'public', 'app', 'models-manifest.json');

const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET_NAME', 'R2_PUBLIC_URL'];
const missing = REQUIRED.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`ERROR: Missing required env vars: ${missing.join(', ')}`);
  console.error('Usage: R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \\');
  console.error('       R2_BUCKET_NAME=voice-isolate-models R2_PUBLIC_URL=https://models.voiceisolatepro.com \\');
  console.error('       node scripts/upload-to-r2.mjs');
  process.exit(1);
}

const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET_NAME,
  R2_PUBLIC_URL,
} = process.env;

const PUBLIC_BASE = R2_PUBLIC_URL.replace(/\/+$/, '');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

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

async function uploadFile(filePath, key) {
  const body = readFileSync(filePath);
  const cmd = new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: 'application/octet-stream',
  });
  await s3.send(cmd);
  return `${PUBLIC_BASE}/${key}`;
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
    console.warn('WARN: no .onnx files found in models/ — nothing to upload.');
    return;
  }

  // Build filename → modelKey reverse lookup from manifest
  const filenameToKey = {};
  for (const [key, entry] of Object.entries(manifest.models)) {
    filenameToKey[entry.filename] = key;
  }

  for (const filename of onnxFiles) {
    const filePath = join(MODELS_DIR, filename);
    const r2Key = `models/${filename}`;
    console.log(`Uploading ${filename} → r2://${R2_BUCKET_NAME}/${r2Key} ...`);
    const url = await uploadFile(filePath, r2Key);
    console.log(`  → ${url}`);

    const modelKey = filenameToKey[filename];
    if (!modelKey) {
      console.warn(`  (no manifest entry for ${filename}, skipping manifest update)`);
      continue;
    }
    const sources = manifest.models[modelKey].sources || [];
    const r2Source = sources.find(s => s.provider === 'r2');
    if (r2Source) {
      r2Source.url = url;
    } else {
      sources.push({ provider: 'r2', url });
      manifest.models[modelKey].sources = sources;
    }
  }

  saveManifest(manifest);
  console.log('\nNext steps:');
  console.log('  1. Commit public/app/models-manifest.json');
  console.log('  2. Verify CSP in vercel.json includes the R2 host');
  console.log('  3. Push to deploy');
}

main().catch(err => {
  console.error('Upload failed:', err);
  process.exit(1);
});
