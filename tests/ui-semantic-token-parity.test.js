/**
 * Shared design-system semantic token parity.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const tokens = fs.readFileSync(path.join(ROOT, 'public/app/ds-tokens.css'), 'utf8');
const landing = fs.readFileSync(path.join(ROOT, 'public/landing.css'), 'utf8');
const shell = fs.readFileSync(path.join(ROOT, 'public/ps-shell.css'), 'utf8');
const premium = fs.readFileSync(path.join(ROOT, 'public/premium-refresh.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

describe('VoiceIsolate semantic design tokens', () => {
  test('canonical token file owns process/live/status semantics', () => {
    expect(tokens).toContain('--action-process:#ff3d4d');
    expect(tokens).toContain('--action-live:   #2ed5e5');
    expect(tokens).toContain('--state-success: #31cf7d');
  });

  test('shared Precision Studio shell imports canonical tokens', () => {
    expect(shell).toContain("@import url('/app/ds-tokens.css');");
  });

  test('legacy landing declarations load before the canonical shell and cannot win the cascade', () => {
    // landing.css still contains maintenance-era aliases. Keep them harmless by
    // requiring ps-shell.css (which imports ds-tokens.css) to load immediately
    // after it, before any premium extension sheet.
    expect(landing).toContain('--action-process: #ff3d4d');
    const landingPos = indexHtml.indexOf('href="/landing.css"');
    const shellPos = indexHtml.indexOf('href="/ps-shell.css"');
    const premiumPos = indexHtml.indexOf('href="/premium-refresh.css"');
    expect(landingPos).toBeGreaterThan(0);
    expect(shellPos).toBeGreaterThan(landingPos);
    expect(premiumPos).toBeGreaterThan(shellPos);
  });

  test('premium landing does not redefine canonical semantic roles', () => {
    for (const token of [
      '--surface-root:',
      '--surface-panel:',
      '--surface-raised:',
      '--border-subtle:',
      '--text-primary:',
      '--text-secondary:',
      '--action-process:',
      '--action-live:',
      '--state-success:',
      '--radius-sm:',
      '--radius-md:',
      '--radius-lg:',
      '--radius-xl:',
    ]) {
      expect(premium).not.toContain(token);
    }
  });

  test('real landing Process action and live controls use shared semantics', () => {
    expect(premium).toContain('#processBtn { background: var(--action-process)');
    expect(premium).toContain("input[type='range'] { accent-color: var(--action-live);");
  });
});
