/**
 * The processing spinner caps its frame rate with its own copy of the mobile
 * test (processing-overlay.js is a classic script and cannot import app.js).
 * Pin it to EngineerApp._isMobileEngineer() so the two cannot drift.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function body(src, start) {
  const i = src.indexOf(start);
  expect(i).toBeGreaterThanOrEqual(0);
  return src.slice(i, src.indexOf('\n  }\n', i));
}

describe('mobile predicate parity', () => {
  const engineer = body(read('public/app/app.js'), '_isMobileEngineer() {');
  const spinner = body(read('public/app/processing-overlay.js'), 'function isMobileDevice() {');

  test('same user-agent pattern', () => {
    const ua = /\/Android\|[^/]+\/i/;
    expect(spinner.match(ua)[0]).toBe(engineer.match(ua)[0]);
  });

  test('same deviceMemory threshold', () => {
    const mem = /deviceMemory > 0 && navigator\.deviceMemory <= (\d+)/;
    expect(spinner.match(mem)[1]).toBe(engineer.match(mem)[1]);
  });

  test('both honour a Capacitor native platform', () => {
    expect(engineer).toMatch(/Capacitor\??\.isNativePlatform/);
    expect(spinner).toMatch(/Capacitor\.isNativePlatform/);
  });
});
