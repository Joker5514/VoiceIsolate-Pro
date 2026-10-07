/**
 * The processing spinner caps its frame rate with its own copy of the mobile
 * test (processing-overlay.js is a classic script and cannot import app.js).
 * Pin it to EngineerApp._isMobileEngineer() so the two cannot drift.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

function body(src, start, file) {
  const i = src.indexOf(start);
  if (i < 0) throw new Error(`${file}: anchor "${start}" not found`);
  return src.slice(i, src.indexOf('\n  }\n', i));
}

function pick(text, re, group, label) {
  const m = text.match(re);
  expect({ [label]: m ? m[group] : null }).not.toEqual({ [label]: null });
  return m[group];
}

describe('mobile predicate parity', () => {
  const engineer = body(read('public/app/app.js'), '_isMobileEngineer() {', 'app.js');
  const spinner = body(read('public/app/processing-overlay.js'), 'function isMobileDevice() {', 'processing-overlay.js');

  test('same user-agent pattern', () => {
    const ua = /\/Android\|[^/]+\/i/;
    expect(pick(spinner, ua, 0, 'spinner UA pattern')).toBe(pick(engineer, ua, 0, 'engineer UA pattern'));
  });

  test('same deviceMemory threshold', () => {
    const mem = /deviceMemory > 0 && navigator\.deviceMemory <= (\d+)/;
    expect(pick(spinner, mem, 1, 'spinner deviceMemory')).toBe(pick(engineer, mem, 1, 'engineer deviceMemory'));
  });

  test('both honour a Capacitor native platform', () => {
    expect(engineer).toMatch(/Capacitor\??\.isNativePlatform/);
    expect(spinner).toMatch(/Capacitor\.isNativePlatform/);
  });
});
