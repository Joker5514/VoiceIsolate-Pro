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

  // Worker sources for Electron extraResources staging (no venv pointers / pyc)
  const workerSrc = path.join(ROOT, 'services', 'sam-audio');
  const workerDest = path.join(BUILD, 'sam-audio');
  if (fs.existsSync(workerSrc)) {
    fs.mkdirSync(workerDest, { recursive: true });
    for (const name of fs.readdirSync(workerSrc)) {
      if (
        name === '__pycache__' ||
        name.endsWith('.pyc') ||
        name === '.python-path' ||
        name === '.ffmpeg-bin' ||
        name.startsWith('.')
      ) {
        continue;
      }
      const from = path.join(workerSrc, name);
      const to = path.join(workerDest, name);
      const st = fs.statSync(from);
      if (st.isDirectory()) cpDir(from, to);
      else fs.copyFileSync(from, to);
    }
  }

  // Copy optional onnx if present
  const onnx = path.join(ROOT, 'public', 'app', 'models', 'sam_audio.onnx');
  if (fs.existsSync(onnx)) {
    fs.copyFileSync(onnx, path.join(modelsDest, 'sam_audio.onnx'));
    console.log('[ensure-sam] included sam_audio.onnx in build');
  } else {
    console.log('[ensure-sam] sam_audio.onnx not present (optional); marker + worker still bundled');
  }

  // Optional shared FFmpeg for packaged Electron (process.resourcesPath/ffmpeg-shared)
  const ffmpegSrc = path.join(ROOT, '.tools', 'ffmpeg-shared');
  const ffmpegDest = path.join(BUILD, 'ffmpeg-shared');
  if (fs.existsSync(ffmpegSrc)) {
    cpDir(ffmpegSrc, ffmpegDest);
    console.log('[ensure-sam] staged .tools/ffmpeg-shared → build/ffmpeg-shared');
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
    version: '25.0.1',
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
