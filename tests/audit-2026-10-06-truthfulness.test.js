/**
 * Audit 2026-10-06 regressions: UI must not report work that did not happen.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const app = read('public/app/app.js');
const landing = read('public/landing.js');
const canvas = read('public/app/lib/signal-canvas-integration.js');

describe('audit 2026-10-06 truthfulness', () => {
  test('AUD-005: no-engine fallback throws instead of returning the input as processed', () => {
    const body = app.slice(app.indexOf('async _runFallbackPipeline('), app.indexOf('// Stereo → process mid once'));
    expect(body).toMatch(/if \(!DSP[^\n]*\{\s*\/\/[^\n]*\n[^\n]*\n\s*throw new Error\(/);
    expect(body).not.toMatch(/this\.outputBuffer = buf;/);
    expect(app).toContain("this._processingEngine = mlOk ? 'ml' : 'dsp-fallback';");
  });

  test('AUD-006: Landing watchdog has no total-time cap and resets on visibility return', () => {
    expect(landing).not.toMatch(/startedAt < 300000/);
    expect(landing).toContain('Date.now() - lastProcessProgress < PROCESS_STALL_MS');
    expect(landing).toMatch(/visibilitychange[\s\S]{0,120}lastProcessProgress = Date\.now\(\)/);
  });

  test('AUD-002: region parameter actions write through _setSliderUi, not app.params', () => {
    const body = canvas.slice(canvas.indexOf('__vipEngineerProcessSelection ='), canvas.indexOf('__vipSetComparisonMode ='));
    expect(body).not.toMatch(/appInstance\.params\.\w+\s*=/);
    expect(body).toContain('appInstance._setSliderUi?.(id, v)');
  });

  test('AUD-001: every Engineer export path renders the Live-Mix', () => {
    const exportBody = app.slice(app.indexOf('async _downloadProcessed()'), app.indexOf('downloadWav(buf, \'processed-\''));
    expect(exportBody).toContain('this._renderProcessedMix(');
    const drive = app.slice(app.indexOf('async _saveProcessedToGoogleDrive()'), app.indexOf('async _downloadProcessed()'));
    expect(drive).toContain('this._renderProcessedMix()');
    expect(read('public/app/lib/analysis-workspace.js')).toContain('app._renderProcessedMix?.()');
  });
});
