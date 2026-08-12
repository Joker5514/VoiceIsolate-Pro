/**
 * Single-STFT invariant: production fused spectral path counts
 * forward+inverse transforms and source-level guards.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ml = fs.readFileSync(path.join(__dirname, '../src/workers/MLWorker.js'), 'utf8');
const budget = fs.readFileSync(path.join(__dirname, '../src/core/stft-budget.js'), 'utf8');
const arch = fs.readFileSync(path.join(__dirname, '../tests/architectural-invariants.test.js'), 'utf8');

describe('Single STFT assertion (compatible spectral chains)', () => {
  test('MLWorker increments forward and inverse once per fused channel path', () => {
    expect(ml).toMatch(/_stftForwardCount \+= 1/);
    expect(ml).toMatch(/_stftInverseCount \+= 1/);
    // Counters reset per process request
    expect(ml).toMatch(/resetStftCounters\(\)/);
    expect(ml).toMatch(/stftCounts/);
  });

  test('fused path labeled for CI / diagnostics', () => {
    expect(ml).toMatch(/fused-spectral-single-stft/);
    expect(ml).toMatch(/serial-mixed/);
  });

  test('waveform-only branch is explicitly not the single-STFT claim', () => {
    expect(ml).toMatch(/not single-STFT invariant|waveform-only/);
  });

  test('stft-budget tracks multi-owner process jobs', () => {
    expect(budget).toMatch(/PROCESS_STFT_OWNER_BUDGET/);
    expect(budget).toMatch(/createStftBudget/);
  });

  test('architectural tests still enforce one forwardSTFT method in dsp-core', () => {
    expect(arch).toMatch(/forwardSTFT/);
    expect(arch).toMatch(/inverseSTFT/);
  });
});

describe('colaSafeHop unit (via AudioClickFix)', () => {
  let fix;
  beforeAll(async () => {
    fix = await import('../src/core/AudioClickFix.js');
  });

  test('long-file speed hop stays ≤ 50% overlap geometry', () => {
    // Desired hop absurdly large → clamp to fft/2
    expect(fix.colaSafeHop(4096, 1024, 65536)).toBe(2048);
    // Default quality hop stays fft/4
    expect(fix.colaSafeHop(4096, 1024, 1024)).toBe(1024);
  });
});
