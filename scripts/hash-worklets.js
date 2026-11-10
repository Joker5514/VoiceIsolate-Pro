#!/usr/bin/env node
'use strict';

/**
 * Computes SHA-256 hashes for every AudioWorklet in scripts/worklet-manifest.json
 * and updates public/app/models-manifest.json worklets section.
 *
 * Run: pnpm worklets:hash
 */

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(__dirname, 'worklet-manifest.json');
const MODELS_MANIFEST = path.join(ROOT, 'public', 'app', 'models-manifest.json');

const MANIFEST_KEYS = {
  'vip-gate': 'gate_processor',
  'vip-true-peak-limiter': 'true_peak_limiter_processor',
  'vip-deesser': 'deesser_processor',
  'dsp-processor': 'dsp_processor',
};

/** LF-normalized digest — matches git blobs and Linux CI (avoids CRLF drift on Windows). */
function sha256(absPath) {
  const normalized = fs.readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));


console.log('🔊 Worklet SHA-256 hashes\n');

for (const entry of registry.worklets) {
  const abs = path.join(ROOT, entry.source);
  if (!fs.existsSync(abs)) {
    console.error(`NOT FOUND: ${entry.source}`);
    process.exitCode = 1;
    continue;
  }
  const hash = sha256(abs);
  const key = MANIFEST_KEYS[entry.id] || entry.id;
  const filename = path.basename(entry.source);

  console.log(`${entry.name} (${entry.url})`);
  console.log(`  sha256: ${hash}`);
  console.log(`  bytes:  ${fs.statSync(abs).size}\n`);


}

// Regenerate packaging projections from the canonical model registry.
// CommonJS CLI invokes the ESM generator synchronously (no top-level await).
const generated = spawnSync(process.execPath, [path.join(__dirname, 'generate-model-manifests.mjs')], {
  cwd: ROOT, stdio: 'inherit',
});
if (generated.error || generated.status !== 0) {
  console.error(generated.error?.message || 'Model manifest generation failed');
  process.exit(generated.status || 1);
}