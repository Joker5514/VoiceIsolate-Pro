/**
 * Helper: get eval-ready app.js source.
 *
 * app.js uses ES module imports:
 *   import { SLIDER_REGISTRY, STAGES } from './slider-map.js';
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

// Sibling modules imported by app.js. The `exports` list must include every
// symbol app.js destructures from that module.
const INLINED_MODULES = [
  { file: 'slider-calibration.js', exports: ['calibrateRegistry'] },
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

function buildMediaDecodeShim() {
  return `
async function decodeBlobToAudioBuffer(file) {
  const ab = await file.arrayBuffer();
  const abCopy = ab.slice(0);
  if (!this.ctx || typeof this.ctx.decodeAudioData !== 'function') {
    throw new Error('AudioContext decode unavailable');
  }
  return this.ctx.decodeAudioData(abCopy);
}
async function resampleToCanonical(buffer) {
  return buffer;
}
`;
}

function getAppCode() {
  const preamble = buildDspCorePreamble();
  const inlined  = INLINED_MODULES.map(inlineAsIIFE).join('\n');
  const appJsRaw = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
  let appJsCode = stripRelativeImports(appJsRaw);
  if (appJsCode.includes('decodeBlobToAudioBuffer(file)')) {
    appJsCode = appJsCode.replace(
      'const decoded = await decodeBlobToAudioBuffer(file);',
      'const decoded = await decodeBlobToAudioBuffer.call(this, file);'
    );
  }
  const mediaDecodeShim = buildMediaDecodeShim();
  return preamble + '\n' + inlined + '\n' + mediaDecodeShim + '\n' + appJsCode;
}

module.exports = getAppCode;
