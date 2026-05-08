#!/usr/bin/env node
// scripts/upload-models-to-blob.mjs
// Usage: BLOB_READ_WRITE_TOKEN=<token> node scripts/upload-models-to-blob.mjs
import { put } from '@vercel/blob';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = join(__dirname, '..', 'models');
const MANIFEST_PATH = join(__dirname, '..', 'public', 'app', 'models-manifest.json');

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;
if (!TOKEN) {
  console.error('ERROR: BLOB_READ_WRITE_TOKEN env var is not set.');
  console.error('Run: BLOB_READ_WRITE_TOKEN=<token> node scripts/upload-models-to-blob.mjs');
  process.exit(1);
}

const MODEL_FILES = [
  { key: 'demucs',     filename: 'demucs_v4_quantized.onnx' },
  { key: 'bsrnn',      filename: 'bsrnn_quantized.onnx' },
  { key: 'rnnoise',    filename: 'rnnoise.onnx' },
  { key: 'nsnet2',     filename: 'nsnet2.onnx' },
  { key: 'silero_vad', filename: 'silero_vad.onnx' },
];

async function uploadModels() {
  const manifest = {};

  for (const { key, filename } of MODEL_FILES) {
    const filePath = join(MODELS_DIR, filename);
    if (!existsSync(filePath)) {
      console.warn(`WARN: ${filename} not found in models/ — skipping.`);
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
    manifest[key] = url;
  }

  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`\nManifest written to ${MANIFEST_PATH}`);
  console.log('Next steps:');
  console.log('  1. Commit public/app/models-manifest.json');
  console.log('  2. Update vercel.json rewrite destination with your blob store hostname');
  console.log('  3. Push to main — Vercel will auto-deploy');
}

uploadModels().catch(err => {
  console.error('Upload failed:', err);
  process.exit(1);
});
