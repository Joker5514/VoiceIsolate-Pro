#!/usr/bin/env node
/**
 * Compatibility wrapper. `scripts/generate-model-manifests.mjs` is the only
 * packaging generator (`pnpm models:manifests`). This entry point remains so
 * older docs and checks that call `sync-model-manifests.mjs --check` hit the
 * same projection, including the shipped DeepFilterNet3 parts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkModelManifests, generateModelManifests } from './generate-model-manifests.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const check = process.argv.includes('--check');
  if (check) {
    const errors = checkModelManifests(ROOT);
    if (errors.length) {
      errors.forEach((error) => console.error(`[sync-model-manifests] ${error}`));
      console.error('  run: node scripts/generate-model-manifests.mjs');
      process.exit(1);
    }
    console.log('[sync-model-manifests] OK — packaging registry matches ModelManifest.js');
    return;
  }
  for (const [rel, text] of generateModelManifests(ROOT)) {
    fs.writeFileSync(path.join(ROOT, rel), text);
    console.log(`[sync-model-manifests] wrote ${rel}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
