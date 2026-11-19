/**
 * sliceBufferChannels() — the windowed channel copy used by
 * measureAudioBuffer(). A per-slider-move measurement must never copy a
 * whole long file on the main thread (a 522 s mono file is ~100 MB per
 * channel); the window bounds the copy to the requested excerpt.
 */
'use strict';

let sliceBufferChannels;

beforeAll(async () => {
  ({ sliceBufferChannels } = await import('../src/pipeline/AudioReview.js'));
});

function fakeBuffer(seconds, sampleRate = 48000, channels = 1) {
  const len = Math.round(seconds * sampleRate);
  const data = Array.from({ length: channels }, (_, c) => {
    const arr = new Float32Array(len);
    arr.fill(c + 1);
    // Mark the 30 s boundary so a window error is visible in the values.
    for (let i = 0; i < len; i++) arr[i] = i;
    return arr;
  });
  return {
    numberOfChannels: channels,
    length: len,
    duration: seconds,
    sampleRate,
    getChannelData: (c) => data[c],
  };
}

describe('sliceBufferChannels', () => {
  test('returns only the requested window', () => {
    const buf = fakeBuffer(522.768);
    const [ch] = sliceBufferChannels(buf, { startSec: 0, endSec: 30 });
    expect(ch.length).toBe(30 * 48000);
    expect(ch[0]).toBe(0);
    expect(ch[ch.length - 1]).toBe(30 * 48000 - 1);
  });

  test('copies the whole buffer when no window is given (existing callers)', () => {
    const buf = fakeBuffer(10);
    const [ch] = sliceBufferChannels(buf);
    expect(ch.length).toBe(10 * 48000);
  });

  test('clamps the window to the buffer length', () => {
    const buf = fakeBuffer(10);
    const [ch] = sliceBufferChannels(buf, { startSec: 0, endSec: 30 });
    expect(ch.length).toBe(10 * 48000);
  });

  test('windows every channel', () => {
    const buf = fakeBuffer(60, 48000, 2);
    const chans = sliceBufferChannels(buf, { startSec: 10, endSec: 20 });
    expect(chans).toHaveLength(2);
    expect(chans[0].length).toBe(10 * 48000);
    expect(chans[0][0]).toBe(10 * 48000);
    expect(chans[1][0]).toBe(10 * 48000);
  });
});
