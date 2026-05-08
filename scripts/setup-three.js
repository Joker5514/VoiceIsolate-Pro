#!/usr/bin/env node
/**
 * scripts/setup-three.js
 * ----------------------
 * Copies Three.js 0.184.0 build artifacts from node_modules/three/build/ into
 * public/lib/ so index.html can load Three.js via importmap without a CDN.
 *
 * three.module.min.js (ESM entry) imports ./three.core.min.js at runtime, so
 * both sidecar files must be present in public/lib/ together.
 *
 * Run automatically via package.json "postinstall" hook.
 * Safe to re-run: skipped silently if all files are already committed to the repo.
 */

const { existsSync, copyFileSync, mkdirSync } = require('fs');
const { join } = require('path');

const ROOT   = join(__dirname, '..');
const SRC_DIR = join(ROOT, 'node_modules', 'three', 'build');
const LIB_DIR = join(ROOT, 'public', 'lib');

// Files required by the importmap ESM approach:
// three.module.min.js is the ESM entry; three.core.min.js is its sidecar.
const FILES = ['three.module.min.js', 'three.core.min.js'];

if (FILES.every(f => existsSync(join(LIB_DIR, f)))) {
  console.info('[setup-three] Three.js files already present in public/lib/ — skipping copy');
  process.exit(0);
}

if (!existsSync(SRC_DIR)) {
  console.error(
    '[setup-three] node_modules/three/build/ not found.\n' +
    '              Run `pnpm install` first or commit the public/lib/three*.min.js files to the repo.'
  );
  process.exit(1); // fatal at install time: ensures public/lib/ is fully provisioned before deploy
}

mkdirSync(LIB_DIR, { recursive: true });

for (const file of FILES) {
  const src  = join(SRC_DIR, file);
  const dest = join(LIB_DIR, file);
  if (existsSync(dest)) {
    console.info(`[setup-three] ${file} already present — skipping`);
    continue;
  }
  if (!existsSync(src)) {
    console.error(`[setup-three] Required file not found in node_modules: ${src}`);
    process.exit(1);
  }
  try {
    copyFileSync(src, dest);
    console.info(`[setup-three] Copied ${file} (three@0.184.0) → public/lib/`);
  } catch (err) {
    console.error(`[setup-three] Failed to copy ${file}: ${err.message}`);
    process.exit(1);
  }
}
