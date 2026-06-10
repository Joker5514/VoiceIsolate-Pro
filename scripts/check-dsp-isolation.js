#!/usr/bin/env node
/**
 * check-dsp-isolation.js
 *
 * Hard-fails CI if any DSP-path file imports or references RevenueCat/Purchases.
 * This prevents billing/network code from leaking into the real-time or offline
 * audio path, preserving the 100% local audio-processing constraint.
 */

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const DSP_FILES = [
  'public/app/dsp-core.js',
  'public/app/dsp-processor.js',
  'public/app/ml-worker.js',
  'public/app/offline-processor.js',
  'public/app/pipeline-state.js',
  'src/workers/MLWorker.js',
  'src/pipeline/FileIngestion.js',
  'src/pipeline/PlaybackMixer.js',
  'src/core/BufferPool.js',
];

const FORBIDDEN = [
  /revenuecat/i,
  /api\.revenuecat\.com/i,
  /window\.Purchases\b/,
  /\bPurchases\b/,
  /purchasePackage\s*\(/,
  /restorePurchases\s*\(/,
  /getCustomerInfo\s*\(/,
];

let failed = false;

for (const rel of DSP_FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.warn(`[warn] missing DSP file in isolation check: ${rel}`);
    continue;
  }

  const src = fs.readFileSync(file, 'utf8');
  const hits = FORBIDDEN.filter((rx) => rx.test(src)).map((rx) => rx.toString());
  if (hits.length) {
    failed = true;
    console.error(`\n[FAIL] DSP isolation violated in ${rel}`);
    for (const hit of hits) console.error(`  - matched ${hit}`);
  } else {
    console.log(`[pass] ${rel}`);
  }
}

if (failed) {
  console.error('\nDSP isolation check failed. Remove all RevenueCat references from DSP files.');
  process.exit(1);
}

console.log('\nDSP isolation check passed.');
