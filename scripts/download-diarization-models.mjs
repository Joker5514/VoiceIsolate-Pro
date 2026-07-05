#!/usr/bin/env node
/**
 * Download ONNX diarization models into public/models/
 * Run: node scripts/download-diarization-models.mjs
 */
import { mkdir, copyFile, access, writeFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'models');

const MODELS = [
  {
    name: 'pyannote-segmentation-3.0.onnx',
    url: 'https://huggingface.co/onnx-community/pyannote-segmentation-3.0/resolve/main/onnx/model.onnx',
  },
  {
    name: 'wespeaker-resnet34.onnx',
    url: 'https://huggingface.co/onnx-community/wespeaker-voxceleb-resnet34-LM/resolve/main/onnx/model.onnx',
  },
];

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

await mkdir(OUT, { recursive: true });

const sileroLocal = join(ROOT, 'public', 'app', 'models', 'silero_vad.onnx');
const sileroOut = join(OUT, 'silero-vad.onnx');
if (await exists(sileroLocal) && !(await exists(sileroOut))) {
  await copyFile(sileroLocal, sileroOut);
  console.log('✓ Linked silero-vad.onnx from app models');
}

for (const { name, url } of MODELS) {
  const dest = join(OUT, name);
  if (await exists(dest)) {
    console.log(`✓ Present  ${name}`);
    continue;
  }
  console.log(`⬇ Downloading ${name}…`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`✗ Failed ${name}: HTTP ${res.status}`);
    process.exitCode = 1;
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 100000) {
    console.error(`✗ Stub/too small ${name} (${buf.length} bytes)`);
    process.exitCode = 1;
    continue;
  }
  await writeFile(dest, buf);
  console.log(`✓ Saved   ${name} (${(buf.length / 1e6).toFixed(1)} MB)`);
}