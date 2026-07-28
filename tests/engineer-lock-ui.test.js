/**
 * Engineer Mode — slider lock visual state + process pause + A/B + collapsibles.
 * DOM-level contracts (no browser paint — assert class/token wiring).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const styleCss = fs.readFileSync(path.join(ROOT, 'public/app/style.css'), 'utf8');
const themeCss = fs.readFileSync(path.join(ROOT, 'public/app/slider-theme.css'), 'utf8');
const ticksCss = fs.readFileSync(path.join(ROOT, 'public/app/slider-ticks.css'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');

describe('slider lock accent token (cyan protected)', () => {
  test('style.css defines --vip-lock-accent and uses it for locked state', () => {
    expect(styleCss).toMatch(/--vip-lock-accent\s*:\s*#67e8f9/i);
    expect(styleCss).toMatch(/var\(--vip-lock-accent/);
    // No amber lock hardcodes in locked thumb/row rules
    expect(styleCss).not.toMatch(/data-locked[\s\S]{0,200}#ffcc44/);
  });

  test('slider-theme.css lock tokens are cyan, not amber', () => {
    expect(themeCss).toMatch(/--vip-lock-accent\s*:\s*#67e8f9/i);
    expect(themeCss).not.toMatch(/--vip-lock\s*:\s*#ffcc44/);
    expect(themeCss).toMatch(/var\(--vip-lock-accent/);
  });

  test('slider-ticks.css locked ticks use cyan, not amber', () => {
    expect(ticksCss).toMatch(/\.slider-tick-wrapper\.is-locked/);
    expect(ticksCss).toMatch(/103,\s*232,\s*249/);
    expect(ticksCss).not.toMatch(/255,\s*204,\s*68/);
  });

  test('locked computed color path: data-locked + is-locked both wired', () => {
    expect(styleCss).toMatch(/\[data-locked="true"\]/);
    expect(themeCss).toMatch(/\.is-locked/);
    expect(ticksCss).toMatch(/\.is-locked/);
  });
});

describe('process pauses playback contract', () => {
  test('runPipeline pauses when playing and restores without auto-resume', () => {
    expect(appSrc).toMatch(/_pausedForProcess/);
    expect(appSrc).toMatch(/_playheadBeforeProcess/);
    expect(appSrc).toMatch(/_setTransportProcessingState/);
    expect(appSrc).toMatch(/pause-before-process failed/);
    // finally must clear processing transport state
    expect(appSrc).toMatch(/_setTransportProcessingState\(false\)/);
    // Extract only the runPipeline finally block (anchor on isProcessing unlock)
    const pipeFinally = appSrc.match(
      /this\.isProcessing = false;\s*\/\/ Restore transport controls[\s\S]*?this\._playheadBeforeProcess = null;/,
    );
    expect(pipeFinally).toBeTruthy();
    expect(pipeFinally[0]).not.toMatch(/this\.play\s*\(/);
    expect(pipeFinally[0]).toMatch(/seekTo|_playheadBeforeProcess/);
  });

  test('isProcessing guard prevents overlapping Process', () => {
    expect(appSrc).toMatch(/if \(this\.isProcessing\)[\s\S]{0,80}already in progress/);
  });
});

describe('A/B Compare Original transport', () => {
  test('transport exposes Compare Original control', () => {
    expect(indexHtml).toMatch(/Compare Original/);
    expect(indexHtml).toMatch(/id="tpAB"/);
  });

  test('toggleAB swaps modes and updates label structure', () => {
    expect(appSrc).toMatch(/toggleAB\s*\(/);
    expect(appSrc).toMatch(/abMode === 'original' \? 'processed' : 'original'/);
    expect(appSrc).toMatch(/tp-ab-name/);
  });
});

describe('collapsible panels + persistence', () => {
  test('analysis workspace and key sections are details/summary', () => {
    expect(indexHtml).toMatch(/id="section-analysis"/);
    expect(indexHtml).toMatch(/id="section-upload"/);
    expect(indexHtml).toMatch(/id="section-presets"/);
    expect(indexHtml).toMatch(/id="section-whisper-hunter"/);
    expect(indexHtml).toMatch(/id="sourceMatrixPanel"/);
    expect(indexHtml).toMatch(/vip-section-summary/);
  });

  test('collapsible open state persisted in localStorage', () => {
    expect(appSrc).toMatch(/vip\.engineer\.sectionOpen\.v1/);
    expect(appSrc).toMatch(/_initCollapsibleSections/);
    expect(appSrc).toMatch(/addEventListener\('toggle'/);
  });
});

describe('data-flow documentation in app.js', () => {
  test('documents Upload → Analyze → Process → A-B → Export path', () => {
    expect(appSrc).toMatch(/Engineer Mode data flow/);
    expect(appSrc).toMatch(/Upload/);
    expect(appSrc).toMatch(/FullAnalysisWorker/);
    expect(appSrc).toMatch(/USM/);
    expect(appSrc).toMatch(/toggleAB/);
    expect(appSrc).toMatch(/Export/);
  });
});

describe('worker heartbeats', () => {
  const fullWorker = fs.readFileSync(path.join(ROOT, 'src/workers/FullAnalysisWorker.js'), 'utf8');
  const usmWorker = fs.readFileSync(path.join(ROOT, 'src/workers/USMWorker.js'), 'utf8');
  const host = fs.readFileSync(path.join(ROOT, 'src/pipeline/FullAnalysisHost.js'), 'utf8');

  test('FullAnalysisWorker posts heartbeat messages', () => {
    expect(fullWorker).toMatch(/heartbeat/);
    expect(fullWorker).toMatch(/setInterval/);
  });

  test('USMWorker posts heartbeat messages', () => {
    expect(usmWorker).toMatch(/heartbeat/);
    expect(usmWorker).toMatch(/separateUniversal/);
  });

  test('FullAnalysisHost treats heartbeat as activity and supports stall timeout', () => {
    expect(host).toMatch(/heartbeat/);
    expect(host).toMatch(/stalled|stallMs/);
  });
});
