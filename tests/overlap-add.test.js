/**
 * VoiceIsolate Pro — Overlap-Add & Ring-Buffer Reconstruction Tests
 * Master Blueprint v2.1 §III / Appendix A
 */
'use strict';

import { createRequire } from 'module';
import {
  QUANTUM,
  HOP_SIZE,
  FFT_SIZE_LIVE,
  FFT_SIZE_CREATOR,
  QUANTA_PER_HOP,
  validateRingBufferConstants,
} from '../src/core/ring-buffer-constants.js';

import {
  QuantumHopBridge,
  OverlapAddReconstructor,
  reconstructPassThrough,
} from '../src/core/OverlapAddAccumulator.js';

const require = createRequire(import.meta.url);
const {
  QUANTUM: CJS_QUANTUM,
  HOP_SIZE: CJS_HOP,
  QUANTA_PER_HOP: CJS_QPH,
  QuantumHopBridge: CjsBridge,
} = require('../public/app/ring-buffer.js');

describe('ring-buffer-constants (blueprint v2.1)', () => {
  test('codified constants match specification', () => {
    expect(QUANTUM).toBe(128);
    expect(FFT_SIZE_LIVE).toBe(1024);
    expect(FFT_SIZE_CREATOR).toBe(4096);
    expect(HOP_SIZE).toBe(512);
    expect(QUANTA_PER_HOP).toBe(4);
  });

  test('HOP_SIZE is integer multiple of QUANTUM', () => {
    expect(HOP_SIZE % QUANTUM).toBe(0);
    expect(validateRingBufferConstants().quantaPerHop).toBe(4);
  });

  test('rejects invalid hop/quantum ratio', () => {
    expect(() => validateRingBufferConstants({ hopSize: 500 })).toThrow(/integer multiple/);
  });

  test('legacy ring-buffer.js exports matching constants', () => {
    expect(CJS_QUANTUM).toBe(QUANTUM);
    expect(CJS_HOP).toBe(HOP_SIZE);
    expect(CJS_QPH).toBe(QUANTA_PER_HOP);
  });
});

describe('QuantumHopBridge', () => {
  test('accumulates exactly QUANTA_PER_HOP quanta before hop advance', () => {
    const bridge = new QuantumHopBridge({ fftSize: FFT_SIZE_LIVE, hopSize: HOP_SIZE });
    const q = new Float32Array(QUANTUM).fill(0.25);

    expect(bridge.pushQuantum(q)).toBe(false);
    expect(bridge.pushQuantum(q)).toBe(false);
    expect(bridge.pushQuantum(q)).toBe(false);
    expect(bridge.pushQuantum(q)).toBe(true);
    expect(bridge.hopCount).toBe(1);
  });

  test('analysis window contains most recent fftSize samples in order', () => {
    const bridge = new QuantumHopBridge({ fftSize: 256, hopSize: 128, quantum: 128 });
    const a = new Float32Array(128).fill(1);
    const b = new Float32Array(128).fill(2);
    bridge.pushQuantum(a);
    bridge.pushQuantum(b);
    const win = bridge.getAnalysisWindow();
    expect(win.subarray(0, 128).every((v) => v === 1)).toBe(true);
    expect(win.subarray(128, 256).every((v) => v === 2)).toBe(true);
  });

  test('CJS QuantumHopBridge matches ESM behaviour', () => {
    const bridge = new CjsBridge({ fftSize: FFT_SIZE_LIVE, hopSize: HOP_SIZE });
    const q = new Float32Array(QUANTUM).fill(1);
    for (let i = 0; i < 3; i++) bridge.pushQuantum(q);
    expect(bridge.pushQuantum(q)).toBe(true);
    expect(bridge.hopCount).toBe(1);
  });
});

describe('OverlapAddReconstructor — pass-through COLA', () => {
  function makeSine(length, freq, sampleRate = 48000) {
    const out = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }
    return out;
  }

  test('reconstructs sine wave (live FFT) with low max error', () => {
    const input = makeSine(4096, 440);
    const recon = reconstructPassThrough(input, { fftSize: FFT_SIZE_LIVE, hopSize: HOP_SIZE });
    const trim = FFT_SIZE_LIVE;
    let maxAbsErr = 0;
    for (let i = trim; i < input.length - trim; i++) {
      maxAbsErr = Math.max(maxAbsErr, Math.abs(input[i] - recon[i]));
    }
    expect(maxAbsErr).toBeLessThan(0.05);
  });

  test('reconstructs sine wave (creator FFT) with low max error', () => {
    const input = makeSine(8192, 880);
    const recon = reconstructPassThrough(input, {
      fftSize: FFT_SIZE_CREATOR,
      hopSize: HOP_SIZE,
    });
    const trim = FFT_SIZE_CREATOR;
    let maxAbsErr = 0;
    for (let i = trim; i < input.length - trim; i++) {
      maxAbsErr = Math.max(maxAbsErr, Math.abs(input[i] - recon[i]));
    }
    expect(maxAbsErr).toBeLessThan(0.05);
  });

  test('reconstruction error bounded in steady-state region', () => {
    const input = makeSine(4096, 440);
    const recon = reconstructPassThrough(input);
    const trim = FFT_SIZE_LIVE;
    let maxAbsErr = 0;
    for (let i = trim; i < input.length - trim; i++) {
      maxAbsErr = Math.max(maxAbsErr, Math.abs(input[i] - recon[i]));
    }
    expect(maxAbsErr).toBeLessThan(0.05);
  });
});