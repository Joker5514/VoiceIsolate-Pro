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
 */

const { existsSync, mkdirSync, copyFileSync, readdirSync } = require('fs');
const { join } = require('path');

const ROOT     = join(__dirname, '..');
const SRC_DIR  = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const DEST_DIR = join(ROOT, 'public', 'lib');

const SOFT = process.env.VIP_ORT_SETUP_SOFT === '1';

// Guard: onnxruntime-web must be installed
if (!existsSync(SRC_DIR)) {
  const msg =
    '[setup-ort] node_modules/onnxruntime-web/dist not found.\n' +
    '            Run `pnpm install` (or `npm install`) first, then re-run this script.';
  if (SOFT) {
    console.warn(msg + '\n[setup-ort] VIP_ORT_SETUP_SOFT=1 set — exiting 0 without copying.');
    process.exit(0);
  }
  console.error(msg);
  console.error('[setup-ort] FATAL: cannot copy ONNX Runtime assets. Set VIP_ORT_SETUP_SOFT=1 to bypass.');
  process.exit(1);
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

const ortMinPath = join(DEST_DIR, 'ort.min.js');
if (!existsSync(ortMinPath)) {
  const msg =
    '[setup-ort] ort.min.js was NOT written to public/lib/.\n' +
    '            Check that onnxruntime-web is installed and dist/ contains ort.min.js / *.wasm files.';
  if (SOFT) {
    console.warn(msg + '\n[setup-ort] VIP_ORT_SETUP_SOFT=1 set — exiting 0 anyway.');
    process.exit(0);
  }
  console.error(msg);
  console.error('[setup-ort] FATAL: ort.min.js missing after copy. Set VIP_ORT_SETUP_SOFT=1 to bypass.');
  process.exit(1);
}
