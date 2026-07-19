/**
 * Desktop visualizations — horizontal scroll + correct sizing guards.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'public/app/style.css'), 'utf8');
const bootstrap = fs.readFileSync(path.join(ROOT, 'public/app/visuals-bootstrap.js'), 'utf8');

describe('Desktop viz layout CSS', () => {
  test('does not force absolute layout on every id containing "spectrogram"', () => {
    // Historical bug: [id*='spectrogram'] matched #tab-spectrogram / #btn-spectrogram
    // and broke desktop column sizing + tab rail horizontal scroll.
    expect(css).not.toMatch(/\[id\*=['"]spectrogram['"]\]/);
    expect(css).not.toMatch(/\[class\*=['"]spectrogram['"]\]/);
  });

  test('main grid right column can shrink (minmax 0) for scroll hosts', () => {
    expect(css).toMatch(/grid-template-columns:\s*minmax\([^)]+\)\s*minmax\(0,\s*1fr\)/);
    expect(css).toMatch(/\.col-left,\s*\.col-right\{min-width:0/);
  });

  test('viz tab rail owns horizontal scroll with min-width 0', () => {
    expect(css).toMatch(/\.viz-tab-rail__scroll\{[\s\S]*?overflow-x:\s*auto/);
    expect(css).toMatch(/\.viz-tab-rail__scroll\{[\s\S]*?min-width:\s*0/);
    expect(css).toMatch(/\.viz-card \.tabs\{[\s\S]*?flex-wrap:\s*nowrap/);
  });

  test('viz canvases cap at 100% width', () => {
    expect(css).toMatch(/\.viz-canvas\{[^}]*max-width:\s*100%/);
    expect(css).toMatch(/\.viz-card\{[^}]*min-width:\s*0/);
  });
});

describe('Canvas resize fluid sizing', () => {
  test('resize uses 100% width (not fixed px lock) for desktop reflow', () => {
    expect(bootstrap).toContain("canvas.style.width = '100%'");
    expect(bootstrap).toContain('_measureCanvasCss');
    expect(bootstrap).toMatch(/closest\?\.\(['"]\.viz-card/);
  });

  test('observes col-right and tab scroll for desktop layout', () => {
    expect(bootstrap).toContain("'.col-right'");
    expect(bootstrap).toContain("getElementById('vizTabScroll')");
  });
});
