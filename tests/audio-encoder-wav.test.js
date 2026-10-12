/**
 * F23/F24 — the REAL AudioEncoderWorker module (tests/audio-encoder-worker.test.js
 * exercises mocks only). Output is checked with an independent RIFF parser;
 * Chromium's own decoder is exercised by scripts/runtime-contracts-browser-check.cjs.
 */
'use strict';

let enc;
beforeAll(async () => {
  enc = await import('../src/workers/AudioEncoderWorker.js');
});

/** Minimal independent WAV reader (RIFF/WAVE, PCM 16-bit). */
async function parseWav(blob) {
  const buf = Buffer.from(await blob.arrayBuffer());
  const tag = (o) => buf.toString('ascii', o, o + 4);
  expect(tag(0)).toBe('RIFF');
  expect(buf.readUInt32LE(4)).toBe(buf.length - 8);
  expect(tag(8)).toBe('WAVE');
  expect(tag(12)).toBe('fmt ');
  const fmt = {
    format: buf.readUInt16LE(20), channels: buf.readUInt16LE(22), sampleRate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28), blockAlign: buf.readUInt16LE(32), bits: buf.readUInt16LE(34),
  };
  expect(tag(36)).toBe('data');
  const dataSize = buf.readUInt32LE(40);
  expect(dataSize).toBe(buf.length - 44);
  const frames = dataSize / fmt.blockAlign;
  const ch = Array.from({ length: fmt.channels }, () => new Int16Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) ch[c][i] = buf.readInt16LE(44 + (i * fmt.channels + c) * 2);
  return { fmt, frames, ch };
}

test('stereo WAV round-trips through an independent parser within 1 LSB', async () => {
  const n = 4801; // odd length
  const l = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / 48000));
  const r = Float32Array.from({ length: n }, (_, i) => 0.25 * Math.cos((2 * Math.PI * 1000 * i) / 48000));
  const { blob, clippedSamples } = enc.encodeWAV([l, r], 48000);
  expect(clippedSamples).toBe(0);
  const w = await parseWav(blob);
  expect(w.fmt).toEqual({ format: 1, channels: 2, sampleRate: 48000, byteRate: 48000 * 4, blockAlign: 4, bits: 16 });
  expect(w.frames).toBe(n);
  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    maxErr = Math.max(maxErr, Math.abs(w.ch[0][i] / 32767 - l[i]), Math.abs(w.ch[1][i] / 32767 - r[i]));
  }
  expect(maxErr).toBeLessThan(1.5 / 32767);
});

test('clipping policy: clamped to full scale and counted', async () => {
  const { blob, clippedSamples } = enc.encodeWAV([new Float32Array([1.5, -2, 0.5, 1, -1])], 48000);
  expect(clippedSamples).toBe(2);
  const w = await parseWav(blob);
  expect(Array.from(w.ch[0])).toEqual([32767, -32768, 16383, 32767, -32768]);
});

describe('malformed PCM is rejected, never silently encoded', () => {
  const ok = () => new Float32Array([0, 0.1]);
  test.each([
    ['unequal channel lengths', [new Float32Array(3), new Float32Array(2)], 48000, /lengths differ/],
    ['NaN sample', [new Float32Array([0, NaN, 0.2])], 48000, /1 non-finite/],
    ['Infinity sample', [new Float32Array([Infinity, -Infinity])], 48000, /2 non-finite/],
    ['plain array channel', [[0, 0.1]], 48000, /Float32Array/],
    ['empty audio', [new Float32Array(0)], 48000, /empty/],
    ['no channels', [], 48000, /1–8/],
    ['nine channels', Array.from({ length: 9 }, ok), 48000, /1–8/],
    ['fractional rate', [ok()], 44100.5, /sample rate/],
    ['zero rate', [ok()], 0, /sample rate/],
    ['absurd rate', [ok()], 10_000_000, /sample rate/],
  ])('%s', (_name, channels, rate, re) => {
    expect(() => enc.encodeWAV(channels, rate)).toThrow(re);
  });

  test('data larger than the RIFF 32-bit size field', () => {
    const huge = Object.create(Float32Array.prototype);
    Object.defineProperty(huge, 'length', { value: 2 ** 31 });
    expect(() => enc.validatePcm([huge], 48000)).toThrow(/4 GiB/);
  });
});
