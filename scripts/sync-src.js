#!/usr/bin/env node
/**
 * Copy canonical src/ → public/src/ for local dev and static /src/ imports.
 * Mirrors scripts/vercel-build.js without running full validation.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'public', 'src');

if (fs.existsSync(DEST)) {
  fs.rmSync(DEST, { recursive: true, force: true });
}
fs.cpSync(path.join(ROOT, 'src'), DEST, { recursive: true });
console.log('[sync-src] Copied src/ → public/src/');