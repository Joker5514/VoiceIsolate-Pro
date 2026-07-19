#!/usr/bin/env node
/**
 * Prepare a complete offline Android app package under build/ before `cap sync`.
 *
 * - Engineer Mode is the app entry (not the marketing landing / Google Fonts)
 * - Ships required ONNX models for isolation (BS-RNN default + denoise + VAD)
 * - Drops demucs FP32 (~353 MB) which is not on the default path and breaks sideload size
 * - Keeps quantized demucs optional for "maximum" isolation if present
 * - Verifies ORT WASM + worklets + Engineer shell exist
 *
 * Usage: node scripts/prepare-android-complete.mjs
 * Called by: scripts/android-build-win.mjs after `pnpm build`
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');

/** Models required for a complete offline isolation app (default + denoise + VAD). */
const REQUIRED_MODELS = [
  'bsrnn_vocals.onnx',
  'rnnoise_suppressor.onnx',
  'silero_vad.onnx',
];

/** Optional but useful if present (heavy). */
const OPTIONAL_MODELS = [
  'silero_vad_int8.onnx',
  'demucs_v4_quantized.onnx',
];

/** Never ship these in the Android APK (bloat / unused on mobile default path). */
const EXCLUDE_MODELS = [
  'demucs_v4_fp32.onnx',
];

const REQUIRED_ORT = [
  'ort.min.js',
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
];

const REQUIRED_PATHS = [
  'app/index.html',
  'app/app.js',
  'app/style.css',
  'app/models-manifest.json',
  'src/workers/GateProcessor.js',
  'src/workers/DeEsserProcessor.js',
  'src/workers/MLWorker.js',
  'lib/ort.min.js',
];

function rmIfExists(p) {
  if (fs.existsSync(p)) {
    const st = fs.statSync(p);
    if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
    return true;
  }
  return false;
}

function mustExist(rel) {
  const abs = path.join(BUILD, rel);
  if (!fs.existsSync(abs)) {
    throw new Error(`[prepare-android] Missing required asset: build/${rel}`);
  }
  return abs;
}

function fileMB(abs) {
  return (fs.statSync(abs).size / (1024 * 1024)).toFixed(1);
}

if (!fs.existsSync(BUILD)) {
  console.error('[prepare-android] build/ missing — run `pnpm build` first');
  process.exit(1);
}

console.log('[prepare-android] Preparing complete offline Android package…');

// ── 1. Engineer Mode as root entry (no Google Fonts / marketing landing) ──
const entryHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#0a0a0f" />
  <meta name="color-scheme" content="dark" />
  <title>VoiceIsolate Pro</title>
  <style>
    html,body{margin:0;background:#0a0a0f;color:#e8e8f0;font-family:system-ui,sans-serif;
      min-height:100%;display:grid;place-items:center}
    .boot{text-align:center;padding:24px;opacity:.9}
    .boot b{color:#f87171;letter-spacing:.08em;font-size:.85rem}
    .boot p{margin:.6rem 0 0;font-size:.8rem;color:#9ca3af}
  </style>
  <script>
    // Immediate navigation into the full Engineer app (bundled under /app/).
    // Works on Capacitor https://voiceisolatepro.app origin.
    location.replace('/app/index.html');
  </script>
</head>
<body>
  <div class="boot">
    <b>VOICEISOLATE PRO</b>
    <p>Starting on-device studio…</p>
    <p><a href="/app/index.html" style="color:#fca5a5">Open Engineer Mode</a></p>
  </div>
</body>
</html>
`;
fs.writeFileSync(path.join(BUILD, 'index.html'), entryHtml, 'utf8');
console.log('[prepare-android] Root index → Engineer Mode entry');

// ── 2. Strip marketing/docs bloat that is not needed offline ──
for (const rel of ['docs', 'blueprint', 'download']) {
  if (rmIfExists(path.join(BUILD, rel))) {
    console.log(`[prepare-android] Removed build/${rel} (not needed in APK)`);
  }
}

// ── 3. Models: require core, drop FP32 demucs ──
const modelsDir = path.join(BUILD, 'app', 'models');
if (!fs.existsSync(modelsDir)) {
  console.error('[prepare-android] build/app/models missing');
  process.exit(1);
}

for (const name of EXCLUDE_MODELS) {
  const p = path.join(modelsDir, name);
  if (rmIfExists(p)) {
    console.log(`[prepare-android] Excluded ${name} (not used on mobile default path)`);
  }
}

for (const name of REQUIRED_MODELS) {
  const abs = path.join(modelsDir, name);
  if (!fs.existsSync(abs)) {
    console.error(`[prepare-android] FATAL: required model missing: app/models/${name}`);
    process.exit(1);
  }
  console.log(`[prepare-android] ✓ model ${name} (${fileMB(abs)} MB)`);
}

for (const name of OPTIONAL_MODELS) {
  const abs = path.join(modelsDir, name);
  if (fs.existsSync(abs)) {
    console.log(`[prepare-android] ○ optional model ${name} (${fileMB(abs)} MB)`);
  } else {
    console.warn(`[prepare-android] optional model not present: ${name}`);
  }
}

// ── 4. ORT + app shell ──
for (const rel of REQUIRED_PATHS) mustExist(rel);
for (const name of REQUIRED_ORT) {
  mustExist(path.join('lib', name).replace(/\\/g, '/'));
}
console.log('[prepare-android] ✓ Engineer shell, worklets, ORT present');

// ── 5. Capacitor offline marker (read by app if needed) ──
fs.writeFileSync(
  path.join(BUILD, 'vip-android.json'),
  JSON.stringify({
    complete: true,
    offline: true,
    entry: '/app/index.html',
    models: REQUIRED_MODELS,
    version: '24.0.0',
    preparedAt: new Date().toISOString(),
  }, null, 2),
  'utf8',
);

// ── 6. Size report ──
function dirSizeMB(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) total += dirSizeMB(p) * 1024 * 1024;
    else total += fs.statSync(p).size;
  }
  return total / (1024 * 1024);
}

const modelsMB = dirSizeMB(modelsDir);
const libMB = dirSizeMB(path.join(BUILD, 'lib'));
const buildMB = dirSizeMB(BUILD);
console.log(`[prepare-android] models ≈ ${modelsMB.toFixed(1)} MB | lib ≈ ${libMB.toFixed(1)} MB | build total ≈ ${buildMB.toFixed(1)} MB`);
console.log('[prepare-android] Complete offline Android package ready for cap sync.');
