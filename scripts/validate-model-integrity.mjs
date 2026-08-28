#!/usr/bin/env node
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { MODEL_MANIFEST } from '../src/core/ModelManifest.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireBuild = process.argv.includes('--require-build');
const shipped = Object.values(MODEL_MANIFEST).filter((entry) =>
  entry.shipped !== false && entry.optional !== true && entry.sha256 && entry.sizeBytes);
let failures = 0;

function verifyFile(entry, deliveryPath) {
  if (!fs.existsSync(deliveryPath)) {
    console.error(`[models] ${entry.id}: missing delivery path ${path.relative(ROOT, deliveryPath)}`);
    failures++;
    return;
  }
  const bytes = fs.readFileSync(deliveryPath);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== entry.sizeBytes || actual !== entry.sha256) {
    console.error(`[models] ${entry.id}: expected size=${entry.sizeBytes} sha256=${entry.sha256}; actual size=${bytes.length} sha256=${actual}; delivery=${path.relative(ROOT, deliveryPath)}`);
    failures++;
    return;
  }
  console.log(`[models] ${entry.id}: verified ${path.relative(ROOT, deliveryPath)} ${actual}`);
}

for (const entry of shipped) {
  const relative = entry.url.replace(/^\/app\/models\//, '');
  verifyFile(entry, path.join(ROOT, 'public/app/models', relative));
  const built = path.join(ROOT, 'build/app/models', relative);
  if (requireBuild) verifyFile(entry, built);
}

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
for (const source of ['/app/models/:filename', '/models/:filename']) {
  const route = vercel.rewrites?.find((item) => item.source === source);
  if (!route || !/:filename$/.test(route.destination)) {
    console.error(`[models] rewrite ${source} does not preserve logical filename ownership`);
    failures++;
  }
}
if (failures) process.exit(1);
console.log(`[models] verified ${shipped.length} shipped manifest entries in source${requireBuild ? ' and build output' : ''}`);
