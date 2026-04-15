/**
 * VoiceIsolate Pro — SharedRingBuffer Unit Tests
 *
 * Tests the lock-free SharedArrayBuffer ring buffer used for zero-copy
 * data transfer between the AudioWorklet and ML Worker threads.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ring-buffer.js exports via module.exports; load via eval to bypass ESM detection
const rbSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/ring-buffer.js'),
  'utf8'
);
const SharedRingBuffer = (() => {
  const exports = {};
  const module  = { exports };
  /* eslint-disable no-unused-vars */
  const window = undefined; // no browser window in this context
  /* eslint-enable no-unused-vars */
  eval(rbSrc); // eslint-disable-line no-eval
  return module.exports;
})();

describe('SharedRingBuffer — constructor', () => {
  test('stores frameSize and frameCount', () => {
    const rb = new SharedRingBuffer(128, 8);
    expect(rb.frameSize).toBe(128);
    expect(rb.frameCount).toBe(8);
  });

  test('capacity equals frameSize * frameCount', () => {
    const rb = new SharedRingBuffer(128, 8);
    expect(rb.capacity).toBe(1024);
  });

  test('available() starts at 0', () => {
    const rb = new SharedRingBuffer(128, 8);
    expect(rb.available()).toBe(0);
  });

  test('space() starts at capacity - 1 (ring-buffer invariant)', () => {
    const rb = new SharedRingBuffer(64, 4);
    expect(rb.space()).toBe(64 * 4 - 1);
  });

  test('available() + space() + 1 equals capacity', () => {
    const rb = new SharedRingBuffer(64, 4);
    expect(rb.available() + rb.space() + 1).toBe(rb.capacity);
  });

  test('can reattach to an existing SharedArrayBuffer', () => {
    const rb1 = new SharedRingBuffer(64, 4);
    const sab = rb1.getBuffer();
    const rb2 = new SharedRingBuffer(64, 4, sab);
    expect(rb2.capacity).toBe(rb1.capacity);
    expect(rb2.getBuffer()).toBe(sab);
  });

  test('isSupported() returns true in Node.js 20', () => {
    expect(SharedRingBuffer.isSupported()).toBe(true);
  });
});

describe('SharedRingBuffer — push', () => {
  test('push returns true when space is available', () => {
    const rb = new SharedRingBuffer(64, 4);
    const samples = new Float32Array(32).fill(0.5);
    expect(rb.push(samples)).toBe(true);
  });

  test('push increments available count by the pushed length', () => {
    const rb = new SharedRingBuffer(64, 4);
    rb.push(new Float32Array(32).fill(1.0));
    expect(rb.available()).toBe(32);
    rb.push(new Float32Array(16).fill(1.0));
    expect(rb.available()).toBe(48);
  });

  test('push returns false when ring is full', () => {
    const rb = new SharedRingBuffer(4, 2); // capacity = 8, usable = 7
    rb.push(new Float32Array(7).fill(1.0)); // fill to the limit
    expect(rb.push(new Float32Array(1).fill(1.0))).toBe(false);
  });

  test('push returns false when requested size exceeds available space', () => {
    const rb = new SharedRingBuffer(4, 2);
    rb.push(new Float32Array(5).fill(1.0));
    expect(rb.push(new Float32Array(4).fill(1.0))).toBe(false);
  });
});

describe('SharedRingBuffer — pull', () => {
  test('pull returns null when fewer samples are available than requested', () => {
    const rb = new SharedRingBuffer(64, 4);
    expect(rb.pull(10)).toBeNull();
  });

  test('pull returns exact sample values in FIFO order', () => {
    const rb = new SharedRingBuffer(64, 4);
    const samples = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    rb.push(samples);
    const out = rb.pull(4);
    expect(out).not.toBeNull();
    expect(out[0]).toBeCloseTo(1.0, 5);
    expect(out[1]).toBeCloseTo(2.0, 5);
    expect(out[2]).toBeCloseTo(3.0, 5);
    expect(out[3]).toBeCloseTo(4.0, 5);
  });

  test('pull decrements available count', () => {
    const rb = new SharedRingBuffer(64, 4);
    rb.push(new Float32Array(16).fill(1.0));
    rb.pull(8);
    expect(rb.available()).toBe(8);
  });

  test('pull writes into a supplied destination buffer', () => {
    const rb = new SharedRingBuffer(64, 4);
    rb.push(new Float32Array([0.1, 0.2, 0.3]));
    const dest = new Float32Array(3);
    const result = rb.pull(3, dest);
    expect(result).toBe(dest);
    expect(dest[0]).toBeCloseTo(0.1, 5);
    expect(dest[1]).toBeCloseTo(0.2, 5);
    expect(dest[2]).toBeCloseTo(0.3, 5);
  });

  test('multiple interleaved push/pull cycles preserve sample integrity', () => {
    const rb = new SharedRingBuffer(32, 4);
    for (let round = 0; round < 8; round++) {
      const data = new Float32Array(16);
      for (let i = 0; i < 16; i++) data[i] = round * 100 + i;
      rb.push(data);
      const out = rb.pull(16);
      expect(out).not.toBeNull();
      for (let i = 0; i < 16; i++) {
        expect(out[i]).toBeCloseTo(round * 100 + i, 4);
      }
    }
  });
});

describe('SharedRingBuffer — wraparound', () => {
  test('correctly writes and reads data that straddles the ring boundary', () => {
    const rb = new SharedRingBuffer(4, 4); // capacity = 16
    // Use 12 slots then drain, positioning write-pointer near the end
    rb.push(new Float32Array(12).fill(9.0));
    rb.pull(12);
    expect(rb.available()).toBe(0);

    // A 10-element write now straddles the end-of-buffer boundary
    const wrap = new Float32Array(10);
    for (let i = 0; i < 10; i++) wrap[i] = i + 1;
    expect(rb.push(wrap)).toBe(true);

    const out = rb.pull(10);
    expect(out).not.toBeNull();
    for (let i = 0; i < 10; i++) {
      expect(out[i]).toBeCloseTo(i + 1, 5);
    }
  });

  test('maintains FIFO order after writing an aggregate 1.5x capacity across wrap-around', () => {
    const rb = new SharedRingBuffer(8, 8); // capacity = 64, usable = 63
    const capacity = rb.capacity;

    const totalToWrite = Math.floor(capacity * 1.5);
    let nextValue = 0;
    const readBack = [];

    while (nextValue < totalToWrite) {
      const chunkLen = Math.min(17, totalToWrite - nextValue);
      while (rb.space() < chunkLen) {
        const pullLen = Math.min(9, rb.available());
        const partial = rb.pull(pullLen);
        expect(partial).not.toBeNull();
        for (let i = 0; i < partial.length; i++) readBack.push(partial[i]);
      }
      const chunk = new Float32Array(chunkLen);
      for (let i = 0; i < chunkLen; i++) chunk[i] = nextValue + i;
      expect(rb.push(chunk)).toBe(true);
      nextValue += chunkLen;
    }

    const remaining = rb.pull(rb.available());
    expect(remaining).not.toBeNull();
    for (let i = 0; i < remaining.length; i++) readBack.push(remaining[i]);

    expect(readBack.length).toBe(totalToWrite);
    for (let i = 0; i < totalToWrite; i++) {
      expect(readBack[i]).toBeCloseTo(i, 5);
    }
  });
});

describe('SharedRingBuffer — peek', () => {
  test('peek returns the correct values', () => {
    const rb = new SharedRingBuffer(64, 4);
    rb.push(new Float32Array([1.0, 2.0, 3.0]));
    const p = rb.peek(3);
    expect(p).not.toBeNull();
    expect(p[0]).toBeCloseTo(1.0, 5);
    expect(p[2]).toBeCloseTo(3.0, 5);
  });

  test('peek does not advance the read pointer', () => {
    const rb = new SharedRingBuffer(64, 4);
    rb.push(new Float32Array([1.0, 2.0, 3.0]));
    rb.peek(3);
    expect(rb.available()).toBe(3);
  });

  test('data peeked matches data subsequently pulled', () => {
    const rb = new SharedRingBuffer(64, 4);
    rb.push(new Float32Array([5.5, 6.6, 7.7]));
    const peeked = rb.peek(3);
    const pulled = rb.pull(3);
    for (let i = 0; i < 3; i++) {
      expect(peeked[i]).toBeCloseTo(pulled[i], 5);
    }
  });

  test('peek returns null when not enough samples available', () => {
    const rb = new SharedRingBuffer(64, 4);
    expect(rb.peek(5)).toBeNull();
  });
});

describe('SharedRingBuffer — overflow counter', () => {
  test('overflows() starts at 0', () => {
    const rb = new SharedRingBuffer(64, 4);
    expect(rb.overflows()).toBe(0);
  });

  test('overflows() increments each time push fails due to no space', () => {
    const rb = new SharedRingBuffer(4, 2); // capacity = 8, usable = 7
    rb.push(new Float32Array(7).fill(1.0)); // fill completely
    rb.push(new Float32Array(1).fill(1.0)); // overflow #1
    rb.push(new Float32Array(1).fill(1.0)); // overflow #2
    expect(rb.overflows()).toBe(2);
  });
});

describe('SharedRingBuffer — reset', () => {
  test('reset zeroes available and restores full space', () => {
    const rb = new SharedRingBuffer(64, 4);
    rb.push(new Float32Array(50).fill(1.0));
    rb.reset();
    expect(rb.available()).toBe(0);
    expect(rb.space()).toBe(rb.capacity - 1);
  });

  test('reset clears the overflow counter', () => {
    const rb = new SharedRingBuffer(4, 2);
    rb.push(new Float32Array(7).fill(1.0));
    rb.push(new Float32Array(1).fill(1.0)); // trigger overflow
    expect(rb.overflows()).toBe(1);
    rb.reset();
    expect(rb.overflows()).toBe(0);
  });

  test('push and pull work normally after a reset', () => {
    const rb = new SharedRingBuffer(64, 4);
    rb.push(new Float32Array(32).fill(99.0));
    rb.reset();
    const fresh = new Float32Array([1.0, 2.0, 3.0]);
    rb.push(fresh);
    const out = rb.pull(3);
    expect(out[0]).toBeCloseTo(1.0, 5);
    expect(out[1]).toBeCloseTo(2.0, 5);
    expect(out[2]).toBeCloseTo(3.0, 5);
  });
});

describe('SharedRingBuffer — getBuffer', () => {
  test('returns a SharedArrayBuffer instance', () => {
    const rb = new SharedRingBuffer(64, 4);
    expect(rb.getBuffer()).toBeInstanceOf(SharedArrayBuffer);
  });

  test('shared buffer allows two instances to share state', () => {
    const rb1 = new SharedRingBuffer(64, 4);
    rb1.push(new Float32Array([1.0, 2.0, 3.0]));

    const rb2 = new SharedRingBuffer(64, 4, rb1.getBuffer());
    expect(rb2.available()).toBe(3);
    const out = rb2.pull(3);
    expect(out[0]).toBeCloseTo(1.0, 5);
  });
});
