/* ============================================
   VoiceIsolate Pro v20.0 — SharedRingBuffer
   Threads from Space v10 · Zero-Copy Transfer
   Lock-Free · SharedArrayBuffer + Atomics
   ============================================ */

'use strict';

/**
 * Lock-free ring buffer on SharedArrayBuffer for zero-copy data transfer
 * between AudioWorklet and ML Worker threads.
 *
 * Memory layout (Int32Array control header + Float32Array data):
 *   [0] writePointer  (Atomics)
 *   [1] readPointer   (Atomics)
 *   [2] capacity      (immutable after init)
 *   [3] overflowCount (Atomics)
 *
 * Data region: Float32Array starting at byte offset 16
 */
class SharedRingBuffer {
  /**
   * @param {number} frameSize   - samples per frame (e.g. 4096)
   * @param {number} frameCount  - number of frames to buffer (e.g. 10)
   * @param {SharedArrayBuffer} [existingSAB] - reuse existing SAB (for worker side)
   */
  constructor(frameSize, frameCount, existingSAB) {
    this.frameSize = frameSize;
    this.frameCount = frameCount;
    this.capacity = frameSize * frameCount;

    const headerBytes = 16; // 4 × Int32
    const dataBytes = this.capacity * Float32Array.BYTES_PER_ELEMENT;
    const totalBytes = headerBytes + dataBytes;

    if (existingSAB) {
      this.sab = existingSAB;
    } else {
      this.sab = new SharedArrayBuffer(totalBytes);
    }

    this.control = new Int32Array(this.sab, 0, 4);
    this.data = new Float32Array(this.sab, headerBytes, this.capacity);

    if (!existingSAB) {
      Atomics.store(this.control, 0, 0); // writePointer
      Atomics.store(this.control, 1, 0); // readPointer
      Atomics.store(this.control, 2, this.capacity);
      Atomics.store(this.control, 3, 0); // overflowCount
    }
  }

  /** Number of samples available to read */
  available() {
    const w = Atomics.load(this.control, 0);
    const r = Atomics.load(this.control, 1);
    return (w - r + this.capacity) % this.capacity;
  }

  /** Remaining writable space */
  space() {
    return this.capacity - 1 - this.available();
  }

  /**
   * Push samples into the ring buffer (writer side).
   * @param {Float32Array} samples
   * @returns {boolean} true if written, false if overflow
   */
  push(samples) {
    const len = samples.length;
    if (len > this.space()) {
      Atomics.add(this.control, 3, 1);
      return false; // overflow
    }

    let w = Atomics.load(this.control, 0);

    // Handle wrap-around with two-part copy
    const firstPart = Math.min(len, this.capacity - w);
    this.data.set(samples.subarray(0, firstPart), w);
    if (firstPart < len) {
      this.data.set(samples.subarray(firstPart), 0);
    }

    // Advance write pointer atomically
    Atomics.store(this.control, 0, (w + len) % this.capacity);
    return true;
  }

  /**
   * Pull samples from the ring buffer (reader side).
   * @param {number} count - samples to read
   * @param {Float32Array} [dest] - optional pre-allocated destination
   * @returns {Float32Array|null} null if insufficient data
   */
  pull(count, dest) {
    if (this.available() < count) return null;

    const out = dest || new Float32Array(count);
    let r = Atomics.load(this.control, 1);

    const firstPart = Math.min(count, this.capacity - r);
    out.set(this.data.subarray(r, r + firstPart));
    if (firstPart < count) {
      out.set(this.data.subarray(0, count - firstPart), firstPart);
    }

    // Advance read pointer atomically
    Atomics.store(this.control, 1, (r + count) % this.capacity);
    return out;
  }

  /** Peek at samples without consuming */
  peek(count) {
    if (this.available() < count) return null;
    const out = new Float32Array(count);
    const r = Atomics.load(this.control, 1);
    const firstPart = Math.min(count, this.capacity - r);
    out.set(this.data.subarray(r, r + firstPart));
    if (firstPart < count) {
      out.set(this.data.subarray(0, count - firstPart), firstPart);
    }
    return out;
  }

  /** Reset read/write pointers (not thread-safe — only call during init) */
  reset() {
    Atomics.store(this.control, 0, 0);
    Atomics.store(this.control, 1, 0);
    Atomics.store(this.control, 3, 0);
  }

  /** Get overflow count for diagnostics */
  overflows() {
    return Atomics.load(this.control, 3);
  }

  /** Get the underlying SharedArrayBuffer (for passing to workers) */
  getBuffer() {
    return this.sab;
  }

  /** Check if SharedArrayBuffer is supported */
  static isSupported() {
    return typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined';
  }
}

// Export
if (typeof window !== 'undefined') {
  window.SharedRingBuffer = SharedRingBuffer;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SharedRingBuffer;
}
