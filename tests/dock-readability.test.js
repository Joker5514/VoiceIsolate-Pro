/**
 * The fixed transport dock must keep its status readable and leave the
 * phone field nav clickable.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '../public/app/premium-audio-control.css'), 'utf8');

describe('transport dock readability', () => {
  test('the status line ellipsizes instead of pushing the process button away', () => {
    const block = css.slice(css.lastIndexOf(':is(body.eng-console, body.v3) .pac-ready'));
    expect(block).toMatch(/flex:\s*1 1 0/);
    expect(block).toMatch(/text-overflow:\s*ellipsis/);
    expect(block).toMatch(/min-width:\s*0/);
    expect(css).toMatch(/#landingProcessBar[\s\S]{0,80}flex:\s*0 0 auto/);
  });

  test('narrow process controls keep a 44px target', () => {
    expect(css).toMatch(/@media \(max-width: 768px\) \{[\s\S]*body\.v3 #processBtn[\s\S]*min-height:\s*44px/);
  });

  test('the engineer dock clears the fixed field nav', () => {
    expect(css).toMatch(/@media \(max-width: 640px\) \{[\s\S]*transport-card\.pac \{[\s\S]*bottom:\s*calc\(var\(--ps-field-nav-h, 64px\)/);
  });
});
