/**
 * Landing mobile premium + first-impression structural suite.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public/landing.css'), 'utf8');

describe('Landing first-impression / mobile premium', () => {
  test('hero communicates local/privacy value prop', () => {
    expect(html).toMatch(/vip-hero/);
    expect(html).toMatch(/Clean voice\./i);
    expect(html).toMatch(/Keep the evidence\./i);
    expect(html).toMatch(/Zero telemetry/i);
    expect(html).toMatch(/Upload &amp; isolate|Upload & isolate/);
  });

  test('trust strip present', () => {
    expect(html).toMatch(/vip-trust/);
    expect(html).toMatch(/100% local/i);
    expect(html).toMatch(/no mic/i);
  });

  test('primary pipeline IDs preserved', () => {
    for (const id of [
      'uploadPanel',
      'uploadZone',
      'fileInput',
      'browseBtn',
      'processBtn',
      'noiseReductionSlider',
      'eqLowSlider',
      'clearLocalDataBtn',
      'ortProviderHint',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test('advanced mix is collapsible (details) but keeps slider IDs', () => {
    expect(html).toMatch(/<details[^>]*class="[^"]*vip-advanced/);
    expect(html).toContain('id="eqMidSlider"');
    expect(html).toContain('id="gateThresholdSlider"');
  });

  test('no main-thread ORT on landing (worker importScripts instead)', () => {
    expect(html).not.toMatch(/<script[^>]+ort\.min\.js/);
  });

  test('scripts are deferred where classic', () => {
    expect(html).toMatch(/<script defer src="\/lib\/react-mini\.js"/);
    expect(html).toMatch(/<script defer src="\/lib\/_ds_bundle\.js"/);
    expect(html).toMatch(/type="module" src="\/landing\.js"/);
  });

  test('fonts are local/system only (no CDN Outfit/Inter)', () => {
    expect(html).not.toMatch(/fonts\.googleapis\.com/);
    expect(html).not.toMatch(/fonts\.gstatic\.com/);
    expect(css).toMatch(/ui-sans-serif/);
    expect(css).not.toMatch(/--font-ui:\s*['"]?Inter/);
  });

  test('CSS enforces mobile tap targets and hero layout', () => {
    expect(css).toContain('.vip-hero');
    expect(css).toContain('min-height: 44px');
    expect(css).toMatch(/@media \(max-width: 560px\)/);
    expect(css).toMatch(/body::after[\s\S]*animation:\s*none/);
  });

  test('meta description is privacy/local conversion focused', () => {
    expect(html).toMatch(/meta name="description"[^>]*100% on your device|on your device/);
    expect(html).toMatch(/theme-color/);
  });
});
