/**
 * Helper: get eval-ready app.js source.
 *
 * app.js uses ES module imports:
 *   import { SLIDER_REGISTRY, STAGES } from './slider-map.js';
 *   import { ModelStatusUI } from './model-status-ui.js';
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
  { file: 'slider-map.js',       exports: ['SLIDER_REGISTRY', 'STAGES'] },
  { file: 'model-status-ui.js',  exports: ['ModelStatusUI'] },
];

function inlineAsIIFE({ file, exports: names }) {
  const src = fs.readFileSync(path.join(APP_DIR, file), 'utf8')
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
  );
}

function getAppCode() {
  const inlined = INLINED_MODULES.map(inlineAsIIFE).join('\n');
  const appJsRaw = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
  const appJsCode = stripRelativeImports(appJsRaw);
  return inlined + '\n' + appJsCode;
}

module.exports = getAppCode;
