'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Precision Studio shell', () => {
  test('landing keeps pipeline IDs and local-only copy', () => {
    const html = read('public/index.html');
    expect(html).toContain('id="fileInput"');
    expect(html).toContain('id="processBtn"');
    expect(html).toContain('id="waveCanvas"');
    expect(html).toContain('id="specCanvas"');
    expect(html).toContain('id="noiseReductionSlider"');
    expect(html).toContain('Clean voice.');
    expect(html).toContain('Keep the evidence.');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(html).toMatch(/No fabricated customer counts/);
    expect(html).toContain('sourceConfidencePanel');
    expect(html).toContain('No placeholder measurements');
  });

  test('landing title contract is unchanged', () => {
    const html = read('public/index.html');
    expect(html).toContain('VoiceIsolate Pro — Local voice isolation · Stem-Split &amp; Live-Mix');
  });

  test('engineer preserves IDs and adds workspace chrome', () => {
    const html = read('public/app/index.html');
    const js = read('public/app/engineer-console.js');
    const css = read('public/app/precision-studio.css');
    expect(html).toContain('id="processBtn"');
    expect(html).toContain('id="fileInput"');
    expect(html).toContain('data-hero-tier="creator"');
    expect(html).toContain('Quick');
    expect(html).not.toContain('fonts.googleapis.com');
    expect(js).toContain('psWorkspaceNav');
    expect(js).toContain('psFieldNav');
    expect(js).toContain('#section-processing');
    expect(css).toContain('ps-field-nav');
  });

  test('Quick alias maps to creator tier without dropping rack', () => {
    const js = read('public/app/workflow-tier.js');
    expect(js).toContain("id === 'quick'");
    expect(js).toContain("label: 'Quick'");
    expect(js).toContain("defaultFilterMode: 'all'");
  });

  test('download scopes offline claims and preserves provenance caution', () => {
    const html = read('public/download/index.html');
    expect(html).toMatch(/offline core isolation after install/i);
    expect(html).toMatch(/downloads require a network connection/i);
    expect(html).toMatch(/Current source can move ahead of published native packages/i);
    expect(html).toContain('VoiceIsolate-Pro-android-debug.apk');
    expect(html).toContain('release-provenance.json');
  });

  test('how-it-works distinguishes batch ML from Live-Mix', () => {
    const html = read('public/app/how-it-works.html');
    expect(html).toMatch(/Decode/);
    expect(html).toMatch(/Stem separation/i);
    expect(html).toMatch(/Live-Mix/);
    expect(html).toMatch(/never starts inference|Sliders do not retrigger/i);
  });

  test('tokens do not load CDN fonts or Inter as default', () => {
    const tokens = read('public/app/ds-tokens.css');
    expect(tokens).not.toContain('fonts.googleapis.com');
    expect(tokens).not.toMatch(/--font-ui:\s*['"]?Inter/);
    expect(tokens).toContain('--action-process');
    expect(tokens).toContain('--action-live');
  });

  test('no OpenAI or hosted inference added in UI surfaces', () => {
    const files = [
      'public/index.html',
      'public/ps-shell.css',
      'public/app/precision-studio.css',
      'public/app/engineer-console.js',
    ];
    for (const rel of files) {
      const txt = read(rel);
      expect(txt).not.toMatch(/api\.openai\.com|OpenAI API/i);
    }
  });
});
