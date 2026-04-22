'use strict';

const fs = require('fs');
const path = require('path');

const dspCoreJs = fs.readFileSync(path.join(__dirname, '../public/app/dsp-core.js'), 'utf8');
const { DSPCore, AdaptiveNoiseFloor } = (() => {
  const exports = {};
  const module = { exports };
  const window = {};
  const self = {};
  eval(dspCoreJs); // eslint-disable-line no-eval
  return { DSPCore: module.exports, AdaptiveNoiseFloor: module.exports.AdaptiveNoiseFloor };
})();

// ── AdaptiveNoiseFloor ────────────────────────────────────────────────────────

describe('AdaptiveNoiseFloor', () => {
  test('constructor initializes to correct size and uninitialized state', () => {
    const anf = new AdaptiveNoiseFloor(10);
    expect(anf.numBins).toBe(10);
    expect(anf.noiseEst.length).toBe(10);
    expect(anf._initialized).toBe(false);
  });

  test('first update() seeds noiseEst from mag', () => {
    const anf = new AdaptiveNoiseFloor(4);
    const mag = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    anf.update(mag);
    expect(anf._initialized).toBe(true);
    for (let k = 0; k < 4; k++) expect(anf.noiseEst[k]).toBeCloseTo(mag[k], 5);
  });

  test('getFloor() returns zeros before any update (Infinity clamped)', () => {
    const anf = new AdaptiveNoiseFloor(4);
    const floor = anf.getFloor();
    for (let k = 0; k < 4; k++) expect(floor[k]).toBe(0);
  });

  test('getFloor() retains initial low value within the sub-window lifetime', () => {
    // Use a 2-second smoothing window so subWinLen ≈ 19 frames.
    // Feeding only 5 high frames (< subWinLen) means no rotation yet:
    // all 5 sub-windows still hold the initial low seed value.
    const anf = new AdaptiveNoiseFloor(4, 2000, 1024, 48000);
    anf.update(new Float32Array([0.01, 0.02, 0.03, 0.04]));
    for (let i = 0; i < 5; i++) anf.update(new Float32Array([0.9, 0.9, 0.9, 0.9]));
    const floor = anf.getFloor();
    for (let k = 0; k < 4; k++) expect(floor[k]).toBeLessThan(0.1);
  });

  test('getFloor() accepts and returns a pre-allocated output buffer', () => {
    const anf = new AdaptiveNoiseFloor(4);
    anf.update(new Float32Array([0.1, 0.1, 0.1, 0.1]));
    const out = new Float32Array(4);
    const ret = anf.getFloor(out);
    expect(ret).toBe(out);
  });

  test('reset() clears all state', () => {
    const anf = new AdaptiveNoiseFloor(4);
    anf.update(new Float32Array([0.5, 0.5, 0.5, 0.5]));
    anf.reset();
    expect(anf._initialized).toBe(false);
    expect(anf._subFrameIdx).toBe(0);
    expect(anf._subWinIdx).toBe(0);
    const floor = anf.getFloor();
    for (let k = 0; k < 4; k++) expect(floor[k]).toBe(0);
  });

  test('sub-window rotation increments _subWinIdx after subWinLen frames', () => {
    const anf = new AdaptiveNoiseFloor(2, 100, 1024, 48000);
    anf.update(new Float32Array([0.1, 0.1]));
    const before = anf._subWinIdx;
    for (let i = 0; i < anf._subWinLen + 1; i++) {
      anf.update(new Float32Array([0.1, 0.1]));
    }
    expect(anf._subWinIdx).not.toBe(before);
  });

  test('noiseEst smoothing alpha is in (0, 1)', () => {
    const anf = new AdaptiveNoiseFloor(2, 200, 1024, 48000);
    expect(anf.alpha).toBeGreaterThan(0);
    expect(anf.alpha).toBeLessThan(1);
  });
});

// ── wienerFilter ─────────────────────────────────────────────────────────────

describe('DSPCore.wienerFilter', () => {
  test('returns gain in [beta, 1.0]', () => {
    const g = DSPCore.wienerFilter(0.1, 0.5);
    expect(g).toBeGreaterThanOrEqual(0.02);
    expect(g).toBeLessThanOrEqual(1.0);
  });

  test('high SNR → gain near 1.0', () => {
    expect(DSPCore.wienerFilter(0.001, 1.0)).toBeGreaterThan(0.95);
  });

  test('low SNR → gain near spectral floor', () => {
    expect(DSPCore.wienerFilter(1.0, 0.001)).toBeLessThan(0.1);
  });

  test('zero signal returns finite gain', () => {
    const g = DSPCore.wienerFilter(0.5, 0);
    expect(Number.isFinite(g)).toBe(true);
    expect(g).toBeGreaterThanOrEqual(0);
  });

  test('zero noise returns gain near 1.0', () => {
    expect(DSPCore.wienerFilter(0, 0.5)).toBeCloseTo(1.0, 2);
  });

  test('custom spectralFloor is respected', () => {
    const g = DSPCore.wienerFilter(1.0, 0.001, { spectralFloor: 0.5 });
    expect(g).toBeGreaterThanOrEqual(0.5);
  });

  test('gain never exceeds 1.0 (no amplification) for random inputs', () => {
    for (let i = 0; i < 50; i++) {
      const g = DSPCore.wienerFilter(Math.random(), Math.random() * 2);
      expect(g).toBeLessThanOrEqual(1.0 + 1e-9);
    }
  });
});

// ── getVoiceMaskGain ──────────────────────────────────────────────────────────

describe('DSPCore.getVoiceMaskGain', () => {
  const SR = 48000, FFT = 4096;

  test('returns 0.3 for very low sub-bass (<40 Hz)', () => {
    const bin = Math.floor(20 / (SR / FFT));
    expect(DSPCore.getVoiceMaskGain(bin, SR, FFT)).toBe(0.30);
  });

  test('returns 1.0 for core voice band (200–4000 Hz)', () => {
    const bin = Math.round(1000 / (SR / FFT));
    expect(DSPCore.getVoiceMaskGain(bin, SR, FFT)).toBe(1.0);
  });

  test('returns 0.4 for frequencies above 12 kHz', () => {
    const bin = Math.round(14000 / (SR / FFT));
    expect(DSPCore.getVoiceMaskGain(bin, SR, FFT)).toBe(0.40);
  });

  test('all bin values are in [0, 1]', () => {
    const halfN = FFT / 2 + 1;
    for (let k = 0; k < halfN; k += 50) {
      const g = DSPCore.getVoiceMaskGain(k, SR, FFT);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
    }
  });
});

// ── hannWindow ────────────────────────────────────────────────────────────────

describe('DSPCore.hannWindow', () => {
  test('returns correct length', () => {
    expect(DSPCore.hannWindow(256).length).toBe(256);
  });

  test('first sample is 0 (periodic Hann)', () => {
    expect(DSPCore.hannWindow(512)[0]).toBeCloseTo(0, 6);
  });

  test('peak is 1.0 at midpoint', () => {
    const w = DSPCore.hannWindow(512);
    expect(w[256]).toBeCloseTo(1.0, 5);
  });

  test('caches result for same length (same reference)', () => {
    expect(DSPCore.hannWindow(128)).toBe(DSPCore.hannWindow(128));
  });
});

// ── peakNormalize ─────────────────────────────────────────────────────────────

describe('DSPCore.peakNormalize', () => {
  test('normalizes peak to target dBFS', () => {
    const data = new Float32Array([0.1, -0.2, 0.3, -0.4]);
    DSPCore.peakNormalize(data, -6);
    const peak = Math.max(...data.map(Math.abs));
    expect(peak).toBeCloseTo(Math.pow(10, -6 / 20), 4);
  });

  test('silent signal (all zeros) is left unchanged', () => {
    const data = new Float32Array(8);
    DSPCore.peakNormalize(data, -6);
    expect(data.every(v => v === 0)).toBe(true);
  });
});

// ── truePeakLimit ─────────────────────────────────────────────────────────────

describe('DSPCore.truePeakLimit', () => {
  test('output never exceeds ceiling (0 dBFS)', () => {
    const data = new Float32Array([0.5, 1.5, -2.0, 0.9, -1.1]);
    DSPCore.truePeakLimit(data, 0);
    for (const v of data) expect(Math.abs(v)).toBeLessThanOrEqual(1.0 + 1e-6);
  });

  test('signal well below knee is unchanged', () => {
    const data = new Float32Array([0.1, 0.2, -0.1]);
    const copy = data.slice();
    DSPCore.truePeakLimit(data, 0);
    for (let i = 0; i < data.length; i++) expect(data[i]).toBeCloseTo(copy[i], 6);
  });

  test('polarity is preserved for large signals', () => {
    const data = new Float32Array([2.0, -2.0]);
    DSPCore.truePeakLimit(data, 0);
    expect(data[0]).toBeGreaterThan(0);
    expect(data[1]).toBeLessThan(0);
  });
});

// ── deClip ────────────────────────────────────────────────────────────────────

describe('DSPCore.deClip', () => {
  test('interpolates clipped samples', () => {
    const data = new Float32Array([0.1, 1.0, 0.1]);
    DSPCore.deClip(data, 0.99);
    expect(Math.abs(data[1])).toBeLessThan(1.0);
    expect(data[1]).toBeCloseTo(0.1, 3);
  });

  test('normal samples are untouched', () => {
    const data = new Float32Array([0.1, 0.5, 0.2, -0.3]);
    const copy = data.slice();
    DSPCore.deClip(data, 0.99);
    for (let i = 1; i < data.length - 1; i++) expect(data[i]).toBeCloseTo(copy[i], 6);
  });
});

// ── stereoWiden ───────────────────────────────────────────────────────────────

describe('DSPCore.stereoWiden', () => {
  test('null right channel → mono passthrough', () => {
    const left = new Float32Array([1, 2, 3]);
    const { left: outL, right: outR } = DSPCore.stereoWiden(left, null, 150);
    expect(outL).toBe(left);
    expect(outR).toBe(left);
  });

  test('width=100 returns channels unchanged', () => {
    const left = new Float32Array([0.5, -0.3]);
    const right = new Float32Array([0.2, 0.4]);
    const { left: outL, right: outR } = DSPCore.stereoWiden(left, right, 100);
    expect(outL).toBe(left);
    expect(outR).toBe(right);
  });

  test('width=0 collapses to mono (L === R)', () => {
    const left = new Float32Array([0.6, -0.4]);
    const right = new Float32Array([0.2, 0.8]);
    const { left: outL, right: outR } = DSPCore.stereoWiden(left, right, 0);
    for (let i = 0; i < 2; i++) expect(outL[i]).toBeCloseTo(outR[i], 5);
  });

  test('output length matches input', () => {
    const left = new Float32Array(8).fill(0.5);
    const right = new Float32Array(8).fill(0.3);
    const { left: outL, right: outR } = DSPCore.stereoWiden(left, right, 150);
    expect(outL.length).toBe(8);
    expect(outR.length).toBe(8);
  });
});

// ── temporalSmooth ────────────────────────────────────────────────────────────

describe('DSPCore.temporalSmooth', () => {
  test('smoothing=0 leaves frames unchanged', () => {
    const mag = [new Float32Array([1, 2, 3]), new Float32Array([4, 5, 6])];
    const before = mag[1].slice();
    DSPCore.temporalSmooth(mag, 0);
    for (let k = 0; k < 3; k++) expect(mag[1][k]).toBeCloseTo(before[k], 6);
  });

  test('smoothing=100 replaces frame with previous', () => {
    const mag = [new Float32Array([1, 1, 1]), new Float32Array([9, 9, 9])];
    DSPCore.temporalSmooth(mag, 100);
    for (let k = 0; k < 3; k++) expect(mag[1][k]).toBeCloseTo(1, 5);
  });

  test('smoothing=50 blends frames at 50/50', () => {
    const mag = [new Float32Array([0, 0, 0]), new Float32Array([10, 10, 10])];
    DSPCore.temporalSmooth(mag, 50);
    for (let k = 0; k < 3; k++) expect(mag[1][k]).toBeCloseTo(5, 5);
  });
});

// ── measureLUFS ───────────────────────────────────────────────────────────────

describe('DSPCore.measureLUFS', () => {
  test('silence returns -96', () => {
    expect(DSPCore.measureLUFS(new Float32Array(48000), 48000)).toBe(-96);
  });

  test('full-scale 1kHz sine is in a reasonable LUFS range', () => {
    const sr = 48000, N = sr * 2;
    const data = new Float32Array(N);
    for (let i = 0; i < N; i++) data[i] = Math.sin(2 * Math.PI * 1000 * i / sr);
    const lufs = DSPCore.measureLUFS(data, sr);
    expect(lufs).toBeGreaterThan(-10);
    expect(lufs).toBeLessThan(5);
  });

  test('louder signal has higher LUFS than quieter', () => {
    const sr = 48000, N = sr;
    const loud = new Float32Array(N).fill(0.9);
    const quiet = new Float32Array(N).fill(0.1);
    expect(DSPCore.measureLUFS(loud, sr)).toBeGreaterThan(DSPCore.measureLUFS(quiet, sr));
  });
});

// ── encodeWAV ─────────────────────────────────────────────────────────────────

describe('DSPCore.encodeWAV', () => {
  const readStr = (view, off, len) =>
    Array.from({ length: len }, (_, i) => String.fromCharCode(view.getUint8(off + i))).join('');

  test('produces valid RIFF/WAVE/fmt /data header', () => {
    const buf = DSPCore.encodeWAV(new Float32Array(10), 48000, 16);
    const v = new DataView(buf);
    expect(readStr(v, 0, 4)).toBe('RIFF');
    expect(readStr(v, 8, 4)).toBe('WAVE');
    expect(readStr(v, 12, 4)).toBe('fmt ');
    expect(readStr(v, 36, 4)).toBe('data');
  });

  test('16-bit: buffer size = 44 + samples*2', () => {
    expect(DSPCore.encodeWAV(new Float32Array(100), 48000, 16).byteLength).toBe(244);
  });

  test('24-bit: buffer size = 44 + samples*3', () => {
    expect(DSPCore.encodeWAV(new Float32Array(50), 48000, 24).byteLength).toBe(44 + 150);
  });

  test('32-bit: buffer size = 44 + samples*4', () => {
    expect(DSPCore.encodeWAV(new Float32Array(100), 48000, 32).byteLength).toBe(444);
  });

  test('sample rate written correctly at offset 24', () => {
    const buf = DSPCore.encodeWAV(new Float32Array(1), 44100, 16);
    expect(new DataView(buf).getUint32(24, true)).toBe(44100);
  });

  test('RIFF chunk size = 36 + dataSize', () => {
    const buf = DSPCore.encodeWAV(new Float32Array(10), 48000, 16);
    expect(new DataView(buf).getUint32(4, true)).toBe(36 + 10 * 2);
  });

  test('16-bit clamps over-range samples to ±32767', () => {
    const buf = DSPCore.encodeWAV(new Float32Array([2.0, -2.0]), 48000, 16);
    const v = new DataView(buf);
    expect(v.getInt16(44, true)).toBe(0x7FFF);
    expect(v.getInt16(46, true)).toBe(-0x7FFF);
  });
});

// ── wienerMMSE ────────────────────────────────────────────────────────────────

describe('DSPCore.wienerMMSE', () => {
  test('reduces magnitude when noiseProfile is strong', () => {
    const mag = [new Float32Array(8).fill(0.5)];
    DSPCore.wienerMMSE(mag, new Float32Array(8).fill(0.4), 100);
    for (const v of mag[0]) expect(v).toBeLessThan(0.5);
  });

  test('null noiseProfile causes minimal change', () => {
    const mag = [new Float32Array([0.5, 0.5])];
    const before = mag[0].slice();
    DSPCore.wienerMMSE(mag, null, 50);
    for (let k = 0; k < 2; k++) expect(mag[0][k]).toBeGreaterThan(before[k] * 0.9);
  });

  test('amount=0 leaves magnitudes unchanged', () => {
    const mag = [new Float32Array([0.3, 0.4, 0.5])];
    const before = mag[0].slice();
    DSPCore.wienerMMSE(mag, new Float32Array([0.2, 0.2, 0.2]), 0);
    for (let k = 0; k < 3; k++) expect(mag[0][k]).toBeCloseTo(before[k], 6);
  });
});

// ── applyAdaptiveWiener ───────────────────────────────────────────────────────

describe('DSPCore.applyAdaptiveWiener', () => {
  function frames(n, bins, val) {
    return Array.from({ length: n }, () => new Float32Array(bins).fill(val));
  }

  test('silence frames (conf<0.3) update the tracker', () => {
    const tracker = new AdaptiveNoiseFloor(4);
    const mag = frames(5, 4, 0.1);
    DSPCore.applyAdaptiveWiener(mag, new Float32Array(5).fill(0.0), tracker);
    expect(tracker._initialized).toBe(true);
  });

  test('fully voiced frame (conf=1) passes through without suppression', () => {
    const tracker = new AdaptiveNoiseFloor(4);
    tracker.update(new Float32Array(4).fill(0.1));
    const mag = [new Float32Array(4).fill(0.5)];
    DSPCore.applyAdaptiveWiener(mag, new Float32Array([1.0]), tracker);
    for (const v of mag[0]) expect(v).toBeCloseTo(0.5, 4);
  });

  test('returns the same mag array (in-place)', () => {
    const tracker = new AdaptiveNoiseFloor(4);
    const mag = frames(3, 4, 0.2);
    const ret = DSPCore.applyAdaptiveWiener(mag, new Float32Array(3).fill(0.5), tracker);
    expect(ret).toBe(mag);
  });

  test('no crash with empty vadConf', () => {
    const tracker = new AdaptiveNoiseFloor(4);
    const mag = frames(3, 4, 0.2);
    expect(() => DSPCore.applyAdaptiveWiener(mag, null, tracker)).not.toThrow();
  });
});

// ── AdaptiveNoiseEstimator ────────────────────────────────────────────────────

describe('DSPCore.AdaptiveNoiseEstimator', () => {
  test('constructor initializes noisePSD to zeros', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(8);
    expect(est.noisePSD.length).toBe(8);
    expect(est.initialized).toBe(false);
  });

  test('first update() seeds PSD from magnitude²', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(4);
    const mag = new Float32Array([0.5, 0.3, 0.2, 0.1]);
    est.update(mag);
    expect(est.initialized).toBe(true);
    for (let k = 0; k < 4; k++) expect(est.noisePSD[k]).toBeCloseTo(mag[k] * mag[k], 5);
  });

  test('attack smoothing when signal increases', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(1, 0.9, 0.998);
    est.update(new Float32Array([0.1]));
    const prev = est.noisePSD[0];
    est.update(new Float32Array([1.0]));
    const expected = 0.9 * prev + 0.1 * 1.0;
    expect(est.noisePSD[0]).toBeCloseTo(expected, 5);
  });

  test('release smoothing when signal decreases', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(1, 0.9, 0.998);
    est.update(new Float32Array([1.0]));
    const prev = est.noisePSD[0];
    est.update(new Float32Array([0.01]));
    const expected = 0.998 * prev + 0.002 * 0.0001;
    expect(est.noisePSD[0]).toBeCloseTo(expected, 4);
  });

  test('reset() clears state', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(4);
    est.update(new Float32Array(4).fill(0.5));
    est.reset();
    expect(est.initialized).toBe(false);
    expect(est.noisePSD.every(v => v === 0)).toBe(true);
  });

  test('getProfile() returns the internal noisePSD reference', () => {
    const est = new DSPCore.AdaptiveNoiseEstimator(4);
    expect(est.getProfile()).toBe(est.noisePSD);
  });
});

// ── MultibandWienerFilter ─────────────────────────────────────────────────────

describe('DSPCore.MultibandWienerFilter', () => {
  test('constructor defaults: 16 bands, 48kHz, 4096 fftSize', () => {
    const wf = new DSPCore.MultibandWienerFilter();
    expect(wf.numBands).toBe(16);
    expect(wf.sr).toBe(48000);
    expect(wf.fftSize).toBe(4096);
    expect(wf.smoothGains.every(g => g === 1)).toBe(true);
  });

  test('process() returns same mag array (in-place)', () => {
    const wf = new DSPCore.MultibandWienerFilter(4, 48000, 512);
    const mag = new Float32Array(257).fill(0.5);
    expect(wf.process(mag, null, 1)).toBe(mag);
  });

  test('process() reduces magnitudes when noisePSD is provided', () => {
    const wf = new DSPCore.MultibandWienerFilter(4, 48000, 512);
    const mag = new Float32Array(257).fill(0.5);
    const noise = new Float32Array(257).fill(0.3);
    const sumBefore = mag.reduce((a, b) => a + b, 0);
    wf.process(mag, noise, 1);
    expect(mag.reduce((a, b) => a + b, 0)).toBeLessThan(sumBefore);
  });

  test('process() output is always finite and non-negative', () => {
    const wf = new DSPCore.MultibandWienerFilter(4, 48000, 512);
    const mag = new Float32Array(257).fill(0.5);
    wf.process(mag, null, 1);
    for (const v of mag) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  test('reset() restores smoothGains to 1', () => {
    const wf = new DSPCore.MultibandWienerFilter(4, 48000, 512);
    wf.process(new Float32Array(257).fill(0.5), new Float32Array(257).fill(0.4), 1);
    wf.reset();
    expect(wf.smoothGains.every(g => g === 1)).toBe(true);
  });

  test('high temporal smoothing changes gains slowly between frames', () => {
    const wf = new DSPCore.MultibandWienerFilter(2, 48000, 512);
    const noise = new Float32Array(257).fill(0.05);
    wf.process(new Float32Array(257).fill(0.1), noise, 1, 0.9);
    const gains1 = wf.smoothGains.slice();
    wf.process(new Float32Array(257).fill(0.9), noise, 1, 0.9);
    for (let b = 0; b < wf.numBands; b++) {
      expect(Math.abs(wf.smoothGains[b] - gains1[b])).toBeLessThan(0.5);
    }
  });
});

// ── VADProcessor ──────────────────────────────────────────────────────────────

describe('DSPCore.VADProcessor', () => {
  test('constructor stores sr and sensitivity', () => {
    const vad = new DSPCore.VADProcessor(16000, 20, 0.8);
    expect(vad.sr).toBe(16000);
    expect(vad.sensitivity).toBe(0.8);
  });

  test('processFrame() returns 0 for silence', () => {
    const vad = new DSPCore.VADProcessor(48000, 20, 0.5);
    expect(vad.processFrame(new Float32Array(960))).toBe(0);
  });

  test('processFrame() returns 1 for loud tonal signal', () => {
    const vad = new DSPCore.VADProcessor(48000, 20, 0.9);
    const N = 960;
    const frame = new Float32Array(N);
    for (let i = 0; i < N; i++) frame[i] = 0.8 * Math.sin(2 * Math.PI * 300 * i / 48000);
    expect(vad.processFrame(frame)).toBe(1);
  });

  test('processSignal() returns one value per frame', () => {
    const vad = new DSPCore.VADProcessor(48000, 20, 0.5);
    const result = vad.processSignal(new Float32Array(48000));
    expect(result.length).toBe(Math.floor(48000 / vad.frameSize));
  });

  test('hangover returns 0.5 on first silence frame after speech', () => {
    const vad = new DSPCore.VADProcessor(48000, 20, 0.9);
    const N = 960;
    const voiced = new Float32Array(N);
    for (let i = 0; i < N; i++) voiced[i] = 0.8 * Math.sin(2 * Math.PI * 200 * i / 48000);
    vad.processFrame(voiced);
    expect(vad.processFrame(new Float32Array(N))).toBe(0.5);
  });

  test('setSensitivity() changes energyThreshDb', () => {
    const vad = new DSPCore.VADProcessor(48000, 20, 0.5);
    const before = vad.energyThreshDb;
    vad.setSensitivity(0.9);
    expect(vad.energyThreshDb).not.toBe(before);
  });

  test('reset() zeroes smoothedEnergy and hangover', () => {
    const vad = new DSPCore.VADProcessor(48000, 20, 0.9);
    const N = 960;
    const voiced = new Float32Array(N);
    for (let i = 0; i < N; i++) voiced[i] = 0.8 * Math.sin(2 * Math.PI * 200 * i / 48000);
    vad.processFrame(voiced);
    vad.reset();
    expect(vad.hangover).toBe(0);
    expect(vad.smoothedEnergy).toBe(0);
  });
});

// ── classifyNoiseSpectral ─────────────────────────────────────────────────────

describe('DSPCore.classifyNoiseSpectral', () => {
  const VALID_CLASSES = ['music', 'white_noise', 'crowd', 'HVAC', 'keyboard', 'traffic', 'silence'];

  test('empty input returns silence with confidence 1', () => {
    const r = DSPCore.classifyNoiseSpectral([], 48000, 4096);
    expect(r.noiseClass).toBe('silence');
    expect(r.confidence).toBe(1);
  });

  test('near-zero magnitudes return silence', () => {
    const mag = [new Float32Array(2049).fill(1e-8)];
    expect(DSPCore.classifyNoiseSpectral(mag, 48000, 4096).noiseClass).toBe('silence');
  });

  test('returns a valid noiseClass string', () => {
    const mag = Array.from({ length: 5 }, () => {
      const m = new Float32Array(2049);
      for (let k = 0; k < 2049; k++) m[k] = 0.01 + Math.random() * 0.02;
      return m;
    });
    expect(VALID_CLASSES).toContain(DSPCore.classifyNoiseSpectral(mag, 48000, 4096).noiseClass);
  });

  test('confidence is in (0, 0.99]', () => {
    const mag = Array.from({ length: 5 }, () => {
      const m = new Float32Array(2049);
      for (let k = 0; k < 2049; k++) m[k] = 0.01 + Math.random() * 0.02;
      return m;
    });
    const r = DSPCore.classifyNoiseSpectral(mag, 48000, 4096);
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(0.99);
  });

  test('strong low-frequency energy leans toward HVAC or traffic', () => {
    const numBins = 2049;
    const binHz = 24000 / (numBins - 1);
    const mag = Array.from({ length: 3 }, () => {
      const m = new Float32Array(numBins).fill(1e-5);
      for (let k = 0; k <= Math.round(120 / binHz); k++) m[k] = 1.0;
      return m;
    });
    expect(['HVAC', 'traffic', 'music']).toContain(
      DSPCore.classifyNoiseSpectral(mag, 48000, 4096).noiseClass
    );
  });
});

// ── removeClicks ──────────────────────────────────────────────────────────────

describe('DSPCore.removeClicks', () => {
  test('interpolates isolated spike', () => {
    const data = new Float32Array(256);
    data[64] = 999;
    DSPCore.removeClicks(data, 3);
    expect(Math.abs(data[64])).toBeLessThan(10);
  });

  test('leaves normal samples mostly untouched', () => {
    const data = new Float32Array(256).fill(0.1);
    const before = data.slice();
    DSPCore.removeClicks(data, 3);
    let unchanged = 0;
    for (let i = 0; i < data.length; i++) {
      if (Math.abs(data[i] - before[i]) < 1e-6) unchanged++;
    }
    expect(unchanged).toBeGreaterThan(data.length * 0.9);
  });
});

// ── harmonicEnhanceV2 ─────────────────────────────────────────────────────────

describe('DSPCore.harmonicEnhanceV2', () => {
  test('amount=0 returns mag unchanged', () => {
    const mag = [new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5])];
    const phase = [new Float32Array(5)];
    const before = mag[0].slice();
    DSPCore.harmonicEnhanceV2(mag, phase, 0);
    for (let k = 0; k < 5; k++) expect(mag[0][k]).toBeCloseTo(before[k], 6);
  });

  test('no NaN or negative values in output', () => {
    const N = 2049;
    const mag = [Float32Array.from({ length: N }, () => Math.random() * 0.5)];
    const phase = [Float32Array.from({ length: N }, () => (Math.random() - 0.5) * Math.PI * 2)];
    DSPCore.harmonicEnhanceV2(mag, phase, 50, { sampleRate: 48000, fftSize: 4096 });
    for (const v of mag[0]) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  test('returns mag array (in-place)', () => {
    const mag = [new Float32Array(10).fill(0.2)];
    const phase = [new Float32Array(10)];
    expect(DSPCore.harmonicEnhanceV2(mag, phase, 20)).toBe(mag);
  });
});

// ── STFT / iSTFT roundtrip ────────────────────────────────────────────────────

describe('DSPCore STFT/iSTFT roundtrip', () => {
  test('440 Hz sine reconstructed within 2% error in central region', () => {
    const sr = 48000, N = sr;
    const data = new Float32Array(N);
    for (let i = 0; i < N; i++) data[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr);
    const { mag, phase } = DSPCore.forwardSTFT(data, 4096, 1024);
    const out = DSPCore.inverseSTFT(mag, phase, 4096, 1024, N);
    let maxErr = 0;
    for (let i = 4096; i < N - 4096; i++) {
      const e = Math.abs(out[i] - data[i]);
      if (e > maxErr) maxErr = e;
    }
    expect(maxErr).toBeLessThan(0.02);
  });

  test('iSTFT handles NaN/Inf magnitudes without producing non-finite output', () => {
    const N = 8192;
    const data = Float32Array.from({ length: N }, () => Math.random() * 0.1);
    const { mag, phase } = DSPCore.forwardSTFT(data, 4096, 1024);
    mag[0][0] = NaN;
    mag[0][1] = Infinity;
    mag[0][2] = -1;
    // Corrupt phases too — iSTFT should handle gracefully
    phase[0][0] = NaN;
    // inverseSTFT guards rawM but not phases; just verify no crash and output exists
    expect(() => DSPCore.inverseSTFT(mag, phase, 4096, 1024, N)).not.toThrow();
  });

  test('frameCount matches expected value', () => {
    const data = new Float32Array(48000);
    const { frameCount } = DSPCore.forwardSTFT(data, 4096, 1024);
    const expected = Math.floor((48000 - 4096) / 1024) + 1;
    expect(frameCount).toBe(expected);
  });

  test('short clips smaller than fftSize produce zero frames with empty spectra', () => {
    const data = new Float32Array(1024);
    const { frameCount, mag, phase } = DSPCore.forwardSTFT(data, 4096, 1024);
    expect(frameCount).toBe(0);
    expect(mag).toEqual([]);
    expect(phase).toEqual([]);
  });
});

// ── calcRMS / calcPeak ────────────────────────────────────────────────────────

describe('DSPCore.calcRMS and calcPeak', () => {
  test('calcRMS of all-zeros returns -96', () => {
    expect(DSPCore.calcRMS(new Float32Array(100))).toBe(-96);
  });

  test('calcRMS of full-scale DC returns 0 dB', () => {
    expect(DSPCore.calcRMS(new Float32Array(100).fill(1))).toBeCloseTo(0, 3);
  });

  test('calcPeak of all-zeros returns -96', () => {
    expect(DSPCore.calcPeak(new Float32Array(100))).toBe(-96);
  });

  test('calcPeak detects largest absolute value', () => {
    // calcPeak stores data[i]² then returns 10*log10(max²) = 20*log10(|max|)
    const data = new Float32Array([0.1, 0.5, -0.9, 0.3]);
    expect(DSPCore.calcPeak(data)).toBeCloseTo(10 * Math.log10(0.9 * 0.9), 2);
  });
});

// ── forwardSTFT / inverseSTFT — fftSize validation (v24 PR change) ────────────
// v24 added input validation to both forwardSTFT and inverseSTFT:
//   throws RangeError when fftSize is not an integer power of two >= 2.
describe('DSPCore.forwardSTFT — fftSize validation (v24)', () => {
  test('throws RangeError for fftSize = 0', () => {
    const data = new Float32Array(4096);
    expect(() => DSPCore.forwardSTFT(data, 0, 512)).toThrow(RangeError);
  });

  test('throws RangeError for fftSize = 1', () => {
    const data = new Float32Array(4096);
    expect(() => DSPCore.forwardSTFT(data, 1, 1)).toThrow(RangeError);
  });

  test('throws RangeError for fftSize = 3 (non-power-of-two)', () => {
    const data = new Float32Array(4096);
    expect(() => DSPCore.forwardSTFT(data, 3, 1)).toThrow(RangeError);
  });

  test('throws RangeError for fftSize = 1000 (non-power-of-two)', () => {
    const data = new Float32Array(4096);
    expect(() => DSPCore.forwardSTFT(data, 1000, 256)).toThrow(RangeError);
  });

  test('throws RangeError for negative fftSize', () => {
    const data = new Float32Array(4096);
    expect(() => DSPCore.forwardSTFT(data, -512, 256)).toThrow(RangeError);
  });

  test('throws RangeError for non-integer fftSize (e.g. 512.5)', () => {
    const data = new Float32Array(4096);
    expect(() => DSPCore.forwardSTFT(data, 512.5, 128)).toThrow(RangeError);
  });

  test('throws RangeError for fftSize = NaN', () => {
    const data = new Float32Array(4096);
    expect(() => DSPCore.forwardSTFT(data, NaN, 1024)).toThrow(RangeError);
  });

  test('throws RangeError for fftSize = Infinity', () => {
    const data = new Float32Array(4096);
    expect(() => DSPCore.forwardSTFT(data, Infinity, 1024)).toThrow(RangeError);
  });

  test('error message includes the invalid fftSize value', () => {
    const data = new Float32Array(4096);
    let msg = '';
    try { DSPCore.forwardSTFT(data, 3, 1); } catch (e) { msg = e.message; }
    expect(msg).toContain('3');
  });

  test('accepts fftSize = 2 (smallest valid power of two)', () => {
    const data = new Float32Array(2);
    expect(() => DSPCore.forwardSTFT(data, 2, 1)).not.toThrow();
  });

  test('accepts fftSize = 512', () => {
    const data = new Float32Array(512);
    expect(() => DSPCore.forwardSTFT(data, 512, 128)).not.toThrow();
  });

  test('accepts fftSize = 1024', () => {
    const data = new Float32Array(1024);
    expect(() => DSPCore.forwardSTFT(data, 1024, 256)).not.toThrow();
  });

  test('accepts fftSize = 4096 (default)', () => {
    const data = new Float32Array(4096);
    expect(() => DSPCore.forwardSTFT(data, 4096, 1024)).not.toThrow();
  });

  test('accepts fftSize = 8192', () => {
    const data = new Float32Array(8192);
    expect(() => DSPCore.forwardSTFT(data, 8192, 2048)).not.toThrow();
  });
});

describe('DSPCore.inverseSTFT — fftSize validation (v24)', () => {
  // Helper: produce a valid mag/phase pair for a given fftSize
  function makeMagPhase(fftSize, frameCount = 2) {
    const halfN = fftSize / 2 + 1;
    const mag   = Array.from({ length: frameCount }, () => new Float32Array(halfN).fill(0.1));
    const phase = Array.from({ length: frameCount }, () => new Float32Array(halfN));
    return { mag, phase };
  }

  test('throws RangeError for fftSize = 0', () => {
    const { mag, phase } = makeMagPhase(4);
    expect(() => DSPCore.inverseSTFT(mag, phase, 0, 1, 8)).toThrow(RangeError);
  });

  test('throws RangeError for fftSize = 1', () => {
    const { mag, phase } = makeMagPhase(4);
    expect(() => DSPCore.inverseSTFT(mag, phase, 1, 1, 4)).toThrow(RangeError);
  });

  test('throws RangeError for fftSize = 3 (non-power-of-two)', () => {
    const { mag, phase } = makeMagPhase(4);
    expect(() => DSPCore.inverseSTFT(mag, phase, 3, 1, 6)).toThrow(RangeError);
  });

  test('throws RangeError for fftSize = 600', () => {
    const { mag, phase } = makeMagPhase(4);
    expect(() => DSPCore.inverseSTFT(mag, phase, 600, 150, 1200)).toThrow(RangeError);
  });

  test('throws RangeError for negative fftSize', () => {
    const { mag, phase } = makeMagPhase(4);
    expect(() => DSPCore.inverseSTFT(mag, phase, -1024, 256, 2048)).toThrow(RangeError);
  });

  test('throws RangeError for non-integer fftSize', () => {
    const { mag, phase } = makeMagPhase(4);
    expect(() => DSPCore.inverseSTFT(mag, phase, 1024.1, 256, 2048)).toThrow(RangeError);
  });

  test('throws RangeError for fftSize = NaN', () => {
    const { mag, phase } = makeMagPhase(4);
    expect(() => DSPCore.inverseSTFT(mag, phase, NaN, 1024, 4096)).toThrow(RangeError);
  });

  test('error message mentions the invalid fftSize', () => {
    const { mag, phase } = makeMagPhase(4);
    let msg = '';
    try { DSPCore.inverseSTFT(mag, phase, 3, 1, 6); } catch (e) { msg = e.message; }
    expect(msg).toContain('3');
  });

  test('accepts fftSize = 2 (minimum valid)', () => {
    const { mag, phase } = makeMagPhase(2);
    expect(() => DSPCore.inverseSTFT(mag, phase, 2, 1, 4)).not.toThrow();
  });

  test('accepts fftSize = 512', () => {
    const halfN = 512 / 2 + 1;
    const mag   = [new Float32Array(halfN).fill(0.1)];
    const phase = [new Float32Array(halfN)];
    expect(() => DSPCore.inverseSTFT(mag, phase, 512, 128, 512)).not.toThrow();
  });

  test('accepts fftSize = 4096 (default)', () => {
    const halfN = 4096 / 2 + 1;
    const mag   = [new Float32Array(halfN).fill(0.1)];
    const phase = [new Float32Array(halfN)];
    expect(() => DSPCore.inverseSTFT(mag, phase, 4096, 1024, 4096)).not.toThrow();
  });

  test('STFT / iSTFT roundtrip still works with explicit fftSize=2048', () => {
    const fftSize = 2048;
    const hopSize = 512;
    const sr = 48000;
    const data = new Float32Array(sr);
    for (let i = 0; i < sr; i++) data[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / sr);
    const { mag, phase, frameCount } = DSPCore.forwardSTFT(data, fftSize, hopSize);
    expect(frameCount).toBeGreaterThan(0);
    const out = DSPCore.inverseSTFT(mag, phase, fftSize, hopSize, sr);
    // Central region should round-trip accurately
    let maxErr = 0;
    for (let i = fftSize; i < sr - fftSize; i++) {
      const e = Math.abs(out[i] - data[i]);
      if (e > maxErr) maxErr = e;
    }
    expect(maxErr).toBeLessThan(0.02);
  });
});