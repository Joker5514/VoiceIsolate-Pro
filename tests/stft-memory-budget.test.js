'use strict';

/**
 * Whole-file STFT memory guard.
 *
 * Production ceiling: DSPCore.MAX_STFT_SPECTRUM_BYTES = 192 MiB of float32
 * mag+phase payload, frameCount * (fftSize/2+1) * 8. The guard runs before
 * those arrays are allocated. These tests temporarily lower the ceiling so
 * "maximum length" and "one sample past it" are real buffers, not a 192 MiB
 * allocation. processChunked does not consult the ceiling: it keeps only
 * `chunkFrames` spectra, so an over-limit file still renders.
 */

const fs = require('fs');
const path = require('path');

const dspSrc = fs.readFileSync(path.join(__dirname, '../public/app/dsp-core.js'), 'utf8');
const DSPCore = (() => {
  const exports = {};
  const module = { exports };
  const window = undefined;
  const self = undefined;
  // eslint-disable-next-line no-eval
  eval(dspSrc);
  return module.exports;
})();

const FFT = 1024;
const HOP = 256;

function maxSamplesFor(byteLimit) {
  const halfN = FFT / 2 + 1;
  const bytesPerFrame = halfN * 8;
  const maxFrames = Math.floor(byteLimit / bytesPerFrame);
  const pad = FFT - HOP;
  return { maxFrames, samples: maxFrames * HOP - pad };
}

describe('STFT spectrum budget', () => {
  const ORIGINAL = DSPCore.MAX_STFT_SPECTRUM_BYTES;
  const TEST_LIMIT = 256 * 1024;

  beforeEach(() => {
    DSPCore.MAX_STFT_SPECTRUM_BYTES = TEST_LIMIT;
  });
  afterAll(() => {
    DSPCore.MAX_STFT_SPECTRUM_BYTES = ORIGINAL;
  });

  test('the production ceiling is the documented 192 MiB', () => {
    expect(ORIGINAL).toBe(192 * 1024 * 1024);
  });

  test('short audio is under the limit', () => {
    const input = new Float32Array(4096);
    input[10] = 0.2;
    const spec = DSPCore.forwardSTFT(input, FFT, HOP);
    expect(spec.frameCount).toBeGreaterThan(0);
    const out = DSPCore.processChunked(input, FFT, HOP, { chunkFrames: 4 });
    expect(out.length).toBe(input.length);
  });

  test('the maximum supported length is accepted and one more sample is rejected before allocation', () => {
    const { samples, maxFrames } = maxSamplesFor(TEST_LIMIT);
    expect(samples).toBeGreaterThan(FFT);
    const atLimit = new Float32Array(samples);
    atLimit[0] = 0.25;
    const spec = DSPCore.forwardSTFT(atLimit, FFT, HOP);
    expect(spec.frameCount).toBe(maxFrames);
    expect(DSPCore.spectrumPayloadBytes(spec.frameCount, FFT)).toBeLessThanOrEqual(TEST_LIMIT);

    const over = new Float32Array(samples + 1);
    expect(() => DSPCore.forwardSTFT(over, FFT, HOP)).toThrow(RangeError);
    try {
      DSPCore.forwardSTFT(over, FFT, HOP);
    } catch (err) {
      expect(err.message).toMatch(/processChunked/);
      expect(err.message).toMatch(new RegExp(String(TEST_LIMIT)));
    }
  });

  test('async forward rejects the same over-limit input', async () => {
    const { samples } = maxSamplesFor(TEST_LIMIT);
    const over = new Float32Array(samples + 1);
    await expect(DSPCore.forwardSTFTAsync(over, FFT, HOP)).rejects.toThrow(RangeError);
  });

  test('chunked processing of an over-limit buffer keeps the length and stays finite', () => {
    const { samples } = maxSamplesFor(TEST_LIMIT);
    const over = new Float32Array(samples + 1);
    for (let i = 0; i < over.length; i += 50) over[i] = 0.2;
    const out = DSPCore.processChunked(over, FFT, HOP, { chunkFrames: 8 });
    expect(out.length).toBe(over.length);
    for (let i = 0; i < out.length; i += 1000) expect(Number.isFinite(out[i])).toBe(true);
  });
});
