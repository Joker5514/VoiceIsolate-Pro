#!/usr/bin/env node
/**
 * scripts/setup-three.js
 * ----------------------
 * Copies three.module.min.js from node_modules/three/build/ into public/lib/
 * so index.html can load Three.js 0.184.0 via importmap without a CDN.
 *
 * Run automatically via package.json "postinstall" hook.
 * Safe to re-run: skipped silently if the file is already committed to the repo.
 */

const { existsSync, copyFileSync, mkdirSync } = require('fs');
const { join, dirname } = require('path');

const ROOT = join(__dirname, '..');
const SRC  = join(ROOT, 'node_modules', 'three', 'build', 'three.module.min.js');
const DEST = join(ROOT, 'public', 'lib', 'three.module.min.js');

if (existsSync(DEST)) {
  console.info('[setup-three] three.module.min.js already present in public/lib/ — skipping copy');
  process.exit(0);
}

if (!existsSync(SRC)) {
  console.warn(
    '[setup-three] node_modules/three/build/three.module.min.js not found.\n' +
    '              Run `pnpm install` first or commit public/lib/three.module.min.js to the repo.'
  );
  process.exit(0); // non-fatal: app degrades gracefully when THREE is unavailable (3D spectrogram hidden)
}

if (!existsSync(dirname(DEST))) {
  mkdirSync(dirname(DEST), { recursive: true });
}

copyFileSync(SRC, DEST);
console.info('[setup-three] Copied three.module.min.js (three@0.184.0) → public/lib/');
