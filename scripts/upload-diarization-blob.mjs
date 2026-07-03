#!/usr/bin/env node
/**
 * Upload diarization ONNX models to Vercel Blob (root pathnames).
 * Matches vercel.json rewrite: /models/:filename → blob/:filename
 *
 * Usage:
 *   BLOB_READ_WRITE_TOKEN=... node scripts/upload-diarization-blob.mjs
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = join(ROOT, 'public', 'models');

const FILES = [
  'pyannote-segmentation-3.0.onnx',
  'wespeaker-resnet34.onnx',
  'silero-vad.onnx',
];

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
if (!TOKEN) {
  console.error('ERROR: BLOB_READ_WRITE_TOKEN is required.');
  process.exit(1);
}

async function uploadBlob(name, buffer) {
  const res = await fetch(`https://blob.vercel-storage.com/${name}`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'x-vercel-blob-access': 'public',
    },
    body: buffer,
  });
  if (!res.ok) {
    throw new Error(`${name}: HTTP ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.url;
}

for (const name of FILES) {
  const path = join(MODELS_DIR, name);
  if (!existsSync(path)) {
    console.error(`Missing ${path} — run: pnpm models:diarization`);
    process.exit(1);
  }
  const buf = readFileSync(path);
  console.log(`Uploading ${name} (${(buf.length / 1e6).toFixed(1)} MB)…`);
  const url = await uploadBlob(name, buf);
  console.log(`  ✓ ${url}`);
}

console.log('\nDiarization models uploaded to Vercel Blob.');