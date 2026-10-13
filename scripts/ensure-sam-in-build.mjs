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
      JSON.stringify({ packageId: 'vip-sam-runtime', bundled: true, version: '25.0.2' }, null, 2),
    );
  } else {
    fs.copyFileSync(markerSrc, path.join(modelsDest, 'sam-runtime.marker.json'));
  }

  // Runtime package (JS) for renderer diagnostics
  const pkgSrc = path.join(ROOT, 'packages', 'vip-sam-runtime');
  const pkgDest = path.join(BUILD, 'packages', 'vip-sam-runtime');
  if (fs.existsSync(pkgSrc)) cpDir(pkgSrc, pkgDest);

  // The Python worker and the shared FFmpeg build are desktop-only. Electron
  // ships them through electron-builder extraResources (services/sam-audio →
  // resources/sam-audio); staging them here put a Python server and an
  // unpinned GPL FFmpeg distribution into the Android APK (Capacitor webDir)
  // and into app.asar, where nothing can execute them. Remove leftovers from
  // older builds so they cannot reach a package.
  for (const stale of ['sam-audio', 'ffmpeg-shared']) {
    fs.rmSync(path.join(BUILD, stale), { recursive: true, force: true });
  }

  // No loader consumes sam_audio.onnx (the manifest entry has no pinned hash
  // and no prompt-input contract), so it is not staged for any package.
  if (fs.existsSync(path.join(ROOT, 'public', 'app', 'models', 'sam_audio.onnx'))) {
    console.warn('[ensure-sam] public/app/models/sam_audio.onnx present but unused: no SAM-Audio ONNX loader exists');
  }

  // ── SAM 3 vision sidecar (all platforms — feature-flagged, not audio) ──
  // build.mjs already copies src/ → build/src/; re-assert marker + public entry.
  const sam3Src = path.join(ROOT, 'src', 'sam3_integration');
  const sam3Dest = path.join(BUILD, 'src', 'sam3_integration');
  if (fs.existsSync(sam3Src)) {
    cpDir(sam3Src, sam3Dest);
    console.log('[ensure-sam] staged src/sam3_integration → build/src/sam3_integration');
  } else {
    console.warn('[ensure-sam] src/sam3_integration missing — vision sidecar not in build');
  }

  const sam3WorkerPub = path.join(ROOT, 'public', 'app', 'sam3-worker.js');
  const sam3WorkerBuild = path.join(BUILD, 'app', 'sam3-worker.js');
  if (fs.existsSync(sam3WorkerPub)) {
    fs.mkdirSync(path.dirname(sam3WorkerBuild), { recursive: true });
    fs.copyFileSync(sam3WorkerPub, sam3WorkerBuild);
  }

  // Optional local vision model dir (weights not shipped by default)
  const sam3ModelsPub = path.join(ROOT, 'public', 'app', 'models', 'sam3');
  const sam3ModelsBuild = path.join(BUILD, 'app', 'models', 'sam3');
  fs.mkdirSync(sam3ModelsBuild, { recursive: true });
  if (fs.existsSync(sam3ModelsPub)) {
    cpDir(sam3ModelsPub, sam3ModelsBuild);
  }
  const sam3Marker = {
    packageId: 'vip-sam3-vision',
    version: '25.0.2',
    bundled: true,
    featureFlagDefault: false,
    enableEnv: 'VIP_SAM3_ENABLED',
    platforms: ['web', 'android', 'desktop'],
    worker: '/src/sam3_integration/worker.js',
    publicWorker: '/app/sam3-worker.js',
    modelDir: '/app/models/sam3/',
    note: 'Vision/video sidecar only — not SAM-Audio; not in Live AudioWorklet DSP',
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(modelsDest, 'sam3-runtime.marker.json'),
    JSON.stringify(sam3Marker, null, 2),
  );
  fs.writeFileSync(
    path.join(sam3ModelsBuild, 'README.md'),
    [
      '# SAM 3 local model assets',
      '',
      'Place licensed browser-compatible SAM 3 weights here only.',
      'Never fetch remote inference hosts at runtime.',
      '',
      'Expected path (same-origin): `/app/models/sam3/model.onnx` (or package layout)',
      '',
      'Enable: `VIP_SAM3_ENABLED=1` or `localStorage vip-sam3-enabled=1`',
      '',
    ].join('\n'),
  );

  console.log('[ensure-sam] SAM-Audio + SAM3 vision staged for web+android+desktop');
}

main();
