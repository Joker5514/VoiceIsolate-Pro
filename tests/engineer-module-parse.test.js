/**
 * Every module the Engineer shell imports must parse. index.html catches and
 * logs import failures, and many contracts read these files as text, so a
 * syntax error otherwise ships with green unit tests.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const APP = path.join(__dirname, '..', 'public', 'app');
const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const imported = [...new Set([...html.matchAll(/import\(\s*'\.\/([^']+\.js)'\s*\)/g)].map((m) => m[1]))];

test('index.html dynamically imports the Engineer modules', () => {
  expect(imported).toEqual(expect.arrayContaining(['app.js', 'vip-fixes.js', 'engineer-console.js']));
});

test.each(imported)('public/app/%s parses as an ES module', (file) => {
  const res = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: fs.readFileSync(path.join(APP, file), 'utf8'),
    encoding: 'utf8',
  });
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
});
