/* ============================================
   VoiceIsolate Pro v24.0 — SharedRingBuffer
   Threads from Space v13 · Zero-Copy Transfer
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

// ─────────────────────────────────────────────────────────────────────────────
// RingBuffer — simple lock-free FIFO backed by SharedArrayBuffer.
//
// Memory layout (Int32Array control header):
//   [0] head  — next read position  (Atomics)
//   [1] tail  — next write position (Atomics)
//   [2] capacity — immutable after construction
//
// Float32 data starts at byte offset 12 (3 × 4 bytes).
//
// constructor(sab, capacity)
//   sab      — SharedArrayBuffer, must be >= 12 + capacity*4 bytes
//   capacity — number of float32 samples the buffer can hold
// ─────────────────────────────────────────────────────────────────────────────
class RingBuffer {
  constructor(sab, capacity) {
    if (!(sab instanceof SharedArrayBuffer)) {
      throw new TypeError('RingBuffer: sab must be a SharedArrayBuffer');
    }
    this._capacity = capacity;
    const headerBytes = Int32Array.BYTES_PER_ELEMENT * 3; // 12 bytes
    this._ctrl = new Int32Array(sab, 0, 3);
    this._data = new Float32Array(sab, headerBytes, capacity);

    // Initialise control block only when called as primary constructor
    // (detect by checking if capacity slot is already set)
    if (Atomics.load(this._ctrl, 2) !== capacity) {
      Atomics.store(this._ctrl, 0, 0);          // head
      Atomics.store(this._ctrl, 1, 0);          // tail
      Atomics.store(this._ctrl, 2, capacity);   // capacity (immutable)
    }
  }

  /** Number of samples waiting to be read. */
  get available() {
    const head = Atomics.load(this._ctrl, 0);
    const tail = Atomics.load(this._ctrl, 1);
    return (tail - head + this._capacity) % this._capacity;
  }

  /** Number of samples that can still be written before overflow. */
  get free() {
    return this._capacity - 1 - this.available;
  }

  /**
   * Non-blocking write. Returns false (and discards) if not enough space.
   * @param {Float32Array} float32Array
   * @returns {boolean}
   */
  write(float32Array) {
    const len = float32Array.length;
    if (len > this.free) return false;

    let tail = Atomics.load(this._ctrl, 1) % this._capacity;
    const firstPart = Math.min(len, this._capacity - tail);
    this._data.set(float32Array.subarray(0, firstPart), tail);
    if (firstPart < len) {
      this._data.set(float32Array.subarray(firstPart), 0);
    }
    Atomics.store(this._ctrl, 1, (Atomics.load(this._ctrl, 1) + len) % this._capacity);
    return true;
  }

  /**
   * Non-blocking read into dest. Returns false if not enough data available.
   * @param {Float32Array} dest — will be filled with read samples
   * @returns {boolean}
   */
  read(dest) {
    const len = dest.length;
    if (len > this.available) return false;

    let head = Atomics.load(this._ctrl, 0) % this._capacity;
    const firstPart = Math.min(len, this._capacity - head);
    dest.set(this._data.subarray(head, head + firstPart));
    if (firstPart < len) {
      dest.set(this._data.subarray(0, len - firstPart), firstPart);
    }
    Atomics.store(this._ctrl, 0, (Atomics.load(this._ctrl, 0) + len) % this._capacity);
    return true;
  }

  /**
   * push() — alias of write(). Accepts a Float32Array (or single number for
   * convenience). Returns true on success, false on overflow. Provided so the
   * RingBuffer surface matches the spec used by AudioWorklet ↔ ML-worker glue.
   */
  push(samples) {
    if (typeof samples === 'number') {
      const tmp = new Float32Array(1);
      tmp[0] = samples;
      return this.write(tmp);
    }
    return this.write(samples);
  }

  /**
   * pop(count?) — reads `count` samples (default 1) and returns them as a new
   * Float32Array. Returns null if not enough samples are available. When count
   * is omitted and only one sample is wanted, returns a scalar number for
   * convenience.
   */
  pop(count) {
    if (count === undefined) {
      if (this.available < 1) return null;
      const tmp = new Float32Array(1);
      this.read(tmp);
      return tmp[0];
    }
    if (count < 0 || count > this.available) return null;
    const out = new Float32Array(count);
    return this.read(out) ? out : null;
  }

  /** Number of samples that fit in the buffer (immutable). */
  get capacity() { return this._capacity; }

  /**
   * SharedArrayBuffer accessor — the same SAB can be transferred to an
   * AudioWorklet or Worker, where another RingBuffer can be reattached to it.
   */
  get sab() { return this._ctrl.buffer; }

  /** Reset head/tail pointers. */
  reset() {
    Atomics.store(this._ctrl, 0, 0);
    Atomics.store(this._ctrl, 1, 0);
  }

  /** Minimum SharedArrayBuffer size in bytes for given capacity. */
  static byteLength(capacity) {
    return Int32Array.BYTES_PER_ELEMENT * 3 + Float32Array.BYTES_PER_ELEMENT * capacity;
  }

  /** Capability probe — true when SAB + Atomics + cross-origin isolated. */
  static isSupported() {
    return typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined';
  }
}

if (typeof window !== 'undefined') window.RingBuffer = RingBuffer;
if (typeof module !== 'undefined' && module.exports) {
  module.exports.RingBuffer = RingBuffer;
}
