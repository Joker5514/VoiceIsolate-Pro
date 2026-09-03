/**
 * Shared design-system semantic token parity.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const tokens = fs.readFileSync(path.join(__dirname, '../public/app/ds-tokens.css'), 'utf8');
const premium = fs.readFileSync(path.join(__dirname, '../public/premium-refresh.css'), 'utf8');

describe('VoiceIsolate semantic design tokens', () => {
  test('canonical token file owns process/live/status semantics', () => {
    expect(tokens).toContain('--action-process:#ff3d4d');
    expect(tokens).toContain('--action-live:   #2ed5e5');
    expect(tokens).toContain('--state-success: #31cf7d');
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

  test('premium shell uses semantic process/live tokens for interactive controls', () => {
    expect(premium).toContain('.ps-btn--process { background: var(--action-process)');
    expect(premium).toContain("input[type='range'] { accent-color: var(--action-live);");
  });
});
