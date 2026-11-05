#!/usr/bin/env node
/**
 * Verify the Android APK assets form a complete offline app.
 * Run after: pnpm build && node scripts/prepare-android-complete.mjs && npx cap sync android
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'android', 'app', 'src', 'main', 'assets', 'public');
const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
).version;

const REQUIRED = [
  // Landing home
  'index.html',
  'landing.js',
  'landing.css',
  'vip-android.json',
  // Engineer Mode (+ studio console skin shared with web/desktop)
  'app/index.html',
  'app/app.js',
  'app/slider-map.js',
  'app/workflow-tier.js',
  'app/whisper-hunter.js',
  'app/sw.js',
  'app/engineer-console.css',
  'app/engineer-console.js',
  'app/workstation-premium.css',
  'fonts/Geist-Variable.woff2',
  'fonts/GeistMono-Variable.woff2',
  'fonts/instrument-serif-latin-400-italic.woff2',
  'app/models/bsrnn_vocals.onnx',
  'app/models/rnnoise_suppressor.onnx',
  'app/models/silero_vad.onnx',
  'app/models/dfn3_enc.onnx',
  'app/models/dfn3_erb_dec.onnx',
  'app/models/dfn3_df_dec.onnx',
  'lib/ort.min.js',
  'lib/ort-wasm-simd-threaded.wasm',
  'src/workers/MLWorker.js',
  'src/workers/EngineerSpectralControls.js',
  'src/workers/MainsHumFilter.js',
  'src/workers/DeepFilterNet.js',
  'src/workers/SpeakerEmbeddingWorker.js',
  'src/workers/SpeakerFeatures.js',
  'src/workers/GateProcessor.js',
  'src/workers/DeEsserProcessor.js',
  'src/presentation/DspSlider.js',
];

const FORBIDDEN = [
  'app/models/demucs_v4_fp32.onnx',
  'app/models/demucs_v4_quantized.onnx',
  'app/models/sam_audio.onnx',
  // Desktop-only SAM worker and FFmpeg must never reach the APK.
  'sam-audio',
  'ffmpeg-shared',
];

const errors = [];
const warnings = [];

if (!fs.existsSync(ASSETS)) {
  console.error('[verify-android] assets/public missing — run cap sync android');
  process.exit(1);
}

for (const rel of REQUIRED) {
  const abs = path.join(ASSETS, rel);
  if (!fs.existsSync(abs)) errors.push(`Missing: assets/public/${rel}`);
  else if (rel.endsWith('.onnx') && fs.statSync(abs).size < 100_000) {
    errors.push(`Model too small (corrupt?): ${rel}`);
  }
}

for (const rel of FORBIDDEN) {
  if (fs.existsSync(path.join(ASSETS, rel))) {
    errors.push(`Should not ship: assets/public/${rel}`);
  }
}

const entry = fs.readFileSync(path.join(ASSETS, 'index.html'), 'utf8');
// Landing is the home screen — must keep upload UI + Engineer Mode link.
if (!entry.includes('landing.js') && !entry.includes('/landing.js')) {
  errors.push('Root index.html must be the landing page (landing.js)');
}
if (!entry.includes('uploadZone') && !entry.includes('fileInput')) {
  errors.push('Landing must include file upload UI');
}
if (!entry.includes('/app/') && !entry.includes('/app/index.html')) {
  errors.push('Landing must link to Engineer Mode (/app/)');
}
// Offline: root entry must not pull Google Fonts (or any CDN).
if (entry.includes('fonts.googleapis.com') || entry.includes('fonts.gstatic.com')) {
  errors.push('Root entry must not load Google Fonts (offline app)');
}
const marker = path.join(ASSETS, 'vip-android.json');
if (fs.existsSync(marker)) {
  try {
    const meta = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (meta.landing !== true) warnings.push('vip-android.json should set landing: true');
    if (meta.version !== PACKAGE_VERSION) {
      errors.push(`vip-android.json version ${meta.version} != package ${PACKAGE_VERSION}`);
    }
  } catch {
    warnings.push('vip-android.json is not valid JSON');
  }
}

const engineerApp = fs.readFileSync(path.join(ASSETS, 'app/app.js'), 'utf8');
const workflowTier = fs.readFileSync(path.join(ASSETS, 'app/workflow-tier.js'), 'utf8');
const engineerHtml = fs.readFileSync(path.join(ASSETS, 'app/index.html'), 'utf8');
const engineerSw = fs.readFileSync(path.join(ASSETS, 'app/sw.js'), 'utf8');
if (!engineerApp.includes('Mount the complete 67-control rack')) {
  errors.push('Engineer app does not eagerly mount the complete slider rack');
}
if (!engineerHtml.includes('section-eq') || !engineerHtml.includes('tab-extreme')) {
  errors.push('Engineer HTML missing EQ or Whisper/Extreme panels');
}
if (!engineerHtml.includes('workstation-premium.css') || !engineerHtml.includes('id="vipMetricGuide"') || !engineerHtml.includes('id="vipStemPath"')) {
  errors.push('Engineer HTML missing the shared workflow shell (skin, metric guide, or stems path)');
}
const engineerConsole = fs.readFileSync(path.join(ASSETS, 'app/engineer-console.js'), 'utf8');
for (const id of ["id: 'stems'", "id: 'advanced'", "id: 'engineer'", "id: 'forensic'"]) {
  if (!engineerConsole.includes(id)) errors.push(`Engineer console missing workflow ${id}`);
}
if (!workflowTier.includes("defaultFilterMode: 'all'")) {
  errors.push('Engineer workflow does not default to the full control rack');
}
if (!engineerSw.match(/const CACHE_VERSION\s*=\s*'vip-app-[a-f0-9]{12}'/)) {
  errors.push('Engineer service worker cache was not stamped from current shell assets');
}

const mainJava = path.join(
  ROOT,
  'android/app/src/main/java/com/voiceisolatepro/app/MainActivity.java',
);
if (fs.existsSync(mainJava)) {
  const java = fs.readFileSync(mainJava, 'utf8');
  if (!java.includes('application/wasm')) {
    warnings.push('MainActivity should set application/wasm MIME for ORT');
  }
  if (!java.includes('Cross-Origin-Embedder-Policy')) {
    errors.push('MainActivity missing COEP injection (SharedArrayBuffer)');
  }
  if (!java.includes('normalizeAssetPath') && !java.includes('URLDecoder')) {
    warnings.push('MainActivity should normalize asset paths (query/fragment strip)');
  }
  if (!java.includes('status >= 100') && !java.includes('status = 200')) {
    warnings.push('MainActivity should sanitize WebResourceResponse status codes');
  }
}

if (errors.length) {
  console.error('[verify-android] FAILED:');
  for (const e of errors) console.error('  ✗', e);
  process.exit(1);
}

console.log('[verify-android] Complete offline Android package OK');
for (const w of warnings) console.warn('  !', w);
process.exit(0);
