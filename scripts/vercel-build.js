#!/usr/bin/env node
/**
 * Vercel production build — validation + copy src/ into public/src/
 * so ES-module imports (/src/pipeline/...) resolve on the static host.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DEST = path.join(ROOT, 'public', 'src');

process.env.VERCEL = '1';

const validate = spawnSync(process.execPath, [path.join(__dirname, 'validate.js')], {
  stdio: 'inherit',
  env: process.env,
});
if (validate.status !== 0) {
  process.exit(validate.status || 1);
}

if (fs.existsSync(DEST)) {
  fs.rmSync(DEST, { recursive: true, force: true });
}
fs.cpSync(path.join(ROOT, 'src'), DEST, { recursive: true });
console.log('[vercel-build] Copied src/ → public/src/');