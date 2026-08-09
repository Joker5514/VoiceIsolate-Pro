'use strict';

/**
 * Source-level guards for fused spectral single-STFT production path.
 * (Full ONNX E2E is covered by landing/live smokes.)
 */
const fs = require('fs');
const path = require('path');

const ml = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8');

describe('MLWorker fused spectral production path', () => {
  test('defines fused single-STFT chain runner', () => {
    expect(ml).toContain('runFusedSpectralMaskChain');
    expect(ml).toContain('canFuseSpectralChain');
    expect(ml).toContain('fused-spectral-single-stft');
  });

  test('posts stftCounts and pipelineMode on stems', () => {
    expect(ml).toContain('stftCounts');
    expect(ml).toContain('pipelineMode');
    expect(ml).toContain('resetStftCounters');
  });

  test('separates waveform-only branch labeling', () => {
    expect(ml).toContain('waveform-only');
    expect(ml).toContain('serial-mixed');
  });

  test('fuses masks by product in-domain', () => {
    expect(ml).toMatch(/fusedMask\[i\]\s*\*=\s*mask\[i\]/);
  });
});
