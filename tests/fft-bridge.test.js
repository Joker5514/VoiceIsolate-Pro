'use strict';

const fs = require('fs');
const path = require('path');

const fftBridgeSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/fft-bridge.js'),
  'utf8'
).replace(/^export\s+/gm, '');

const FFTBridge = new Function(
  `${fftBridgeSrc}\nreturn { computeSTFT, reconstructISTFT, encodeWAV };`
)();

describe('fft-bridge', () => {
  test('computeSTFT emits at least one frame for empty and short buffers', () => {
    const empty = FFTBridge.computeSTFT(new Float32Array(0), 1024, 256, 48000);
    const short = FFTBridge.computeSTFT(new Float32Array(32), 1024, 256, 48000);

    expect(empty.magnitudes.length).toBeGreaterThanOrEqual(1);
    expect(empty.phases.length).toBeGreaterThanOrEqual(1);
    expect(short.magnitudes.length).toBeGreaterThanOrEqual(1);
  });

  test('STFT/iSTFT roundtrip preserves sine RMS in steady-state window', () => {
    const sampleRate = 48000;
    const fftSize = 1024;
    const hopSize = 256;
    const length = sampleRate;
    const freq = 440;
    const input = new Float32Array(length);
    for (let i = 0; i < length; i++) input[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);

    const { magnitudes, phases } = FFTBridge.computeSTFT(input, fftSize, hopSize, sampleRate);
    const output = FFTBridge.reconstructISTFT(magnitudes, phases, fftSize, hopSize);

    let sumIn = 0;
    let sumOut = 0;
    let count = 0;
    for (let i = fftSize; i < length - fftSize; i++) {
      sumIn += input[i] * input[i];
      sumOut += output[i] * output[i];
      count++;
    }
    const inRms = Math.sqrt(sumIn / Math.max(1, count));
    const outRms = Math.sqrt(sumOut / Math.max(1, count));
    expect(Number.isFinite(outRms)).toBe(true);
    expect(outRms / inRms).toBeGreaterThan(0.9);
    expect(outRms / inRms).toBeLessThan(1.1);
  });

  test('encodeWAV writes a RIFF/WAVE header', () => {
    const buf = FFTBridge.encodeWAV(new Float32Array([0, 0.5, -0.5]), 44100);
    const view = new DataView(buf);
    const readTag = (start) => String.fromCharCode(
      view.getUint8(start),
      view.getUint8(start + 1),
      view.getUint8(start + 2),
      view.getUint8(start + 3)
    );

    expect(readTag(0)).toBe('RIFF');
    expect(readTag(8)).toBe('WAVE');
    expect(readTag(36)).toBe('data');
  });
});
