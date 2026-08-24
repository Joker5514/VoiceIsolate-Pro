#!/usr/bin/env node
/**
 * VoiceIsolate Pro — Structural Validation
 * Checks critical files, architecture patterns, and slider definitions.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let errors = 0;
const check = (condition, msg) => {
  if (condition) { console.log(`  ✓ ${msg}`); }
  else { console.log(`  ✗ ${msg}`); errors++; }
};

console.log('\n🔍 VoiceIsolate Pro — Validation\n');

// Vercel runs this script as its buildCommand, but .vercelignore strips
// dev-only files (tests/*.test.js, CI config) from the deploy context —
// requiring them there fails every deployment. Dev-only checks run only
// outside Vercel builds.
const IS_VERCEL_BUILD = process.env.VERCEL === '1' || process.env.VERCEL === 'true';

// 1. Critical files
console.log('Files:');
const required = [
  'public/index.html',
  'public/app/index.html',
  'public/app/style.css',
  'public/app/app.js',
  'public/app/dsp-worker.js',           // Phase 3: AudioWorklet
  'public/app/ml-worker.js',            // Phase 4: ML Web Worker
  'public/app/models/README.md',        // Phase 4: ML model docs
  'public/blueprint/index.html',
  'vercel.json',
  'package.json',
  'README.md',
];
const devOnlyRequired = [
  '.github/copilot-instructions.md',
  'tests/dsp.test.js',                  // Phase 6: Tests
  'tests/sliders.test.js',
  'tests/presets.test.js',
];
required.forEach(f => check(fs.existsSync(path.resolve(__dirname, '..', f)), f));
if (IS_VERCEL_BUILD) {
  console.log('  ℹ  Vercel build context — dev-only file checks skipped (.vercelignore strips them)');
} else {
  devOnlyRequired.forEach(f => check(fs.existsSync(path.resolve(__dirname, '..', f)), f));
}

// 2. app.js / engineer shell structural checks
console.log('\napp.js structure:');
const appJs = fs.readFileSync(path.resolve(__dirname, '..', 'public/app/app.js'), 'utf8');
const sliderMapPath = path.resolve(__dirname, '..', 'public/app/slider-map.js');
const sliderMapJs = fs.existsSync(sliderMapPath) ? fs.readFileSync(sliderMapPath, 'utf8') : '';
const isModularEngineer = appJs.includes('function buildSliderUI()');
const isLegacyMonolith = appJs.includes('class VoiceIsolatePro') || appJs.includes('const SLIDERS');

check(appJs.length > 5000, `Size: ${appJs.length} bytes (>5KB)`);

if (isModularEngineer) {
  check(appJs.includes('function buildSliderUI()'), 'Engineer Mode: buildSliderUI present');
  check(appJs.includes('SLIDER_REGISTRY'), 'Engineer Mode: SLIDER_REGISTRY referenced');
  check(sliderMapJs.includes('const SLIDER_REGISTRY'), 'slider-map.js: SLIDER_REGISTRY defined');
  const registryBlock = sliderMapJs.match(/const SLIDER_REGISTRY = \{([\s\S]*?)\n\};/);
  const registryCount = registryBlock
    ? (registryBlock[1].match(/^\s{2}\w+:/gm) || []).length
    : 0;
  check(registryCount === 52, `SLIDER_REGISTRY count: ${registryCount} (must be 52)`);
  const stagesMatch = sliderMapJs.match(/const STAGES = \[([\s\S]*?)\];/);
  const uiStageCount = stagesMatch ? (stagesMatch[1].match(/^\s+id:\s*'/gm) || []).length : 0;
  check(uiStageCount >= 1, `UI STAGES count: ${uiStageCount} (must have ≥1)`);
  const dspStagesPath = path.resolve(__dirname, '..', 'public/app/dsp-stages.js');
  const dspStagesJs = fs.existsSync(dspStagesPath) ? fs.readFileSync(dspStagesPath, 'utf8') : '';
  const pipelineStagesMatch = dspStagesJs.match(/const stages = \[([\s\S]*?)\];/);
  const pipelineStageCount = pipelineStagesMatch
    ? (pipelineStagesMatch[1].match(/'[^']+'/g) || []).length
    : 0;
  check(pipelineStageCount === 32, `DSP pipeline stages: ${pipelineStageCount} (must be 32)`);
} else if (isLegacyMonolith) {
  const sliderGroups = ['gate', 'nr', 'eq'];
  sliderGroups.forEach(g => check(appJs.includes(`${g}:`), `Slider group: ${g}`));
  const slidersBlock = appJs.match(/const SLIDERS\s*=\s*\{([\s\S]*?)\s*\};/);
  const sliderMatches = slidersBlock ? slidersBlock[1].match(/\{\s*id\s*:\s*'/g) : null;
  const sliderCount = sliderMatches ? sliderMatches.length : 0;
  check(sliderCount === 67, `Slider count: ${sliderCount} (must be 67)`);
  const stagesMatch = sliderMapJs.match(/(?:export )?const STAGES = \[([\s\S]*?)\];/);
  const stageItems = stagesMatch ? (stagesMatch[1].match(/'[^']+'/g) || []) : [];
  check(stageItems.length === 32, `STAGES count: ${stageItems.length} (must be 32)`);
} else {
  check(false, 'app.js matches neither modular Engineer nor legacy monolith layout');
}

// Phase 1: STFT engine presence
console.log('\nSpectral Engine (Phase 1):');
const spectralPaths = isModularEngineer
  ? ['public/app/dsp-core.js', 'public/app/dsp-bootstrap.js', 'public/app/offline-processor.js', 'public/app/dsp-stages.js']
  : ['public/app/app.js'];
const spectralSource = spectralPaths
  .map(f => {
    const p = path.resolve(__dirname, '..', f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  })
  .join('\n');
const hasFft = /_fft|forwardSTFT|_fftInPlace/.test(spectralSource);
const hasIfft = /_ifft|inverseSTFT|_ifftInPlace/.test(spectralSource);
const hasWindow = /_makeWindow|Blackman|makeBlackmanHarris/.test(spectralSource);
const hasSpectralNr = /applySpectralNR|spectralNR|applyWienerNR|spectralGate|stageSpectralSubtraction/.test(spectralSource);
check(hasFft, 'FFT implementation present');
check(hasIfft, 'IFFT implementation present');
check(hasWindow, 'Window function present');
check(hasSpectralNr, 'Spectral NR function present');
check(!appJs.includes('applyNR(buf,amt,smooth'), 'Old stub applyNR removed');

// Phase 2: Wired sliders (legacy monolith only — modular shell delegates to slider-map)
console.log('\nWired Sliders (Phase 2):');
if (isLegacyMonolith) {
  const wiredSliders = ['applyBgSuppress','applyCrosstalkCancel','applyFormantShift','applyPhaseCorr','applyDereverb'];
  wiredSliders.forEach(fn => check(appJs.includes(fn), `${fn} implemented`));
  check(appJs.includes('function encodeWavBuffer(audioBuffer, ditherMode = 0)'), 'dither encoding boundary implemented');
  check(!appJs.includes('applyDither'), 'Dither stays out of preview PCM');
} else {
  console.log('  ℹ  Wired-slider body checks skipped (modular Engineer shell)');
}

// Phase 3: AudioWorklet
console.log('\nAudioWorklet (Phase 3):');
const awJs = fs.existsSync(path.resolve(__dirname, '..', 'public/app/dsp-processor.js'))
  ? fs.readFileSync(path.resolve(__dirname, '..', 'public/app/dsp-processor.js'), 'utf8') : '';
check(awJs.includes("registerProcessor('dsp-processor'"), 'AudioWorklet registerProcessor present');
check(awJs.includes('process(inputs, outputs'), 'AudioWorklet process() method present');
const { verifyWorklets } = require('./verify-worklets.js');
const workletResult = verifyWorklets({ quiet: true });
if (!workletResult.ok) {
  workletResult.errors.forEach((e) => console.log(`  ✗ ${e}`));
  errors += workletResult.errors.length;
} else {
  check(true, 'All 3 AudioWorklets present, hashed, and APP_SHELL precached (verify-worklets.js)');
}

// Phase 4: ONNX Runtime + ML Worker
console.log('\nONNX Runtime (Phase 4):');
const htmlPath = path.resolve(__dirname, '..', 'public/app/index.html');
const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
const mlWorkerJs = fs.existsSync(path.resolve(__dirname, '..', 'public/app/ml-worker.js'))
  ? fs.readFileSync(path.resolve(__dirname, '..', 'public/app/ml-worker.js'), 'utf8') : '';
check(mlWorkerJs.includes('importScripts'), 'Legacy ML Worker loads ORT via importScripts');

// Stem-Split & Live-Mix architecture (CLAUDE.md §1–§2)
console.log('\nStem-Split & Live-Mix (CLAUDE.md):');
const srcFiles = [
  'src/core/audio-config.js',
  'src/core/media-types.js',
  'src/core/BufferPool.js',
  'src/core/ModelManifest.js',
  'src/pipeline/FileIngestion.js',
  'src/pipeline/media-decode.js',
  'src/pipeline/PlaybackMixer.js',
  'src/presentation/SliderUI.js',
  'src/workers/MLWorker.js',
  'server/securityHeaders.js',
];
srcFiles.forEach(f => check(fs.existsSync(path.resolve(__dirname, '..', f)), f));

const newMlWorker = fs.readFileSync(path.resolve(__dirname, '..', 'src/workers/MLWorker.js'), 'utf8');
check(newMlWorker.includes("importScripts('/lib/ort.min.js')"), 'MLWorker loads ORT locally (never CDN)');
check(newMlWorker.includes('SHA-256'), 'MLWorker verifies model SHA-256 integrity');
check(newMlWorker.includes('_wasmSessionKeys'), 'MLWorker pins WebGPU compile fallback per session key');
check(newMlWorker.includes('_webgpuDisabledReason'), 'MLWorker disables WebGPU worker-wide only on device loss');
check(fs.existsSync(path.resolve(__dirname, '..', 'docs/releases/release-provenance.json')), 'release-provenance.json present');
check(fs.existsSync(path.resolve(__dirname, '..', 'scripts/validate-release-provenance.mjs')), 'provenance validator present');
check(fs.existsSync(path.resolve(__dirname, '..', 'scripts/validate-model-integrity.mjs')), 'model-integrity validator present');
const claudeMd = fs.readFileSync(path.resolve(__dirname, '..', 'CLAUDE.md'), 'utf8');
check(
  /^\*\*Default isolation chain:\*\* `\['bsrnn_vocals'\]`/m.test(claudeMd),
  'CLAUDE.md Default isolation chain heading is BSRNN-only',
);
check(
  !/^\*\*Default isolation chain:\*\* `\['demucs'/m.test(claudeMd),
  'CLAUDE.md does not claim Demucs as the default chain',
);
check(fs.readFileSync(path.resolve(__dirname, '..', 'src/core/audio-config.js'), 'utf8')
  .includes('SAMPLE_RATE = 48000'), 'Canonical SAMPLE_RATE = 48000 in audio-config.js');

// Hard prohibitions (CLAUDE.md §1.1) — the live-mic pipeline must stay dead.
const appDir = path.resolve(__dirname, '..', 'public/app');
const offenders = [];
// Playback-only DSP worklets explicitly permitted in src/ (NOT live-mic). See
// CLAUDE.md §2.1. Any other worklet path — or a non-literal/dynamic module arg
// — is still rejected, and getUserMedia stays banned outright.
const ALLOWED_WORKLETS = ['/src/workers/GateProcessor.js', '/src/workers/DeEsserProcessor.js'];
// Vendored, minified third-party bundles (ORT, Three.js, design-system, React
// shim). These are trusted build artifacts and a future upstream upgrade could
// legitimately embed a string that looks like a CDN host, so the CDN-host scan
// below skips them — but the getUserMedia / dynamic-worklet bans still apply to
// every file, vendored or not. The path-boundary and non-separator classes
// accept both / and \ so the exclusion also holds on Windows (walkJs joins
// paths with path.sep, which is \ there).
const VENDORED_BUNDLE = /(?:^|[/\\])(?:ort[.-][^/\\]*\.js|three[.-][^/\\]*\.js|_ds_bundle\.js|react-mini\.js)$|\.min\.js$/;
// Third-party CDN hosts that must never appear in shipped code: ORT and Three.js
// are vendored locally under public/lib and the CSP blocks third-party script
// origins, so any CDN reference is a regression (CLAUDE.md §1.1, §3).
const CDN_HOSTS = /https?:\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|cdn\.skypack\.dev|esm\.run|ga\.jspm\.io)/;
const scanDirs = [
  ['public/app', appDir],
  ['src', path.resolve(__dirname, '..', 'src')],
  // public/lib holds the vendored ORT/Three bundles; scan it too so a hand-added
  // CDN loader shim here cannot slip past the "never CDN" guarantee (audit 2026-06-21).
  ['public/lib', path.resolve(__dirname, '..', 'public/lib')],
];
for (const [label, dir] of scanDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const f of walkJs(dir)) {
    const src = fs.readFileSync(f, 'utf8');
    if (/getUserMedia\s*\(/.test(src)) offenders.push(`${label}/${path.relative(dir, f)} (getUserMedia)`);
    if (!VENDORED_BUNDLE.test(f) && CDN_HOSTS.test(src)) {
      offenders.push(`${label}/${path.relative(dir, f)} (CDN reference)`);
    }
    if (/audioWorklet\.addModule\s*\(/.test(src)) {
      // Every addModule call must load an allowlisted playback worklet via a
      // string literal; any other path or a dynamic argument is forbidden.
      const argRe = /audioWorklet\.addModule\s*\(\s*['"]([^'"]+)['"]/g;
      let m;
      let verified = false;
      let allAllowed = true;
      while ((m = argRe.exec(src))) {
        verified = true;
        if (!ALLOWED_WORKLETS.includes(m[1])) allAllowed = false;
      }
      if (!verified || !allAllowed) {
        offenders.push(`${label}/${path.relative(dir, f)} (audioWorklet.addModule)`);
      }
    }
  }
}
const landingHtml = fs.readFileSync(path.resolve(__dirname, '..', 'public/index.html'), 'utf8');
if (/getUserMedia/.test(landingHtml)) offenders.push('public/index.html (getUserMedia)');
check(offenders.length === 0, offenders.length === 0
  ? 'No live-mic ingestion or worklet registration (live pipeline stays removed)'
  : `Forbidden live-pipeline code found: ${offenders.join(', ')}`);
check(!fs.existsSync(path.resolve(appDir, 'pipeline-orchestrator.js')), 'pipeline-orchestrator.js stays deleted');
check(!fs.existsSync(path.resolve(__dirname, '..', 'api-routes/auth.js')), 'api-routes/auth.js stays deleted');

function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// Phase 5: Forensic (legacy Engineer shell only)
console.log('\nForensic Mode (Phase 5):');
if (html.includes('forensicToggle')) {
  check(html.includes('forensicToggle'), 'Forensic toggle in index.html');
  check(html.includes('auditLogBtn'), 'Audit log button in index.html');
  check(appJs.includes("crypto.subtle.digest('SHA-256'"), 'SHA-256 audit hashing present');
  check(appJs.includes('this.forensicLog = []'), 'forensicLog initialized');
} else {
  console.log('  ℹ  Forensic UI checks skipped (modular Engineer shell)');
}

// Landing page integration (Vercel primary entry)
console.log('\nLanding page:');
const landingJsPath = path.resolve(__dirname, '..', 'public/landing.js');
const landingJs = fs.existsSync(landingJsPath) ? fs.readFileSync(landingJsPath, 'utf8') : '';
check(landingHtml.includes('id="fileInput"'), 'landing index.html: fileInput present');
check(landingHtml.includes('/landing.js'), 'landing index.html: landing.js script');
check(landingJs.includes('/src/pipeline/FileIngestion.js'), 'landing.js: FileIngestion import');
check(landingJs.includes('/src/pipeline/media-decode.js') || landingJs.includes('ingestFile'),
  'landing.js: ingestion pipeline wired');

// 3. Balanced braces
console.log('\nBrace balance:');
const openBraces = (appJs.match(/{/g) || []).length;
const closeBraces = (appJs.match(/}/g) || []).length;
check(openBraces === closeBraces, `Braces: ${openBraces} open / ${closeBraces} close`);

// 4. Blueprint check
console.log('\nBlueprint:');
const blueprint = fs.readFileSync(path.resolve(__dirname, '..', 'public/blueprint/index.html'), 'utf8');
check(blueprint.includes('Stem-Split and Live-Mix'), 'References current Stem-Split & Live-Mix architecture');
check(blueprint.includes('67 sliders'), 'References current 67-slider registry');
check(blueprint.includes('user audio stays local'), 'States local-audio privacy boundary');
check(blueprint.includes('/app/models/*.onnx'), 'Documents same-origin ONNX model route');
check(blueprint.includes('one forward STFT'), 'Documents single forward STFT rule');
check(blueprint.includes('one inverse STFT'), 'Documents single inverse STFT rule');

// 5. Duplicate JSON key check
console.log('\nJSON duplicate key check:');
const dupKeyScriptPath = path.resolve(__dirname, 'check-duplicate-keys.js');
if (fs.existsSync(dupKeyScriptPath)) {
  const { findDuplicateKeys } = require('./check-duplicate-keys.js');
  function checkDuplicateKeysWrapper(filePath) {
    const raw = fs.readFileSync(path.resolve(__dirname, '..', filePath), 'utf8');
    return findDuplicateKeys(raw);
  }
  const pkgDupes = checkDuplicateKeysWrapper('package.json');
  check(pkgDupes.length === 0, pkgDupes.length === 0
    ? 'No duplicate keys in package.json'
    : `Duplicate keys in package.json: ${pkgDupes.join(', ')}`);
} else {
  console.log('  ℹ  check-duplicate-keys.js not found — skipping duplicate key check');
}

// 6. vercel.json
console.log('\nVercel config:');
const vercelJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'vercel.json'), 'utf8'));
check(vercelJson.outputDirectory === 'public', 'Output directory: public');

console.log('\nRelease provenance & shipped models:');
const provenance = spawnSync(process.execPath, [path.join(__dirname, 'validate-release-provenance.mjs')], {
  stdio: 'inherit',
});
check(provenance.status === 0, 'release provenance schema valid (default mode; stale/unknown natives allowed)');
const modelIntegrity = spawnSync(process.execPath, [path.join(__dirname, 'validate-model-integrity.mjs')], {
  stdio: 'inherit',
});
check(modelIntegrity.status === 0, 'shipped ModelManifest entries hash-verify locally');

console.log(`\n${errors === 0 ? '✅ All checks passed' : `❌ ${errors} check(s) failed`}\n`);
process.exit(errors > 0 ? 1 : 0);
