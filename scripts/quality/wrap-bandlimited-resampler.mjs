/**
 * Write src/workers/BandlimitedResampler.js from the core module.
 * The classic worker cannot import ESM; MLWorker loads this file with importScripts.
 *
 *   node scripts/quality/wrap-bandlimited-resampler.mjs
 *   node scripts/quality/wrap-bandlimited-resampler.mjs --check
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ESM_PATH = path.join(ROOT, 'src/core/BandlimitedResampler.js');
const CLASSIC_PATH = path.join(ROOT, 'src/workers/BandlimitedResampler.js');

export function classicSource(esm) {
  const body = esm
    .replace(/^\/\*\*[\s\S]*?\*\/\n/, '')
    .replace(/^'use strict';\n+/, '')
    .replace(/^export function /gm, 'function ')
    .trim();
  return `/**
 * Classic-worker entry for the bandlimited resampler.
 *
 * Body of src/core/BandlimitedResampler.js with the ESM exports removed,
 * installed on \`self\` for MLWorker's importScripts. Regenerate with
 * \`node scripts/quality/wrap-bandlimited-resampler.mjs\`.
 * tests/bandlimited-resample.test.js expects this file to match.
 */
'use strict';
(function installBandlimitedResampler(scope) {
${body}
  scope.vipResampleMono = resampleMono;
  scope.vipResampleWindow = resampleWindow;
  scope.vipKernelRadius = kernelRadius;
  scope.vipSourceSpan = sourceSpan;
})(typeof self !== 'undefined' ? self : globalThis);
`;
}

function main() {
  const esm = fs.readFileSync(ESM_PATH, 'utf8');
  const next = classicSource(esm);
  if (process.argv.includes('--check')) {
    const current = fs.existsSync(CLASSIC_PATH) ? fs.readFileSync(CLASSIC_PATH, 'utf8') : '';
    if (current !== next) {
      console.error('src/workers/BandlimitedResampler.js is stale. Run: node scripts/quality/wrap-bandlimited-resampler.mjs');
      process.exit(1);
    }
    return;
  }
  fs.writeFileSync(CLASSIC_PATH, next);
  console.log(`wrote ${path.relative(ROOT, CLASSIC_PATH)} (${next.length} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
