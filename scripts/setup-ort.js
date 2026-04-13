#!/usr/bin/env node
/**
 * scripts/setup-ort.js
 * --------------------
 * Copies onnxruntime-web dist assets from node_modules into public/lib/
 * so ml-worker.js can importScripts('/lib/ort.min.js') and the browser
 * can load the WASM binaries at /lib/ort-wasm*.wasm.
 *
 * Run automatically via package.json "postinstall" hook.
 * Safe to re-run: existing files are overwritten.
 *
 * NOTE: Written as ESM to match package.json "type": "module"
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const ROOT     = join(__dirname, '..');
const SRC_DIR  = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const DEST_DIR = join(ROOT, 'public', 'lib');

// Guard: onnxruntime-web must be installed
if (!existsSync(SRC_DIR)) {
  console.warn(
    '[setup-ort] node_modules/onnxruntime-web/dist not found.\n' +
    '            Run `pnpm install` first, then re-run this script.'
  );
  process.exit(0);
}

// Create public/lib/ if needed
if (!existsSync(DEST_DIR)) {
  mkdirSync(DEST_DIR, { recursive: true });
  console.info('[setup-ort] Created directory:', DEST_DIR);
}

const files  = readdirSync(SRC_DIR);
let copied   = 0;
let skipped  = 0;

for (const file of files) {
  const isOrtMin  = file === 'ort.min.js' || file === 'ort.min.js.map';
  const isWasm    = file.endsWith('.wasm');
  const isOrtCore = file === 'ort.js' || file === 'ort.js.map';

  if (!isOrtMin && !isWasm && !isOrtCore) {
    skipped++;
    continue;
  }

  const src  = join(SRC_DIR, file);
  const dest = join(DEST_DIR, file);
  copyFileSync(src, dest);
  console.info(`[setup-ort]   copied → public/lib/${file}`);
  copied++;
}

console.info(`[setup-ort] Done. ${copied} file(s) copied, ${skipped} skipped.`);

if (copied === 0) {
  console.warn(
    '[setup-ort] WARNING: No files were copied. Check that onnxruntime-web@1.17.0\n' +
    '            is installed and dist/ contains ort.min.js / *.wasm files.'
  );
}
