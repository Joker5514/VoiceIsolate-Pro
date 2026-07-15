/**
 * Engineer Mode processing speed — structural guards for the fast path.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
const manifest = fs.readFileSync(path.join(__dirname, '../src/core/ModelManifest.js'), 'utf8');
const mlWorker = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8');

describe('Engineer processing speed path', () => {
  test('ML isolation uses mid-channel plan for stereo (single inference pass)', () => {
    expect(appJs).toContain('_mlChannelPlan');
    expect(appJs).toContain('_expandMonoCleanToStereo');
    expect(appJs).toMatch(/expandStereo\s*\?\s*'ML isolation \(mid\)/);
  });

  test('ML isolation always sources from origBuffer (not re-ML of procBuffer)', () => {
    expect(appJs).toMatch(
      /async _runMLIsolationPipeline[\s\S]*?const buf = this\.origBuffer \|\| this\.inputBuffer/
    );
  });

  test('DSP fallback processes stereo as mid (one STFT path)', () => {
    expect(appJs).toContain('processStereoAsMid');
    expect(appJs).toMatch(/processStereoAsMid = nCh >= 2/);
  });

  test('spectral stage uses FFT 2048 for non-forensic Engineer path', () => {
    expect(appJs).toMatch(/const FFT = forensic \? 4096 : 2048/);
    expect(appJs).toMatch(/const HOP = forensic \? 1024 : 512/);
  });

  test('forensic multi-pass is capped at 2', () => {
    expect(appJs).toMatch(/Math\.min\(2,\s*wm\.passes/);
  });

  test('extreme noise-floor scan only runs when extreme path is active', () => {
    expect(appJs).toMatch(
      /if \(runExtreme\) this\._extremeNoiseProfile = this\._estimateNoiseFloor\(mag\)/
    );
    // Must not re-estimate after the extreme loop on the fast path
    expect(appJs).not.toMatch(
      /else if \(onProgress\) \{\s*onProgress\(0\.85\);\s*\}\s*this\._extremeNoiseProfile = this\._estimateNoiseFloor/
    );
  });

  test('bsrnn maxBatchFrames is at least 64', () => {
    expect(manifest).toMatch(/bsrnn_vocals:[\s\S]*?maxBatchFrames:\s*64/);
  });

  test('MLWorker effectiveBatchFrames uses larger WASM batches', () => {
    expect(mlWorker).toMatch(/Math\.min\(192,\s*base \* 3\)/);
  });
});
