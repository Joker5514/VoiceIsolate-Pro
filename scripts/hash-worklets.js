#!/usr/bin/env node
'use strict';

// Computes and prints the SHA-256 hash of each AudioWorklet file.
// Run via: node scripts/hash-worklets.js
// Or:      pnpm run worklets:hash
//
// Update the sha256 fields in public/app/models-manifest.json whenever
// any worklet file changes (e.g. after patching dsp-processor.js).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const WORKLETS = [
  'public/app/dsp-processor.js',
];

const root = path.resolve(__dirname, '..');

for (const rel of WORKLETS) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    console.error(`NOT FOUND: ${rel}`);
    process.exitCode = 1;
    continue;
  }
  const buf = fs.readFileSync(abs);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  console.log(`${path.basename(rel)}: ${hash}`);
}
