'use strict';

const fs = require('fs');
const path = require('path');

const workletJs = fs.readFileSync(
  path.join(__dirname, '../src/presentation/WorkletStatus.js'),
  'utf8'
);
const appJs = fs.readFileSync(
  path.join(__dirname, '../public/app/app.js'),
  'utf8'
);
const indexHtml = fs.readFileSync(
  path.join(__dirname, '../public/app/index.html'),
  'utf8'
);

describe('WorkletStatus.js', () => {
  test('exports gate and deesser pill ids from manifest', () => {
    expect(workletJs).toContain('engGatePill');
    expect(workletJs).toContain('engDeessPill');
    expect(workletJs).toContain('vip-gate');
    expect(workletJs).toContain('vip-deesser');
  });

  test('maps mixer load states to cockpit pill states', () => {
    expect(workletJs).toContain("case 'loaded': return 'ready'");
    expect(workletJs).toContain("case 'pending': return 'loading'");
    expect(workletJs).toContain("case 'failed': return 'error'");
  });

  test('aggregateWorkletPill reports loading while any worklet pending', () => {
    expect(workletJs).toContain("states.some((s) => s === 'pending')");
  });
});

describe('Engineer Mode worklet wiring', () => {
  test('index.html includes per-worklet cockpit pills', () => {
    expect(indexHtml).toContain('id="engGatePill"');
    expect(indexHtml).toContain('id="engDeessPill"');
    expect(indexHtml).toContain('vip-gate');
    expect(indexHtml).toContain('vip-deesser');
  });

  test('app.js starts WorkletStatus driver and dedupes ML warmup', () => {
    expect(appJs).toContain("from '/src/presentation/WorkletStatus.js'");
    expect(appJs).toContain('startWorkletStatusDriver');
    expect(appJs).toContain('_mlWarmupDone');
    expect(appJs).toContain('workletsReady');
  });
});