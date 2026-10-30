/**
 * Regression: debug-audit.js wiring in public/app/index.html
 *
 * RCA: The debug menu's "RUN AUDIT" button calls `window.VIP_runAudit`, which
 * is defined only in debug-audit.js, but that file was never imported in
 * index.html. Clicking "RUN AUDIT" always showed "VIP_runAudit not available".
 *
 * Fix: `import('./debug-audit.js')` added alongside `import('./debug-menu.js')`
 * in the module boot block of public/app/index.html.
 *
 * These tests verify the fix is present and cannot regress silently.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const INDEX_HTML = path.join(__dirname, '..', 'public', 'app', 'index.html');
const DEBUG_AUDIT_JS = path.join(__dirname, '..', 'public', 'app', 'debug-audit.js');

const html = fs.readFileSync(INDEX_HTML, 'utf8');
const auditSrc = fs.readFileSync(DEBUG_AUDIT_JS, 'utf8');

describe('debug-audit.js wiring', () => {
  test('DA-01: debug-audit.js is imported in public/app/index.html', () => {
    // The import must appear in the module boot block.
    expect(html).toContain("import('./debug-audit.js')");
  });

  test('DA-02: debug-audit.js import appears after debug-menu.js import', () => {
    const menuIdx  = html.indexOf("import('./debug-menu.js')");
    const auditIdx = html.indexOf("import('./debug-audit.js')");
    expect(menuIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(-1);
    // debug-audit.js must come AFTER debug-menu.js so VIP_runAudit is defined
    // before (or at the same time as) the menu button that calls it.
    expect(auditIdx).toBeGreaterThan(menuIdx);
  });

  test('DA-03: debug-audit.js defines window.VIP_runAudit', () => {
    // Verify the source file still contains the assignment that caused the
    // "not available" error when it was missing.
    expect(auditSrc).toContain('window.VIP_runAudit');
  });

  test('DA-04: debug-menu.js calls window.VIP_runAudit — not a hardcoded string', () => {
    const menuSrc = fs.readFileSync(
      path.join(__dirname, '..', 'public', 'app', 'debug-menu.js'),
      'utf8',
    );
    // The guard that produced "VIP_runAudit not available" must still be present
    // (it is a feature, not dead code) and must not have been changed to skip
    // the check or substitute a no-op.
    expect(menuSrc).toContain("typeof window.VIP_runAudit === 'function'");
    expect(menuSrc).toContain('window.VIP_runAudit()');
  });

  test('DA-05: debug-audit.js export is a real async function, not a stub', () => {
    // The earlier version of debug-audit.js returned a placeholder string.
    // Verify the assignment wraps the real runVipAudit async function.
    expect(auditSrc).toMatch(/window\.VIP_runAudit\s*=\s*runVipAudit/);
    expect(auditSrc).toContain('async function runVipAudit');
  });

  test('DA-06: debug-audit.js audit function returns a results object', () => {
    // runVipAudit must write window.VIP_AUDIT_RESULTS and return it so callers
    // can await the result instead of relying solely on console output.
    expect(auditSrc).toContain('window.VIP_AUDIT_RESULTS');
    expect(auditSrc).toContain('return window.VIP_AUDIT_RESULTS');
  });
});
