/* ============================================
   VoiceIsolate Pro v22.1 — SharedRingBuffer
   Threads from Space v11 · Zero-Copy Transfer
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
 *   [4] frameReady    (Atomics) ← dedicated worklet↔worker handshake signal
 *                                 Set to 1 by writer after push(), cleared to 0
 *                                 by reader after pull(). Use Atomics.wait/notify
 *                                 on this index — NOT on index 2 (capacity).
 *
 * Data region: Float32Array starting at byte offset 20  (was 16 — 4 bytes added
 *              for the new frameReady slot; all consumers must use this offset.)
 */
class SharedRingBuffer {
  constructor(frameSize, frameCount, existingSAB) {
    this.frameSize = frameSize;
    this.frameCount = frameCount;
    this.capacity = frameSize * frameCount;

    // 5 Int32 slots × 4 bytes = 20-byte header (was 16)
    const headerBytes = 20;
    const dataBytes = this.capacity * Float32Array.BYTES_PER_ELEMENT;
    const totalBytes = headerBytes + dataBytes;

    if (existingSAB) {
      this.sab = existingSAB;
    } else {
      this.sab = new SharedArrayBuffer(totalBytes);
    }

    // 5-slot control view
    this.control = new Int32Array(this.sab, 0, 5);
    // Data region now at byte offset 20
    this.data = new Float32Array(this.sab, headerBytes, this.capacity);

    if (!existingSAB) {
      Atomics.store(this.control, 0, 0); // writePointer
      Atomics.store(this.control, 1, 0); // readPointer
      Atomics.store(this.control, 2, this.capacity); // capacity (immutable)
      Atomics.store(this.control, 3, 0); // overflowCount
      Atomics.store(this.control, 4, 0); // frameReady (initially idle)
    }
  }

  available() {
    const w = Atomics.load(this.control, 0) % this.capacity;
    const r = Atomics.load(this.control, 1) % this.capacity;
    return (w - r + this.capacity) % this.capacity;
  }

  space() { return this.capacity - 1 - this.available(); }

  push(samples) {
    const len = samples.length;
    if (len > this.space()) { Atomics.add(this.control, 3, 1); return false; }
    let w = Atomics.load(this.control, 0) % this.capacity;
    const firstPart = Math.min(len, this.capacity - w);
    this.data.set(samples.subarray(0, firstPart), w);
    if (firstPart < len) this.data.set(samples.subarray(firstPart), 0);
    Atomics.store(this.control, 0, (w + len) % this.capacity);
    // Signal reader that a frame is available (slot [4] = frameReady)
    Atomics.store(this.control, 4, 1);
    Atomics.notify(this.control, 4, 1);
    return true;
  }

  pull(count, dest) {
    if (this.available() < count) return null;
    const out = dest || new Float32Array(count);
    let r = Atomics.load(this.control, 1) % this.capacity;
    const firstPart = Math.min(count, this.capacity - r);
    out.set(this.data.subarray(r, r + firstPart));
    if (firstPart < count) out.set(this.data.subarray(0, count - firstPart), firstPart);
    Atomics.store(this.control, 1, (r + count) % this.capacity);
    // Clear frameReady after consuming
    Atomics.store(this.control, 4, 0);
    return out;
  }

  peek(count) {
    if (this.available() < count) return null;
    const out = new Float32Array(count);
    const r = Atomics.load(this.control, 1) % this.capacity;
    const firstPart = Math.min(count, this.capacity - r);
    out.set(this.data.subarray(r, r + firstPart));
    if (firstPart < count) out.set(this.data.subarray(0, count - firstPart), firstPart);
    return out;
  }

  /**
   * Block the calling thread (Worker only — NOT safe in AudioWorklet) until
   * frameReady [4] becomes 1, or timeout (ms) elapses.
   * Returns 'ok' | 'timed-out' | 'not-equal'
   */
  waitForFrame(timeoutMs = 500) {
    return Atomics.wait(this.control, 4, 0, timeoutMs);
  }

  reset() {
    Atomics.store(this.control, 0, 0);
    Atomics.store(this.control, 1, 0);
    Atomics.store(this.control, 3, 0);
    Atomics.store(this.control, 4, 0);
  }

  overflows() { return Atomics.load(this.control, 3); }
  getBuffer() { return this.sab; }

  static isSupported() {
    return typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined';
  }
}

if (typeof window !== 'undefined') window.SharedRingBuffer = SharedRingBuffer;
if (typeof module !== 'undefined' && module.exports) module.exports = SharedRingBuffer;
