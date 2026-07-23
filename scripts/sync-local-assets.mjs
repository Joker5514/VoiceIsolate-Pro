#!/usr/bin/env node
// sync-local-assets.mjs
// Ensures all ML/ORT WASM assets required for offline/local execution
// are present under public/app before build. No network fetches occur
// here — this only verifies and reports on local asset availability
// to keep the app 100% local (no CDN/remote model hosts).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const REQUIRED_ASSETS = [
  'public/app/models/model.onnx',
  'public/app/ort/ort-wasm.wasm',
  'public/app/ort/ort-wasm-simd.wasm',
  'public/app/ort/ort.min.js',
];

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const missing = [];
  for (const rel of REQUIRED_ASSETS) {
    const abs = path.join(ROOT, rel);
    const ok = await exists(abs);
    if (!ok) missing.push(rel);
  }

  if (missing.length) {
    console.error('[sync-local-assets] Missing required local assets:');
    for (const m of missing) console.error('  - ' + m);
    console.error(
      '[sync-local-assets] All ML/ORT assets must be bundled locally. ' +
        'No remote/CDN fallback is permitted.'
    );
    process.exitCode = 1;
    return;
  }

  console.log('[sync-local-assets] All required local assets present.');
}

main();
