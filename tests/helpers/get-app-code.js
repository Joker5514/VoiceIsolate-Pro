/**
 * Helper: get eval-ready app.js source.
 *
 * app.js now uses `import { SLIDER_REGISTRY, STAGES } from './slider-map.js'`
 * which is an ES module syntax that cannot be used inside vm.runInContext() or
 * new Function() bodies.  This helper resolves the import by:
 *   1. Reading slider-map.js and stripping `export` keywords so all declarations
 *      become plain locals.
 *   2. Reading app.js and removing the import statement.
 *   3. Concatenating slider-map definitions + app.js so SLIDER_REGISTRY and STAGES
 *      are in scope when the combined source is evaluated.
 *
 * Usage:
 *   const getAppCode = require('./helpers/get-app-code');
 *   const code = getAppCode();  // drop-in replacement for fs.readFileSync(appJsPath)
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '../../public/app');

function getAppCode() {
  const sliderMapSrc = fs.readFileSync(path.join(APP_DIR, 'slider-map.js'), 'utf8')
    .replace(/^export\s+/gm, '');

  const appJsRaw = fs.readFileSync(path.join(APP_DIR, 'app.js'), 'utf8');
  const appJsCode = appJsRaw.replace(
    /^import\s+\{[^}]+\}\s+from\s+'\.\/slider-map\.js'[^;\n]*;?\s*\n?/gm,
    ''
  );

  return sliderMapSrc + '\n' + appJsCode;
}

module.exports = getAppCode;
