/**
 * Shared STFT math — COLA, framing, masks, Engineer geometry (audit F-01/F-03/F-07).
 */
'use strict';

let math;

beforeAll(async () => {
  math = await import('../src/core/stft-math.js');
});

describe('periodicHann', () => {
  test('length and endpoints (periodic form)', () => {
    const w = math.periodicHann(512);
    expect(w.length).toBe(512);
    expect(w[0]).toBeCloseTo(0, 6);
    expect(w[256]).toBeCloseTo(1, 5);
    // Periodic form: last sample is NOT forced to 0 (that is symmetric/N-1 behaviour)
    expect(w[511]).toBeGreaterThan(0);
    expect(w[511]).toBeLessThan(0.01);
  });

  test('matches DSPCore periodic formula for N=2048', () => {
    const w = math.periodicHann(2048);
    for (let i = 0; i < 2048; i += 17) {
      const expected = 0.5 * (1 - Math.cos((2 * Math.PI * i) / 2048));
      expect(w[i]).toBeCloseTo(expected, 6);
    }
  });

  test('rejects invalid N', () => {
    expect(() => math.periodicHann(1)).toThrow(/integer/);
    expect(() => math.periodicHann(3.5)).toThrow(/integer/);
  });
});

describe('frameCount', () => {
  test('matches DSPCore formula', () => {
    expect(math.frameCount(48000, 4096, 1024)).toBe(43);
    expect(math.frameCount(48000, 2048, 512)).toBe(90);
    expect(math.frameCount(2047, 2048, 512)).toBe(0);
    expect(math.frameCount(2048, 2048, 512)).toBe(1);
  });

  test('rejects bad hop', () => {
    expect(() => math.frameCount(1000, 512, 0)).toThrow();
    expect(() => math.frameCount(1000, 512, 600)).toThrow();
  });
});

describe('COLA envelope', () => {
  test('75% overlap periodic Hann is flat (ripple ~ 0)', () => {
    const r75a = math.checkColaFlat(4096, 1024, 1e-4);
    const r75b = math.checkColaFlat(2048, 512, 1e-4);
    expect(r75a.ok).toBe(true);
    expect(r75b.ok).toBe(true);
    expect(r75a.min).toBeCloseTo(1.5, 4);
    expect(r75a.max).toBeCloseTo(1.5, 4);
  });

  test('50% overlap has large w² ripple (documents Engineer mobile tradeoff)', () => {
    const r50 = math.checkColaFlat(2048, 1024, 1e-3);
    expect(r50.ok).toBe(false);
    expect(r50.ripple).toBeGreaterThan(0.5);
  });

  test('STFT_PRESETS engineer/forensic/cleanup use 75% hop', () => {
    for (const key of ['engineer', 'forensic', 'cleanup', 'usm']) {
      const p = math.STFT_PRESETS[key];
      expect(p.hopSize).toBe(p.fftSize / 4);
      expect(math.overlapRatio(p.fftSize, p.hopSize)).toBeCloseTo(0.75, 6);
      expect(math.checkColaFlat(p.fftSize, p.hopSize).ok).toBe(true);
    }
  });
});

describe('engineerStftGeometry', () => {
  test('desktop default is 2048/512 (75%)', () => {
    const g = math.engineerStftGeometry({ forensic: false, mobile: false });
    expect(g.fftSize).toBe(2048);
    expect(g.hopSize).toBe(512);
    expect(g.preset).toBe('engineer');
  });

  test('forensic desktop is 4096/1024', () => {
    const g = math.engineerStftGeometry({ forensic: true, mobile: false });
    expect(g.fftSize).toBe(4096);
    expect(g.hopSize).toBe(1024);
  });

  test('mobile non-forensic keeps 50% speed hop', () => {
    const g = math.engineerStftGeometry({ forensic: false, mobile: true });
    expect(g.fftSize).toBe(1024);
    expect(g.hopSize).toBe(512);
  });
});

describe('applySoftMask', () => {
  test('all-ones mask leaves spectrum unchanged', () => {
    const re = new Float32Array([1, 2, 3, 4]);
    const im = new Float32Array([0.5, -0.5, 0.25, 0]);
    const mask = new Float32Array([1, 1, 1, 1]);
    math.applySoftMask(re, im, mask, 4);
    expect(Array.from(re)).toEqual([1, 2, 3, 4]);
    expect(Array.from(im)).toEqual([0.5, -0.5, 0.25, 0]);
  });

  test('zeros mask nulls bins; clamps out-of-range', () => {
    const re = new Float32Array([1, 1, 1]);
    const im = new Float32Array([1, 1, 1]);
    math.applySoftMask(re, im, [0, 2, -1], 3);
    expect(re[0]).toBe(0);
    expect(im[0]).toBe(0);
    expect(re[1]).toBe(1);
    expect(re[2]).toBe(0);
  });
});

describe('padToMinFrame', () => {
  test('pads short audio to one FFT window', () => {
    const x = new Float32Array([0.1, 0.2, 0.3]);
    const y = math.padToMinFrame(x, 8);
    expect(y.length).toBe(8);
    expect(y[0]).toBeCloseTo(0.1);
    expect(y[7]).toBe(0);
  });
});
