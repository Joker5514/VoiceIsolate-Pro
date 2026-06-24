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
 * SOFT MODE: If VIP_ORT_SETUP_SOFT=1 OR all expected files already exist
 * in public/lib/ (i.e. they are committed to the repo), the script exits 0
 * without attempting to copy from node_modules. This is the production path
 * on Vercel where the WASM files are committed directly to the repository.
 */

const { existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync } = require('fs');
const { join } = require('path');

const ROOT     = join(__dirname, '..');
const SRC_DIR  = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist');
const DEST_DIR = join(ROOT, 'public', 'lib');

// The set of files we expect when ORT WASM is committed to the repo.
// If ALL of these exist in public/lib/, we skip the copy entirely.
const EXPECTED_COMMITTED = [
  'ort.min.js',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.asyncify.wasm',
  // Each .wasm has a paired ES-module loader that ORT fetches at runtime —
  // without these the wasm backend fails with 'no available backend found'.
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jspi.mjs',
  'ort-wasm-simd-threaded.asyncify.mjs',
];

const SOFT_ENV = process.env.VIP_ORT_SETUP_SOFT === '1';

// Auto-detect soft mode: if all committed WASM files already exist, skip copy.
const allCommitted = EXPECTED_COMMITTED.every((f) => existsSync(join(DEST_DIR, f)));

if (allCommitted) {
  console.info('[setup-ort] Skipping copy — all ORT files already present in public/lib/');
  EXPECTED_COMMITTED.forEach((f) =>
    console.info(`[setup-ort]   ✓ ${f} (${existsSync(join(DEST_DIR, f)) ? 'present' : 'MISSING'})`)
  );
  process.exit(0);
}

if (SOFT_ENV) {
  console.info('[setup-ort] VIP_ORT_SETUP_SOFT=1 set, but committed ORT file set is incomplete; attempting copy from node_modules.');
  EXPECTED_COMMITTED.forEach((f) =>
    console.info(`[setup-ort]   ✓ ${f} (${existsSync(join(DEST_DIR, f)) ? 'present' : 'MISSING'})`)
  );
}

// Files this script owns in DEST_DIR. Anything matching these patterns is
// removed before copying so that wasm/JS files dropped between ORT releases
// don't accumulate as stale 30 MB artifacts. Non-ORT files (three.module.min.js,
// README.md, .gitkeep) do not match and are preserved.
// three.module.min.js (Three.js 0.184.0 ESM build) is managed by setup-three.js.
const OWNED_PATTERNS = [
  /^ort-wasm[^/]*\.wasm$/,
  /^ort\.js$/,
  /^ort\.js\.map$/,
  /^ort\.min\.js$/,
  /^ort\.min\.js\.map$/,
];

// Guard: onnxruntime-web must be installed
if (!existsSync(SRC_DIR)) {
  console.error(
    '[setup-ort] node_modules/onnxruntime-web/dist not found.\n' +
    '            Run `pnpm install` (or `npm install`) first, then re-run this script.\n' +
    '[setup-ort] FATAL: cannot copy ONNX Runtime assets.'
  );
  process.exit(1);
}

// Create public/lib/ if needed
if (!existsSync(DEST_DIR)) {
  mkdirSync(DEST_DIR, { recursive: true });
  console.info('[setup-ort] Created directory:', DEST_DIR);
}

// Pre-clean owned ORT artifacts so removed-between-releases files don't linger
let removed = 0;
for (const f of readdirSync(DEST_DIR)) {
  if (OWNED_PATTERNS.some((re) => re.test(f))) {
    unlinkSync(join(DEST_DIR, f));
    removed++;
  }
}
if (removed > 0) console.info(`[setup-ort] Removed ${removed} stale ORT artifact(s) before copy.`);

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
  console.error(
    '[setup-ort] ort.min.js was NOT written to public/lib/.\n' +
    '            Check that onnxruntime-web is installed and dist/ contains ort.min.js / *.wasm files.\n' +
    '[setup-ort] FATAL: ort.min.js missing after copy.'
  );
  process.exit(1);
}
