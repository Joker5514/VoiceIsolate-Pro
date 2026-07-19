#!/usr/bin/env node
/**
 * Prepare a complete offline Android app package under build/ before `cap sync`.
 *
 * - Landing page is the app entry (Stem-Split & Live-Mix UI)
 * - Engineer Mode remains at /app/ (linked from landing)
 * - Landing is patched offline (no Google Fonts CDN)
 * - Ships required ONNX models (BS-RNN default + denoise + VAD)
 * - Drops demucs FP32 (~353 MB) unused on mobile default path
 * - Verifies ORT WASM + worklets + landing + Engineer shell
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
  // Landing (app home)
  'index.html',
  'landing.js',
  'landing.css',
  'transport-polish.css',
  // Engineer Mode
  'app/index.html',
  'app/app.js',
  'app/style.css',
  'app/models-manifest.json',
  // Worklets + ORT
  'src/workers/GateProcessor.js',
  'src/workers/DeEsserProcessor.js',
  'src/workers/MLWorker.js',
  'lib/ort.min.js',
  'lib/react-mini.js',
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

// ── 1. Keep landing as root entry; strip CDN fonts for 100% offline ──
const indexPath = path.join(BUILD, 'index.html');
if (!fs.existsSync(indexPath)) {
  console.error('[prepare-android] build/index.html missing — landing not copied');
  process.exit(1);
}
let landingHtml = fs.readFileSync(indexPath, 'utf8');
// Remove Google Fonts (preconnect + stylesheet) — use system UI fonts offline.
landingHtml = landingHtml
  .replace(/<link[^>]+fonts\.googleapis\.com[^>]*>\s*/gi, '')
  .replace(/<link[^>]+fonts\.gstatic\.com[^>]*>\s*/gi, '');
// Offline font stack + Android polish (viewport-fit, safe areas).
const offlineFontCss = `
  <meta name="theme-color" content="#0a0a0f" />
  <meta name="color-scheme" content="dark" />
  <style id="vip-android-offline-fonts">
    :root {
      --font-ui: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      --font-mono: ui-monospace, "Cascadia Code", "SF Mono", Menlo, Consolas, monospace;
    }
    html, body { font-family: var(--font-ui); }
  </style>
`;
if (!landingHtml.includes('vip-android-offline-fonts')) {
  landingHtml = landingHtml.replace(/<\/head>/i, `${offlineFontCss}</head>`);
}
// Download page is not shipped in APK — point nav to Engineer Mode instead.
landingHtml = landingHtml.replace(
  /href="\/download\/?"/g,
  'href="/app/" title="Engineer Mode (full studio)"',
);
// Keep a visible Engineer Mode link if only one remains after rewrite.
if (!landingHtml.includes('href="/app/"') && !landingHtml.includes("href='/app/'")) {
  landingHtml = landingHtml.replace(
    '</header>',
    '<a href="/app/" class="eng-mode-link">Engineer Mode</a></header>',
  );
}
fs.writeFileSync(indexPath, landingHtml, 'utf8');
console.log('[prepare-android] Root index → offline landing page (Engineer Mode at /app/)');

// ── 2. Strip heavy docs only (keep landing assets) ──
for (const rel of ['docs', 'blueprint']) {
  if (rmIfExists(path.join(BUILD, rel))) {
    console.log(`[prepare-android] Removed build/${rel} (not needed in APK)`);
  }
}
// Compact download stub so /download links never 404 if something still points there.
const dlDir = path.join(BUILD, 'download');
fs.mkdirSync(dlDir, { recursive: true });
fs.writeFileSync(
  path.join(dlDir, 'index.html'),
  `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>VoiceIsolate Pro</title>
<meta http-equiv="refresh" content="0;url=/app/"/>
<style>body{margin:0;background:#0a0a0f;color:#e8e8f0;font-family:system-ui,sans-serif;
display:grid;place-items:center;min-height:100vh;text-align:center;padding:24px}
a{color:#fca5a5}</style></head><body>
<p><b>VoiceIsolate Pro</b> — full studio is on-device.</p>
<p><a href="/">Landing</a> · <a href="/app/">Engineer Mode</a></p>
</body></html>`,
  'utf8',
);
console.log('[prepare-android] /download → offline stub linking to landing + Engineer Mode');

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

// ── 4. Landing + Engineer shell + ORT ──
for (const rel of REQUIRED_PATHS) mustExist(rel);
for (const name of REQUIRED_ORT) {
  mustExist(path.join('lib', name).replace(/\\/g, '/'));
}
// Confirm landing no longer pulls CDN fonts.
const patchedLanding = fs.readFileSync(indexPath, 'utf8');
if (patchedLanding.includes('fonts.googleapis.com') || patchedLanding.includes('fonts.gstatic.com')) {
  console.error('[prepare-android] FATAL: landing still references Google Fonts');
  process.exit(1);
}
if (!patchedLanding.includes('landing.js') || !patchedLanding.includes('landing.css')) {
  console.error('[prepare-android] FATAL: landing missing landing.js / landing.css');
  process.exit(1);
}
console.log('[prepare-android] ✓ Landing + Engineer shell, worklets, ORT present');

// ── 5. Capacitor offline marker ──
fs.writeFileSync(
  path.join(BUILD, 'vip-android.json'),
  JSON.stringify({
    complete: true,
    offline: true,
    entry: '/',
    landing: true,
    engineer: '/app/index.html',
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
