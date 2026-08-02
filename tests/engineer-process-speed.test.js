/**
 * Engineer Mode processing speed — structural guards for the fast path.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
const manifest = fs.readFileSync(path.join(__dirname, '../src/core/ModelManifest.js'), 'utf8');
const mlWorker = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8');
const offlineProcessor = fs.readFileSync(path.join(__dirname, '../public/app/offline-processor.js'), 'utf8');
const batchProcessor = fs.readFileSync(path.join(__dirname, '../public/app/batch-processor.js'), 'utf8');

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

  test('spectral stage uses lighter FFT on mobile / 2048 desktop non-forensic', () => {
    // Desktop non-forensic: 2048; mobile non-forensic: 1024 (freeze fix)
    expect(appJs).toMatch(/mobile \? 1024 : 2048/);
    expect(appJs).toContain('forwardSTFTAsync');
  });

  test('isolation always uses a single process pass (UI freeze guard)', () => {
    expect(appJs).toMatch(/let totalPasses = 1/);
    expect(appJs).toContain('Always single-pass isolation');
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

  test('bsrnn maxBatchFrames is at least 128', () => {
    expect(manifest).toMatch(/bsrnn_vocals:[\s\S]*?maxBatchFrames:\s*128/);
  });

  test('MLWorker effectiveBatchFrames uses larger WASM batches', () => {
    expect(mlWorker).toMatch(/Math\.min\(384,/);
  });

  test('ML transfers owned mid channel (no second memcpy)', () => {
    expect(appJs).toContain('transferOwned: true');
    expect(appJs).toMatch(/new Float32Array\(buf\.getChannelData\(0\)\)/);
  });

  test('auto-process races model warmup before isolation', () => {
    // handleFile schedules idle warmup; ML isolation path kicks another warmup without blocking.
    expect(appJs).toMatch(/_warmupMLModels\(\)/);
    expect(appJs).toMatch(/void this\._warmupMLModels\(\)/);
    expect(appJs).toMatch(/async runPipeline\(/);
  });

  test('MLWorker skips re-hash when cache key embeds sha256', () => {
    expect(mlWorker).toMatch(/if \(entry\.sha256\) return cached/);
  });

  test('MLWorker uses smaller WASM batches on constrained/Android devices', () => {
    expect(mlWorker).toContain('isConstrainedDevice');
    expect(mlWorker).toMatch(/if \(mobile\) return Math\.min\(160/);
  });

  test('ML channel plan is async with yields (mobile freeze fix)', () => {
    expect(appJs).toMatch(/async _mlChannelPlan\s*\(/);
    expect(appJs).toMatch(/async _expandMonoCleanToStereo\s*\(/);
    expect(appJs).toContain('_isMobileEngineer');
  });

  test('spectral stage uses lighter FFT on mobile', () => {
    expect(appJs).toMatch(/mobile \? 1024 : 2048/);
  });

  test('offline processor adapts FFT size by quality mode and keeps 75% overlap', () => {
    expect(offlineProcessor).toContain('function getFFTSize(mode)');
    expect(offlineProcessor).toContain('forensic: 4096');
    expect(offlineProcessor).toContain('HOP_SIZE = FFT_SIZE / 4');
  });

  test('offline processor emits progress while long OfflineAudioContext renders are running', () => {
    expect(offlineProcessor).toContain('async function renderWithProgress');
    expect(offlineProcessor).toContain('setInterval(() => {');
    expect(offlineProcessor).toContain('emit(end)');
  });

  test('batch processor profiles the top slow stages in debug mode', () => {
    expect(batchProcessor).toContain('function _createProfiler(job)');
    expect(batchProcessor).toContain("[BatchProcessor] Slowest stages");
    expect(batchProcessor).toContain("slice(0, 3)");
  });
});
