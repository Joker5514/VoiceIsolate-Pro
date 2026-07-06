#!/usr/bin/env node
'use strict';

/**
 * Computes SHA-256 hashes for every AudioWorklet in scripts/worklet-manifest.json
 * and updates public/app/models-manifest.json worklets section.
 *
 * Run: pnpm worklets:hash
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REGISTRY = path.join(__dirname, 'worklet-manifest.json');
const MODELS_MANIFEST = path.join(ROOT, 'public', 'app', 'models-manifest.json');

const MANIFEST_KEYS = {
  'vip-gate': 'gate_processor',
  'vip-deesser': 'deesser_processor',
  'dsp-processor': 'dsp_processor',
};

function sha256(absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
const modelsDoc = JSON.parse(fs.readFileSync(MODELS_MANIFEST, 'utf8'));
if (!modelsDoc.worklets) modelsDoc.worklets = {};

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

  modelsDoc.worklets[key] = {
    filename,
    processorName: entry.processorName,
    role: entry.role,
    contentType: 'application/javascript',
    sources: [
      { provider: 'same-origin', url: entry.url, sha256: hash },
    ],
  };
}

modelsDoc._sha256_note = `SHA256 last updated: ${new Date().toISOString().slice(0, 10)}. Regenerate with: pnpm worklets:hash`;
fs.writeFileSync(MODELS_MANIFEST, `${JSON.stringify(modelsDoc, null, 2)}\n`, 'utf8');
console.log(`Updated ${path.relative(ROOT, MODELS_MANIFEST)}`);