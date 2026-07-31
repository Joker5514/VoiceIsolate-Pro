/**
 * Engineer Mode mobile freeze / responsiveness structural suite.
 * Runs ≥10 independent checks (requested regression coverage).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const mlWorker = fs.readFileSync(path.join(ROOT, 'src/workers/MLWorker.js'), 'utf8');
const yieldJs = fs.readFileSync(path.join(ROOT, 'src/pipeline/ui-yield.js'), 'utf8');
const analysis = fs.readFileSync(path.join(ROOT, 'public/app/lib/analysis-workspace.js'), 'utf8');

describe('Engineer mobile freeze suite (10+ checks)', () => {
  test('1. mobile engineer detector exists', () => {
    expect(appJs).toContain('_isMobileEngineer');
  });

  test('2. mid-channel plan is async with yield budget', () => {
    expect(appJs).toMatch(/async _mlChannelPlan/);
    expect(appJs).toMatch(/createYieldBudget/);
  });

  test('3. stereo expand is async with yields', () => {
    expect(appJs).toMatch(/async _expandMonoCleanToStereo/);
  });

  test('4. play uses original while processing', () => {
    expect(appJs).toMatch(/wantProcessed = this\.abMode === 'processed' && !this\.isProcessing/);
  });

  test('5. mobile skips idle ML warmup on handleFile', () => {
    expect(appJs).toMatch(/mobileSkipWarm/);
  });

  test('6. mobile spectral FFT is lighter', () => {
    expect(appJs).toMatch(/mobile \? 1024 : 2048/);
  });

  test('7. MLWorker adaptive hop is more aggressive on mobile', () => {
    expect(mlWorker).toMatch(/base \* 16/);
    expect(mlWorker).toMatch(/always at least 2× on mobile|else hop = base \* 2/);
  });

  test('8. yield helpers prefer scheduler.yield / rAF', () => {
    expect(yieldJs).toContain('scheduler.yield');
    expect(yieldJs).toContain('requestAnimationFrame');
  });

  test('9. analysis does not await USM before process', () => {
    expect(analysis).toMatch(/void runUsmBackend/);
    expect(analysis).not.toMatch(/await runUsmBackend\(\{ mode: 'auto', numSources: 6 \}\);\s*\n\s*const rec/);
  });

  test('10. single-pass isolation only', () => {
    expect(appJs).toMatch(/let totalPasses = 1/);
  });

  test('11. mobile defers heavy spectro paint', () => {
    expect(appJs).toMatch(/requestIdleCallback/);
    expect(appJs).toMatch(/Lightweight spectro later/);
  });

  test('12. transferOwned mid path still used', () => {
    expect(appJs).toContain('transferOwned: true');
  });
});
