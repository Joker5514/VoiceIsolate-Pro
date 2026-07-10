'use strict';

const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(__dirname, '../public/app/index.html'), 'utf8');
const howItWorksHtml = fs.readFileSync(path.join(__dirname, '../public/app/how-it-works.html'), 'utf8');
const styleCss = fs.readFileSync(path.join(__dirname, '../public/app/style.css'), 'utf8');

describe('Engineer Mode completion wiring', () => {
  test('index.html includes cinematic boot splash and startup banner placeholders', () => {
    expect(indexHtml).toContain('id="bootSplash"');
    expect(indexHtml).toContain('id="bootSplashText"');
    expect(indexHtml).toContain('id="vip-startup-banner"');
    expect(indexHtml).toContain('id="vip-startup-msg"');
  });

  test('index.html includes engine status pills expected by vip-boot.js', () => {
    ['engCtxPill', 'engWorkletPill', 'engGatePill', 'engDeessPill', 'engSabPill', 'engMlPill', 'engNetPill'].forEach((id) => {
      expect(indexHtml).toContain(`id="${id}"`);
    });
  });

  test('index.html includes model status containers and navigation links', () => {
    expect(indexHtml).toContain('id="modelStatusPills"');
    expect(indexHtml).toContain('id="cdnHealthPanel"');
    expect(indexHtml).toContain('href="how-it-works.html"');
    expect(indexHtml).toContain('href="/">Stem-Split</a>');
    expect(indexHtml).toContain('src="./dsp-bootstrap.js"');
    expect(indexHtml).toContain('rel="manifest"');
  });

  test('index.html loads visuals.js (classic, load-order-sensitive) and the processing-overlay module', () => {
    // visuals.js is intentionally a classic blocking <script> so VIP_INFERNO_LUT
    // and the premium init helpers are defined before visuals-bootstrap.js runs
    // (see the "LOAD ORDER VERIFIED" comments in index.html). It must NOT be
    // converted to a deferred/dynamic module. processing-overlay.js, by contrast,
    // is pulled in as a dynamic ES module.
    expect(indexHtml).toContain('src="./visuals.js"');
    expect(indexHtml).toContain("'./processing-overlay.js'");
  });

  test('index.html includes reset controls button and VU panel hook', () => {
    expect(indexHtml).toContain('id="resetSlidersBtn"');
    expect(indexHtml).toContain('id="panel-vu-meters"');
  });
});

describe('app.js completion helpers', () => {
  test('app.js imports ModelStatusUI for inline model diagnostics', () => {
    expect(appJs).toContain("import { ModelStatusUI } from './model-status-ui.js';");
  });

  test('app.js exposes STAGES on the app instance for overlay integration', () => {
    expect(appJs).toContain('this.STAGES = STAGES;');
  });

  test('app.js no longer leaves visualization methods as empty stubs', () => {
    expect(appJs).not.toContain('startSpectro() {}');
    expect(appJs).not.toContain('stopSpectro() {}');
    expect(appJs).not.toContain('startDiagnostics() {}');
  });

  test('app.js defines boot splash, model status, and pipeline progress helpers', () => {
    ['initBootSplash()', 'initModelStatusPanel()', 'updatePipelineProgress(stageIndex, detail, pct)', 'renderStaticVisuals('].forEach((snippet) => {
      expect(appJs).toContain(snippet);
    });
  });
});

describe('How It Works page', () => {
  test('how-it-works.html explains local-first architecture and STFT rule', () => {
    expect(howItWorksHtml).toContain('Privacy-first local processing');
    expect(howItWorksHtml).toContain('One forward STFT. In-place spectral work. One inverse STFT.');
    expect(howItWorksHtml).toContain('Back to Engineer Mode');
  });
});

describe('Theme polish styles', () => {
  test('style.css contains new boot splash and cockpit styling hooks', () => {
    ['.boot-splash', '.engine-cockpit', '.startup-banner', '.control-search-row', '.viz-legend'].forEach((selector) => {
      expect(styleCss).toContain(selector);
    });
  });
});
