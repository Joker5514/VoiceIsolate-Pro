/**
 * Engineer Console session, Nov 17: three Process runs on one file gave
 * calibrated levels of -24.87, -44.73 and -56.05 dBFS, with ML
 * fromCache:false every time. With the same file and unchanged controls the
 * app reuses retained stems and calibrates to the same value every time
 * (reproduced 3/3, bit-identical). A fresh ML run means the Process-time
 * revision changed, so a Process-time control moved between runs. The log
 * recorded neither the revision nor which controls moved.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let PS;
beforeAll(async () => { PS = await import('../src/core/ParameterSchema.js'); });

describe('diffProcessingConfig', () => {
  test('first Process has no previous snapshot', () => {
    const cfg = PS.buildMlProcessingConfig({ nrAmount: 40 });
    expect(PS.diffProcessingConfig(null, cfg)).toEqual({ previousRevision: null, revision: cfg.revision, changed: {} });
  });

  test('identical controls give an identical revision and no changes', () => {
    const a = PS.buildMlProcessingConfig({ nrAmount: 40, whisperMode: 0 });
    const b = PS.buildMlProcessingConfig({ nrAmount: 40, whisperMode: 0 });
    expect(PS.diffProcessingConfig(a, b)).toEqual({ previousRevision: a.revision, revision: a.revision, changed: {} });
  });

  test('names every Process-time control that moved, with from and to', () => {
    const a = PS.buildMlProcessingConfig({ nrAmount: 40, whisperMode: 0, whisperLift: 0 });
    const b = PS.buildMlProcessingConfig({ nrAmount: 55, whisperMode: 1, whisperLift: 18 });
    const d = PS.diffProcessingConfig(a, b);
    expect(d.previousRevision).toBe(a.revision);
    expect(d.revision).toBe(b.revision);
    expect(d.revision).not.toBe(d.previousRevision);
    expect(d.changed).toEqual({
      'spectral.nrAmount': [40, 55],
      'spectral.whisperMode': [0, 1],
      'spectral.whisperLift': [0, 18],
    });
  });

  test('Live-Mix-only controls never appear (they do not change stems)', () => {
    const a = PS.buildMlProcessingConfig({ outGain: 1, gateThresh: -50 });
    const b = PS.buildMlProcessingConfig({ outGain: 6, gateThresh: -68 });
    expect(PS.diffProcessingConfig(a, b).changed).toEqual({});
  });
});

describe('Engineer log lines', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public/app/app.js'), 'utf8');

  test('every Process logs its snapshot and what moved since the last one', () => {
    const start = app.indexOf('const processingRevision = processingConfig.revision;');
    const window = app.slice(start, start + 900);
    expect(window).toMatch(/this\._processSnapshotDiff\(processingConfig\)/);
    expect(window).toMatch(/structuredLog\('info', '\[VIP\] Process-time snapshot'/);
    const m = app.indexOf('\n  _processSnapshotDiff(processingConfig) {');
    const body = app.slice(m, app.indexOf('\n  }\n', m));
    expect(body).toMatch(/diffProcessingConfig\(prev \|\| buildMlProcessingConfig\(\{\}\), processingConfig\)/);
    expect(body).toMatch(/this\._lastProcessingConfig = processingConfig;/);
  });

  test('auto-calibration names the stems revision it measured', () => {
    const start = app.indexOf("structuredLog('info', '[VIP] Auto-calibrated mix', {");
    const block = app.slice(start, app.indexOf('});', start));
    expect(block).toMatch(/processingRevision: this\._stemProcessingRevision \?\? null/);
  });
});
