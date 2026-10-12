/**
 * F25 — `pnpm lint` covers every shipped first-party group, and module files
 * are parsed as modules (a script sourceType stops linting at the first export).
 */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const { ESLint } = require('eslint');

const ROOT = path.join(__dirname, '..');
const lintScript = require('../package.json').scripts.lint;
const targets = lintScript.replace(/^eslint\s+/, '').split(/\s+/).filter((t) => !t.startsWith('-'));

function covered(file) {
  return targets.some((t) => {
    if (t === 'public/*.js') return /^public\/[^/]+\.js$/.test(file);
    return file === t || file.startsWith(`${t}/`);
  });
}

test('every tracked first-party script outside tests, docs and vendored libs is linted', () => {
  const files = execFileSync('git', ['ls-files', '*.js', '*.cjs', '*.mjs'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter((f) => !/^(tests|docs|public\/lib)\//.test(f) && f !== 'eslint.config.js');
  expect(files.length).toBeGreaterThan(250);
  expect(files.filter((f) => !covered(f))).toEqual([]);
});

test.each([
  ['public/app/session-persist.js', 'module'],
  ['public/app/app.js', 'module'],
  ['public/app/dsp-processor.js', 'script'],
  ['src/workers/MLWorker.js', 'script'],
  ['src/workers/AudioEncoderWorker.js', 'module'],
  ['api-routes/store.js', 'module'],
  ['electron/sam-proxy.cjs', 'commonjs'],
  ['packages/vip-sam-runtime/index.js', 'module'],
])('%s is parsed as %s', async (file, sourceType) => {
  const config = await new ESLint({ cwd: ROOT }).calculateConfigForFile(path.join(ROOT, file));
  expect(config.languageOptions.sourceType).toBe(sourceType);
});

test('session-persist.js lints without a parse error', async () => {
  const [result] = await new ESLint({ cwd: ROOT }).lintFiles([path.join(ROOT, 'public/app/session-persist.js')]);
  expect(result.messages.filter((m) => m.fatal || m.severity === 2)).toEqual([]);
});
