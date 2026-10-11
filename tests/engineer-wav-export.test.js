'use strict';

/**
 * Executes Engineer Mode's WAV encoder (public/app/app.js encodeWavBuffer)
 * against the real ui-yield processInChunks. It used to write the whole file
 * in one main-thread task, calling getChannelData() once per sample, and
 * truncated toward zero instead of rounding.
 */
const fs = require('fs');
const path = require('path');

const app = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
const body = app.slice(app.indexOf('async function encodeWavBuffer('), app.indexOf('async function downloadWav('));

let encodeWavBuffer;
beforeAll(async () => {
  const { processInChunks, throwIfAborted } = await import('../src/pipeline/ui-yield.js');
  // eslint-disable-next-line no-new-func
  encodeWavBuffer = new Function('processInChunks', 'throwIfAborted', `${body}; return encodeWavBuffer;`)(processInChunks, throwIfAborted);
});

function fakeBuffer(channels, sampleRate = 48000) {
  let calls = 0;
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    getChannelData(ch) { calls += 1; return channels[ch]; },
    get calls() { return calls; },
  };
}

describe('Engineer encodeWavBuffer', () => {
  test('interleaves every sample across chunk seams with a valid header', async () => {
    const len = 48000 * 2 + 123; // crosses two 48 000-sample chunk boundaries
    const l = new Float32Array(len);
    const r = new Float32Array(len);
    for (let i = 0; i < len; i++) { l[i] = ((i % 200) - 100) / 128; r[i] = -l[i] * 0.5; }
    const buf = fakeBuffer([l, r]);
    const out = await encodeWavBuffer(buf, 0);
    const v = new DataView(out);
    expect(out.byteLength).toBe(44 + len * 4);
    expect(v.getUint32(4, true)).toBe(out.byteLength - 8);
    expect(v.getUint32(40, true)).toBe(len * 4);
    expect(v.getUint16(22, true)).toBe(2);
    expect(v.getUint32(24, true)).toBe(48000);
    for (const i of [0, 47999, 48000, 96000, len - 1]) {
      const q = (s) => Math.round(Math.max(-1, Math.min(1, s)) * (s < 0 ? 0x8000 : 0x7FFF));
      expect(v.getInt16(44 + i * 4, true)).toBe(q(l[i]));
      expect(v.getInt16(46 + i * 4, true)).toBe(q(r[i]));
    }
    expect(buf.calls).toBe(2); // once per channel, not per sample
  });

  test('rounds to the nearest code instead of truncating toward zero', async () => {
    const out = await encodeWavBuffer(fakeBuffer([Float32Array.of(0.9 / 0x7FFF, -0.9 / 0x8000, 1, -1, NaN)]), 0);
    const v = new DataView(out);
    expect([0, 1, 2, 3, 4].map((i) => v.getInt16(44 + i * 2, true))).toEqual([1, -1, 32767, -32768, 0]);
  });

  test('an already-aborted export stops before allocating or reading audio', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const buf = fakeBuffer([new Float32Array(48000 * 3)]);
    await expect(encodeWavBuffer(buf, 0, ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(buf.calls).toBe(0);
  });

  test('refuses exports past the 4 GB RIFF limit instead of wrapping the header', async () => {
    const huge = { numberOfChannels: 2, length: 2 ** 30, sampleRate: 48000, getChannelData() { throw new Error('unreachable'); } };
    await expect(encodeWavBuffer(huge, 0)).rejects.toThrow(/4 GB/);
  });
});
