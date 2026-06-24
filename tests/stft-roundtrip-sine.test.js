'use strict';

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

describe('Single-pass STFT → iSTFT sine roundtrip', () => {
  test('reconstructs a pure sine wave within floating-point epsilon tolerance', () => {
    const sampleRate = 48000;
    const fftSize = 1024;
    const hopSize = 256;
    const length = sampleRate;
    const freq = 440;
    const input = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      input[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }

    const { mag, phase } = DSPCore.forwardSTFT(input, fftSize, hopSize);
    const output = DSPCore.inverseSTFT(mag, phase, fftSize, hopSize, length);

    let maxErr = 0;
    const start = fftSize;
    const end = length - fftSize;
    for (let i = start; i < end; i++) {
      maxErr = Math.max(maxErr, Math.abs(output[i] - input[i]));
    }
    expect(maxErr).toBeLessThan(1e-3);
  });
});
