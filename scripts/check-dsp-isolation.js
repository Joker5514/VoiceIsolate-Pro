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
  'src/core/stft-math.js',
  'src/core/SpectralCleanup.js',
  'src/core/UniversalSourceMatrix.js',
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

/** Symmetric Hann (N-1) is banned in STFT owners that must match DSPCore COLA. */
const SYMMETRIC_HANN = /cos\(\s*\(?\s*2\s*\*\s*Math\.PI\s*\*\s*i\s*\)?\s*\/\s*\(?\s*[nN]\s*-\s*1\s*\)?\s*\)/;
const STFT_WINDOW_FILES = [
  'src/core/stft-math.js',
  'src/core/SpectralCleanup.js',
  'src/core/UniversalSourceMatrix.js',
  'public/app/dsp-core.js',
  'public/app/fft-bridge.js',
  'public/app/dsp-bootstrap.js',
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

console.log('\nSTFT window contract (periodic Hann):');
for (const rel of STFT_WINDOW_FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.warn(`[warn] missing STFT file: ${rel}`);
    continue;
  }
  const src = fs.readFileSync(file, 'utf8');
  if (SYMMETRIC_HANN.test(src)) {
    failed = true;
    console.error(`[FAIL] symmetric Hann (N-1) found in ${rel}`);
  } else {
    console.log(`[pass] ${rel} (no symmetric N-1 Hann)`);
  }
}

const stftMath = path.join(ROOT, 'src/core/stft-math.js');
if (fs.existsSync(stftMath)) {
  const src = fs.readFileSync(stftMath, 'utf8');
  if (!/export function periodicHann/.test(src)) {
    failed = true;
    console.error('[FAIL] stft-math.js missing export function periodicHann');
  } else {
    console.log('[pass] stft-math.js exports periodicHann');
  }
} else {
  failed = true;
  console.error('[FAIL] src/core/stft-math.js missing');
}

if (failed) {
  console.error('\nDSP isolation check failed. Fix billing leaks and/or STFT window contracts.');
  process.exit(1);
}

console.log('\nDSP isolation check passed.');
