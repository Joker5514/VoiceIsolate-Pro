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
 *
 * Data region: Float32Array starting at byte offset 16
 */
class SharedRingBuffer {
  constructor(frameSize, frameCount, existingSAB) {
    this.frameSize = frameSize;
    this.frameCount = frameCount;
    this.capacity = frameSize * frameCount;
    const headerBytes = 16;
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
      Atomics.store(this.control, 0, 0);
      Atomics.store(this.control, 1, 0);
      Atomics.store(this.control, 2, this.capacity);
      Atomics.store(this.control, 3, 0);
    }
  }
  available() {
    const w = Atomics.load(this.control, 0);
    const r = Atomics.load(this.control, 1);
    return (w - r + this.capacity) % this.capacity;
  }
  space() { return this.capacity - 1 - this.available(); }
  push(samples) {
    const len = samples.length;
    if (len > this.space()) { Atomics.add(this.control, 3, 1); return false; }
    let w = Atomics.load(this.control, 0);
    const firstPart = Math.min(len, this.capacity - w);
    this.data.set(samples.subarray(0, firstPart), w);
    if (firstPart < len) this.data.set(samples.subarray(firstPart), 0);
    Atomics.store(this.control, 0, (w + len) % this.capacity);
    return true;
  }
  pull(count, dest) {
    if (this.available() < count) return null;
    const out = dest || new Float32Array(count);
    let r = Atomics.load(this.control, 1);
    const firstPart = Math.min(count, this.capacity - r);
    out.set(this.data.subarray(r, r + firstPart));
    if (firstPart < count) out.set(this.data.subarray(0, count - firstPart), firstPart);
    Atomics.store(this.control, 1, (r + count) % this.capacity);
    return out;
  }
  peek(count) {
    if (this.available() < count) return null;
    const out = new Float32Array(count);
    const r = Atomics.load(this.control, 1);
    const firstPart = Math.min(count, this.capacity - r);
    out.set(this.data.subarray(r, r + firstPart));
    if (firstPart < count) out.set(this.data.subarray(0, count - firstPart), firstPart);
    return out;
  }
  reset() {
    Atomics.store(this.control, 0, 0);
    Atomics.store(this.control, 1, 0);
    Atomics.store(this.control, 3, 0);
  }
  overflows() { return Atomics.load(this.control, 3); }
  getBuffer() { return this.sab; }
  static isSupported() {
    return typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined';
  }
}
if (typeof window !== 'undefined') window.SharedRingBuffer = SharedRingBuffer;
if (typeof module !== 'undefined' && module.exports) module.exports = SharedRingBuffer;
