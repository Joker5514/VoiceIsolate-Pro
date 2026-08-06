#!/usr/bin/env node
/**
 * Copy vip-sam-runtime + worker + marker into `build/` so Web, Android
 * (Capacitor webDir), and Electron packaged apps all include the SAM package.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');

function cpDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

function main() {
  if (!fs.existsSync(BUILD)) {
    console.warn('[ensure-sam] build/ missing — run pnpm build first or create build');
    fs.mkdirSync(BUILD, { recursive: true });
  }

  // Marker + docs for all surfaces
  const modelsDest = path.join(BUILD, 'app', 'models');
  fs.mkdirSync(modelsDest, { recursive: true });

  const markerSrc = path.join(ROOT, 'public', 'app', 'models', 'sam-runtime.marker.json');
  if (!fs.existsSync(markerSrc)) {
    // generate minimal marker
    fs.writeFileSync(
      path.join(modelsDest, 'sam-runtime.marker.json'),
      JSON.stringify({ packageId: 'vip-sam-runtime', bundled: true, version: '25.0.1' }, null, 2),
    );
  } else {
    fs.copyFileSync(markerSrc, path.join(modelsDest, 'sam-runtime.marker.json'));
  }

  // Runtime package (JS) for renderer diagnostics
  const pkgSrc = path.join(ROOT, 'packages', 'vip-sam-runtime');
  const pkgDest = path.join(BUILD, 'packages', 'vip-sam-runtime');
  if (fs.existsSync(pkgSrc)) cpDir(pkgSrc, pkgDest);

  // Worker sources for Electron extraResources staging
  const workerSrc = path.join(ROOT, 'services', 'sam-audio');
  const workerDest = path.join(BUILD, 'sam-audio');
  if (fs.existsSync(workerSrc)) {
    cpDir(workerSrc, workerDest);
  }

  // Copy optional onnx if present
  const onnx = path.join(ROOT, 'public', 'app', 'models', 'sam_audio.onnx');
  if (fs.existsSync(onnx)) {
    fs.copyFileSync(onnx, path.join(modelsDest, 'sam_audio.onnx'));
    console.log('[ensure-sam] included sam_audio.onnx in build');
  } else {
    console.log('[ensure-sam] sam_audio.onnx not present (optional); marker + worker still bundled');
  }

  console.log('[ensure-sam] SAM runtime package staged into build/ for web+android+desktop');
}

main();
