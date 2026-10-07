'use strict';
/**
 * Audit PERF-001: the DSP fallback ran DC, click repair, gate and de-ess
 * synchronously over the whole file on the main thread (~1.5 s per 5 min).
 * The chain (and the EQ/dynamics pass) now runs in /app/dsp-worker.js; these guards keep it there and
 * keep the in-place path only as the no-worker fallback.
 */
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
const fallback = app.slice(app.indexOf('  async _runFallbackPipeline(sourceBuf) {'));
const body = fallback.slice(0, fallback.indexOf('\n  }\n'));
const helper = app.slice(app.indexOf('  async _dspWorkerChannels('), app.indexOf('  async _runFallbackPipeline('));

test('fallback conditioning is delegated, not run inline per channel', () => {
  expect(body).toMatch(/await this\._dspWorkerChannels\('condition', channels, p, sr, DSP\)/);
  expect(body).toMatch(/await this\._dspWorkerChannels\('eqDynamics', channels, p, sr, DSP\)/);
  for (const stage of ['DSP.removeDCOffset(', 'DSP.removeClicks(', 'DSP.noiseGate(', 'DSP.deEss(', '_eqDynamicsStage(']) {
    expect(body).not.toContain(stage);
  }
});

test('worker path handshakes before transferring the only copy of the audio', () => {
  expect(helper).toContain("new Worker('/app/dsp-worker.js')");
  // Both calls awaited, init first: a dropped await would let the transfer race the handshake.
  expect(helper).toMatch(/await call\('init'[\s\S]*?await call\(op,/);
  expect(helper).toMatch(/worker\.terminate\(\)/);
  expect(helper).toMatch(/throwIfAborted/);
});

test('dsp-worker is precached for offline use', () => {
  const sw = fs.readFileSync(path.join(__dirname, '../public/app/sw.js'), 'utf8');
  expect(sw).toContain("'/app/dsp-worker.js'");
});

test('a worker error after the transfer fails Process with the stage named', () => {
  const after = helper.slice(helper.indexOf('call(op,'));
  expect(after).toMatch(/throw new Error\(`DSP fallback failed during \$\{op === 'condition' \? 'input conditioning' : 'EQ and dynamics'\}/);
  expect(after).not.toMatch(/return inThread\(\)/);
});
