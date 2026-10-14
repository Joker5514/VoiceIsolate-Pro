#!/usr/bin/env node
/**
 * pnpm models:fetch-ecapa
 *
 * Downloads the optional ECAPA-TDNN speaker-embedding model from the pinned
 * Hugging Face commit in ModelManifest.ecapa_tdnn.source and installs it at
 * public/app/models/ecapa_tdnn.onnx only if its size and SHA-256 match the
 * manifest. The file is git-ignored; run `pnpm build` afterwards so build/
 * (Android, Electron) picks it up.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODEL_MANIFEST } from '../src/core/ModelManifest.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = MODEL_MANIFEST.ecapa_tdnn;
const dest = path.join(ROOT, 'public', entry.url.replace(/^\//, ''));
const { repo, revision, file } = entry.source;
const url = `https://huggingface.co/${repo}/resolve/${revision}/${file}`;

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

if (fs.existsSync(dest) && sha(fs.readFileSync(dest)) === entry.sha256) {
  console.log(`[ecapa] already installed and verified: ${path.relative(ROOT, dest)}`);
  process.exit(0);
}

console.log(`[ecapa] downloading ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`[ecapa] download failed: HTTP ${res.status}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const digest = sha(buf);
if (buf.length !== entry.sizeBytes || digest !== entry.sha256) {
  console.error(`[ecapa] REFUSED: got ${buf.length} bytes sha256 ${digest}, manifest pins ${entry.sizeBytes} bytes ${entry.sha256}`);
  process.exit(1);
}
const tmp = `${dest}.${process.pid}.tmp`;
fs.writeFileSync(tmp, buf);
fs.renameSync(tmp, dest);
console.log(`[ecapa] installed ${path.relative(ROOT, dest)} (${buf.length} bytes, sha256 verified). Run pnpm build to include it in build/.`);
