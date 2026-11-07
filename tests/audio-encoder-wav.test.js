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

/** Independent RIFF walker. Does not import the encoder. */
async function parseWav(blob) {
  const buf = Buffer.from(await blob.arrayBuffer());
  const tag = (o) => buf.toString('ascii', o, o + 4);
  expect(tag(0)).toBe('RIFF');
  expect(buf.readUInt32LE(4)).toBe(buf.length - 8);
  expect(tag(8)).toBe('WAVE');
  let fmt = null;
  let dataOffset = null;
  let dataSize = null;
  let factFrames = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = tag(at);
    const size = buf.readUInt32LE(at + 4);
    const start = at + 8;
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: buf.readUInt16LE(start), channels: buf.readUInt16LE(start + 2), sampleRate: buf.readUInt32LE(start + 4),
        byteRate: buf.readUInt32LE(start + 8), blockAlign: buf.readUInt16LE(start + 12), bits: buf.readUInt16LE(start + 14),
      };
    } else if (id === 'fact' && size >= 4) {
      factFrames = buf.readUInt32LE(start);
    } else if (id === 'data') {
      dataOffset = start;
      dataSize = size;
    }
    const next = start + size + (size % 2);
    if (next <= at) break;
    at = next;
  }
  expect(fmt).toBeTruthy();
  expect(dataOffset).not.toBeNull();
  expect(dataSize).toBe(buf.length - dataOffset);
  const frames = dataSize / fmt.blockAlign;
  const ch = fmt.bits === 16
    ? Array.from({ length: fmt.channels }, () => new Int16Array(frames))
    : null;
  const pcm24 = fmt.bits === 24
    ? Array.from({ length: fmt.channels }, () => new Int32Array(frames))
    : null;
  const floatCh = fmt.format === 3
    ? Array.from({ length: fmt.channels }, () => new Float32Array(frames))
    : null;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      const off = dataOffset + (i * fmt.channels + c) * fmt.blockAlign / fmt.channels;
      if (ch) ch[c][i] = buf.readInt16LE(off);
      else if (pcm24) {
        let q = buf.readUInt8(off) | (buf.readUInt8(off + 1) << 8) | (buf.readUInt8(off + 2) << 16);
        if (q & 0x800000) q -= 0x1000000;
        pcm24[c][i] = q;
      } else if (floatCh) floatCh[c][i] = buf.readFloatLE(off);
    }
  }
  return { fmt, frames, dataOffset, factFrames, ch, pcm24, floatCh };
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
  // 0.5 × 32767 = 16383.5 rounds to 16384 (truncation would give 16383).
  expect(Array.from(w.ch[0])).toEqual([32767, -32768, 16384, 32767, -32768]);
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

  test('full-scale 16-bit codes and 24-bit / 32-bit float headers', async () => {
  const samples = new Float32Array([1, -1, 0.999999, -0.999999]);
  const pcm16 = enc.encodeWAV([samples], 48000, { bitDepth: 16, ditherAmt: 0 });
  const w16 = await parseWav(pcm16.blob);
  expect(w16.fmt).toMatchObject({ format: 1, bits: 16, blockAlign: 2, channels: 1 });
  expect(w16.dataOffset).toBe(44);
  // 1 → 32767, −1 → −32768. The near-full-scale pair is already Float32,
  // and both still land on those rails.
  expect(Array.from(w16.ch[0])).toEqual([32767, -32768, 32767, -32768]);

  const pcm24 = enc.encodeWAV([samples], 48000, { bitDepth: 24, ditherAmt: 0 });
  const w24 = await parseWav(pcm24.blob);
  expect(w24.fmt).toMatchObject({ format: 1, bits: 24, blockAlign: 3, byteRate: 48000 * 3 });
  expect(w24.dataOffset).toBe(44);
  // +1 → 8388607, −1 → −8388608. Float32(±0.999999) is ±0.9999989867;
  // the negative product is an exact .5 and Math.round ties toward +∞.
  expect(Array.from(w24.pcm24[0])).toEqual([8388607, -8388608, 8388599, -8388599]);

  const pcm32 = enc.encodeWAV([samples], 48000, { bitDepth: 32, ditherAmt: 0 });
  const w32 = await parseWav(pcm32.blob);
  expect(w32.fmt).toMatchObject({ format: 3, bits: 32, blockAlign: 4, byteRate: 48000 * 4 });
  expect(w32.factFrames).toBe(4);
  expect(w32.dataOffset).toBe(58);
  expect(Array.from(w32.floatCh[0])).toEqual([
    1, -1, Math.fround(0.999999), Math.fround(-0.999999),
  ]);
});

test('data larger than the RIFF 32-bit size field', () => {
    const huge = Object.create(Float32Array.prototype);
    Object.defineProperty(huge, 'length', { value: 2 ** 31 });
    expect(() => enc.validatePcm([huge], 48000)).toThrow(/4 GiB/);
  });
});
