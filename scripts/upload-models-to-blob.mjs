#!/usr/bin/env node
// scripts/upload-models-to-blob.mjs
// Usage: BLOB_READ_WRITE_TOKEN=<token> node scripts/upload-models-to-blob.mjs
import { put } from '@vercel/blob';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, '..', 'public', 'app', 'models');

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
if (!TOKEN) {
  console.error('ERROR: BLOB_READ_WRITE_TOKEN env var is not set.');
  console.error('Run: BLOB_READ_WRITE_TOKEN=<token> node scripts/upload-models-to-blob.mjs');
  process.exit(1);
}

// Only blob-delivered models (not repo-committed ones).
// Committed: silero_vad.onnx, rnnoise_suppressor.onnx, bsrnn_vocals.onnx
// Blob-delivered: demucs_v4_quantized.onnx
const MODEL_FILES = [
  { key: 'demucs', filename: 'demucs_v4_quantized.onnx' },
];

async function uploadModels() {
  const uploaded = {};

  for (const { key, filename } of MODEL_FILES) {
    const filePath = join(MODELS_DIR, filename);
    if (!existsSync(filePath)) {
      console.warn(`WARN: ${filename} not found in public/app/models/ — skipping.`);
      continue;
    }
    console.log(`Uploading ${filename}...`);
    const fileBuffer = readFileSync(filePath);
    const { url } = await put(`models/${filename}`, fileBuffer, {
      access: 'public',
      contentType: 'application/octet-stream',
      addRandomSuffix: false,
      token: TOKEN,
    });
    console.log(`  => ${url}`);
    uploaded[key] = url;
  }

  console.log('\nUpload complete. Blob URLs:');
  for (const [key, url] of Object.entries(uploaded)) {
    console.log(`  ${key}: ${url}`);
  }
  console.log('\nNext steps:');
  console.log('  1. Run: python scripts/wire-blob-models.py to patch vercel.json rewrites');
  console.log('  2. Or manually replace <BLOB_DEMUCS_URL> in vercel.json with the URL above');
  console.log('  3. Commit vercel.json and push to trigger a Vercel redeploy');
}

uploadModels().catch(err => {
  console.error('Upload failed:', err);
  process.exit(1);
});
