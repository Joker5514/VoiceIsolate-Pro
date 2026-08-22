/**
 * Helper: get eval-ready app.js source.
 *
 * app.js uses ES module imports:
 *   import { SLIDER_REGISTRY, STAGES } from './slider-map.js';
 *   import { getCalibratedPresets } from '/src/core/PresetCalibration.js';
 *   import { ModelStatusUI } from './model-status-ui.js';
 *
 * slider-map.js imports calibrateRegistry from slider-calibration.js — both
 * are inlined (calibration first) so eval-based tests never see bare import.
 *
 * ES module syntax cannot be used inside vm.runInContext() or new Function()
 * bodies, so this helper inlines each imported module in an IIFE that exposes
 * only the symbols app.js actually imports. The IIFE prevents conflicts with
 * identifiers that app.js declares locally (e.g. both slider-map.js and app.js
 * define `SLIDERS`, `TAB_PANEL_MAP`, and `buildPanels`).
 *
 * Usage:
 *   const getAppCode = require('./helpers/get-app-code');
 *   const code = getAppCode();  // drop-in replacement for fs.readFileSync(appJsPath)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '../../public/app');
const SRC_CORE_DIR = path.join(__dirname, '../../src/core');

// Sibling modules imported by app.js. The `exports` list must include every
// symbol app.js destructures from that module.
const INLINED_MODULES = [
  {
    file: 'slider-calibration.js',
    exports: [
      'calibrateRegistry',
      'calibrate',
      'getEffectiveDspParams',
      'applyCoupling',
      'softClampArtifacts',
    ],
  },
  { file: 'slider-map.js',         exports: ['SLIDER_REGISTRY', 'STAGES'] },
  { file: 'model-status-ui.js',    exports: ['ModelStatusUI'] },
];

// dsp-core.js is loaded as a classic <script> in the browser before app.js,
// so globalThis.DSPCore is live when app.js evaluates. In test evals/new Function
// that context is absent — prepend dsp-core inline and set globalThis.DSPCore
// so resolveDSPOrFail() in app.js succeeds without modification.
function buildDspCorePreamble() {
  const src = fs.readFileSync(path.join(APP_DIR, 'dsp-core.js'), 'utf8');
  // Wrap in an IIFE so its internal vars don't bleed into the test scope,
  // then assign the result onto globalThis so resolveDSPOrFail() can find it.
  return `
(function _injectDSPCore() {
  const _dspModule = { exports: {} };
  const _dspWindow = {};
  const _dspSelf   = {};
  (function(module, window, self) {
${src}
  })(_dspModule, _dspWindow, _dspSelf);
  const _DSPCoreResult = _dspModule.exports || _dspWindow.DSPCore || _dspSelf.DSPCore;
  if (typeof globalThis !== 'undefined') {
    globalThis.DSPCore = _DSPCoreResult;
    globalThis.DSP     = _DSPCoreResult;
  }
})();
`;
}

function stripModuleImports(src) {
  return src.replace(
    /^import\s+(?:[\w*${},\s]+\s+from\s+)?['"]\.\/[^'"]+['"]\s*;?\s*\n?/gm,
    ''
  );
}

function inlineAsIIFE({ file, exports: names }) {
  const src = stripModuleImports(fs.readFileSync(path.join(APP_DIR, file), 'utf8'))
    // Strip `export ` prefixes so declarations become plain locals inside the IIFE.
    .replace(/^export\s+/gm, '');
  const returnObj = `return { ${names.join(', ')} };`;
  const destructure = `const { ${names.join(', ')} } = (function() {\n${src}\n${returnObj}\n})();`;
  return destructure;
}

function stripRelativeImports(src) {
  // Removes any top-level `import ... from './something.js';` (including
  // multi-line bracketed imports). Leaves bare-specifier imports (e.g. 'three')
  // untouched because tests don't currently exercise those paths.
  return src.replace(
    /^import\s+(?:[\w*${},\s]+\s+from\s+)?['"]\.\/[^'"]+['"]\s*;?\s*\n?/gm,
    ''
  ).replace(
    /^import\s+(?:[\w*${},\s]+\s+from\s+)?['"]\/src\/[^'"]+['"]\s*;?\s*\n?/gm,
    ''
  );
}

function stripModuleSyntax(src) {
  return src
    .replace(/^import\s+(?:[\w*${},\s]+\s+from\s+)?['"][^'"]+['"]\s*;?\s*\n?/gm, '')
    .replace(/^export default\s*\{[\s\S]*$/m, '')
    .replace(/^export\s+/gm, '');
}

function buildPresetCalibrationShim() {
  const dspCalibration = stripModuleSyntax(fs.readFileSync(path.join(SRC_CORE_DIR, 'DspCalibration.js'), 'utf8'));
  const presetCalibration = stripModuleSyntax(fs.readFileSync(path.join(SRC_CORE_DIR, 'PresetCalibration.js'), 'utf8'));
  return `
const { bootstrapScenario } = (function _injectDspCalibration() {
  const SAMPLE_RATE = 48000;
${dspCalibration}
  return { bootstrapScenario };
})();
const {
  getCalibratedPresets,
  PRESET_REDIRECTS: CALIBRATED_PRESET_REDIRECTS,
  resolvePresetName: resolveCalibratedPresetName,
} = (function _injectPresetCalibration() {
${presetCalibration}
  return { getCalibratedPresets, PRESET_REDIRECTS, resolvePresetName };
})();
`;
}

function buildMediaTypesShim() {
  return fs.readFileSync(path.join(__dirname, '../../src/core/media-types.js'), 'utf8')
    .replace(/^export default\s*\{[\s\S]*$/m, '')
    .replace(/^export\s+/gm, '');
}

function buildPipelineShim() {
  return `
function clearStemCache() {}
function resetTimings() {}
function stageStart() {}
function stageEnd() {}
`;
}

function buildMediaDecodeShim() {
  return `
async function decodeBlobToAudioBuffer(file, hooks) {
  const onProgress = (hooks && hooks.onProgress) || (() => {});
  onProgress(50);
  const ab = await file.arrayBuffer();
  const abCopy = ab.slice(0);
  if (!this.ctx || typeof this.ctx.decodeAudioData !== 'function') {
    throw new Error('AudioContext decode unavailable');
  }
  const decoded = await this.ctx.decodeAudioData(abCopy);
  onProgress(100);
  return decoded;
}
async function resampleToCanonical(buffer) {
  return buffer;
}
function isDesktopShell() { return false; }
function isMicCaptureEnabled() { return false; }
async function pickAudioFile() { return null; }
function createYieldBudget() { return async () => {}; }
function yieldToBrowser() { return Promise.resolve(); }
function paintSeekFill() {}
function wireTransportRegion() { return null; }
async function saveExportBlob() { return null; }
function filtersForFilename() { return []; }
function inferMediaKind(file) {
  const name = (file && file.name) || '';
  const type = (file && file.type) || '';
  if (/video\\//i.test(type) || /\\.(mp4|mov|mkv|webm|avi|m4v)$/i.test(name)) return 'video';
  if (/audio\\//i.test(type) || /\\.(wav|mp3|flac|ogg|m4a|aac|opus|aiff|aif|wma|webm)$/i.test(name)) return 'audio';
  if (/midi/i.test(type) || /\\.(mid|midi)$/i.test(name)) return 'midi';
  // Unknown binary / extension — not media
  return 'unknown';
}
function isVideoSource(file) { return inferMediaKind(file) === 'video'; }
function triggerFileInput() {}
function primeAudioGesture() {}
function fixUploadTouchTargets() {}
function resetFileInput(input) { if (input) try { input.value = ''; } catch (_) {} }
function startWorkletStatusDriver() { return null; }
function buildHintPanel() { return null; }
function mountInfoPopover() { return () => {}; }
function removeAllInfoPopovers() {}
function sliceAudioBuffer(buf) { return buf; }
function exportVideoWithProcessedAudio() { return Promise.resolve(null); }
function triggerBlobDownload() {}
const WHISPER_HUNTER_IMPORTS = {};
`;
}

function getAppCode() {
  const preamble = buildDspCorePreamble();
  const inlined  = INLINED_MODULES.map(inlineAsIIFE).join('\n');
  const appJsRaw = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
  let appJsCode = stripRelativeImports(appJsRaw);
  if (appJsCode.includes('decodeBlobToAudioBuffer(file')) {
    appJsCode = appJsCode.replace(
      /const decoded = await decodeBlobToAudioBuffer\(file(?:,\s*\{[\s\S]*?\})?\);/,
      'const decoded = await decodeBlobToAudioBuffer.call(this, file);'
    );
  }
  const mediaTypesShim = buildMediaTypesShim();
  const presetCalibrationShim = buildPresetCalibrationShim();
  const mediaDecodeShim = buildMediaDecodeShim();
  const pipelineShim = buildPipelineShim();
  return preamble + '\n' + inlined + '\n' + presetCalibrationShim + '\n' + mediaTypesShim + '\n' + mediaDecodeShim + '\n' + pipelineShim + '\n' + appJsCode;
}

module.exports = getAppCode;
