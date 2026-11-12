/**
 * Engineer header, debug pipeline row, and Live-Mix bridge share one word.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('sharedSessionStatus', () => {
  let sharedSessionStatus;

  beforeAll(async () => {
    ({ sharedSessionStatus } = await import('../src/core/SessionStatus.js'));
  });

  test('keeps the pipeline vocabulary and rejects a fake booting state', () => {
    for (const word of ['IDLE', 'LOADING', 'READY', 'PROCESSING', 'DONE', 'ERROR']) {
      expect(sharedSessionStatus(word)).toBe(word);
      expect(sharedSessionStatus(word.toLowerCase())).toBe(word);
    }
    expect(sharedSessionStatus('BOOTING')).toBe('IDLE');
    expect(sharedSessionStatus('')).toBe('IDLE');
    expect(sharedSessionStatus(null)).toBe('IDLE');
  });
});

describe('the three readouts use that word', () => {
  const app = read('public/app/app.js');
  const menu = read('public/app/debug-menu.js');

  test('setStatus writes the header and the pipeline badge together', () => {
    expect(app).toContain("import { sharedSessionStatus } from '/src/core/SessionStatus.js'");
    expect(app).toMatch(/setStatus\(s\)\s*\{[\s\S]*sharedSessionStatus\(s\)[\s\S]*hStatus[\s\S]*vip-proc-badge/);
    expect(app).not.toContain('processing pipeline starting');
    expect(app).toContain('File decoded — press Process to isolate');
  });

  test('the debug panel does not invent BOOTING', () => {
    expect(menu).toContain("import { sharedSessionStatus } from '/src/core/SessionStatus.js'");
    expect(menu).toContain('sharedSessionStatus(');
    expect(menu).not.toMatch(/['"]booting['"]/);
    expect(menu).toMatch(/dbgWkBridge[\s\S]{0,240}session/);
  });

  test('the debug footer stays inside the panel above the dock', () => {
    const css = read('public/app/debug-menu.css');
    expect(css).toContain('max-height: calc(100dvh - 52px - 72px)');
    expect(css).toContain('min-height: 0');
    expect(css).toContain('max-height: calc(100dvh - 52px - 72px - 64px)');
  });

  test('the header Export button explains a disabled save', () => {
    const consoleJs = read('public/app/engineer-console.js');
    expect(consoleJs).toContain('Nothing to export yet');
    expect(consoleJs).toContain('exportProjectPackBtn');
  });
});
