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
      if (this.free < 1) {
        return false;
      }

      const tail = Atomics.load(this._ctrl, 1) % this._capacity;
      this._data[tail] = samples;
      Atomics.store(this._ctrl, 1, (Atomics.load(this._ctrl, 1) + 1) % this._capacity);
      return true;
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

  /** Capability probe — true when SharedArrayBuffer and Atomics are available. */
  static isSupported() {
    return typeof SharedArrayBuffer !== 'undefined' && typeof Atomics !== 'undefined';
  }
}

if (typeof window !== 'undefined') window.RingBuffer = RingBuffer;
if (typeof module !== 'undefined' && module.exports) {
  module.exports.RingBuffer = RingBuffer;
}

// ─────────────────────────────────────────────────────────────────────────────
// Blueprint v2.1 — Codified overlap-add constants & quantum bridge
// Canonical ESM copies live in src/core/ring-buffer-constants.js and
// src/core/OverlapAddAccumulator.js (synced to public/src/ for imports).
// ─────────────────────────────────────────────────────────────────────────────

/** @type {128} AudioWorklet render quantum */
const QUANTUM = 128;
/** @type {1024} Live-mode FFT (sub-100 ms latency target) */
const FFT_SIZE_LIVE = 1024;
/** @type {4096} Creator / Forensic FFT */
const FFT_SIZE_CREATOR = 4096;
/** @type {512} Hop size — must be integer multiple of QUANTUM */
const HOP_SIZE = 512;
/** @type {4} Quanta accumulated per hop (HOP_SIZE / QUANTUM) */
const QUANTA_PER_HOP = HOP_SIZE / QUANTUM;

const _hannCache = Object.create(null);
function hannWindow(n) {
  if (_hannCache[n]) return _hannCache[n];
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / n));
  _hannCache[n] = w;
  return w;
}

function validateRingBufferConstants(opts) {
  const quantum = (opts && opts.quantum) || QUANTUM;
  const hopSize = (opts && opts.hopSize) || HOP_SIZE;
  const fftSize = (opts && opts.fftSize) || FFT_SIZE_LIVE;
  if (hopSize % quantum !== 0) {
    throw new RangeError(
      '[VIP][ring-buffer] HOP_SIZE (' + hopSize + ') must be an integer multiple of QUANTUM (' + quantum + ').'
    );
  }
  if ((fftSize & (fftSize - 1)) !== 0) {
    throw new RangeError('[VIP][ring-buffer] fftSize must be a power of two.');
  }
  return { quantum, hopSize, fftSize, quantaPerHop: hopSize / quantum };
}

/**
 * Accumulates exactly QUANTA_PER_HOP AudioWorklet quanta before each hop advance.
 * Use with SharedRingBuffer / RingBuffer for worklet ↔ worker handoff.
 */
class QuantumHopBridge {
  constructor(opts) {
    opts = opts || {};
    const v = validateRingBufferConstants({
      quantum: opts.quantum || QUANTUM,
      hopSize: opts.hopSize || HOP_SIZE,
      fftSize: opts.fftSize || FFT_SIZE_LIVE,
    });
    this.quantum = v.quantum;
    this.hopSize = v.hopSize;
    this.fftSize = v.fftSize;
    this.quantaPerHop = v.quantaPerHop;
    this._ring = new Float32Array(this.fftSize);
    this._writePos = 0;
    this._quantaSinceHop = 0;
    this._hopIndex = 0;
  }

  reset() {
    this._ring.fill(0);
    this._writePos = 0;
    this._quantaSinceHop = 0;
    this._hopIndex = 0;
  }

  pushQuantum(quantumSamples) {
    if (quantumSamples.length !== this.quantum) {
      throw new RangeError('[VIP][OverlapAdd] invalid quantum length.');
    }
    for (let i = 0; i < this.quantum; i++) {
      this._ring[this._writePos] = quantumSamples[i];
      this._writePos = (this._writePos + 1) % this.fftSize;
    }
    this._quantaSinceHop += 1;
    if (this._quantaSinceHop < this.quantaPerHop) return false;
    this._quantaSinceHop = 0;
    this._hopIndex += 1;
    return true;
  }

  getAnalysisWindow(dest) {
    const out = dest && dest.length === this.fftSize ? dest : new Float32Array(this.fftSize);
    const start = this._writePos;
    const tail = this.fftSize - start;
    out.set(this._ring.subarray(start), 0);
    if (start > 0) out.set(this._ring.subarray(0, start), tail);
    return out;
  }

  get hopCount() { return this._hopIndex; }
}

/** Symmetric Hann overlap-add reconstructor with COLA normalization. */
class OverlapAddReconstructor {
  constructor(opts) {
    opts = opts || {};
    const v = validateRingBufferConstants({
      fftSize: opts.fftSize || FFT_SIZE_LIVE,
      hopSize: opts.hopSize || HOP_SIZE,
    });
    this.fftSize = v.fftSize;
    this.hopSize = v.hopSize;
    this.window = hannWindow(this.fftSize);
    this._outputLength = opts.outputLength || (this.hopSize * 8 + this.fftSize);
    this._output = new Float32Array(this._outputLength);
    this._norm = new Float32Array(this._outputLength);
    this._framesAdded = 0;
  }

  reset(outputLength) {
    if (outputLength !== undefined) {
      this._outputLength = outputLength;
      this._output = new Float32Array(outputLength);
      this._norm = new Float32Array(outputLength);
    } else {
      this._output.fill(0);
      this._norm.fill(0);
    }
    this._framesAdded = 0;
  }

  addGrain(grain, frameIndex) {
    if (grain.length !== this.fftSize) {
      throw new RangeError('[VIP][OverlapAdd] grain length mismatch.');
    }
    const start = frameIndex * this.hopSize;
    const win = this.window;
    for (let i = 0; i < this.fftSize; i++) {
      const pos = start + i;
      if (pos >= this._outputLength) break;
      const w = win[i];
      this._output[pos] += grain[i] * w;
      this._norm[pos] += w * w;
    }
    this._framesAdded += 1;
  }

  finalize() {
    const out = new Float32Array(this._outputLength);
    for (let i = 0; i < this._outputLength; i++) {
      out[i] = this._norm[i] > 1e-12 ? this._output[i] / this._norm[i] : 0;
    }
    return out;
  }
}

if (typeof window !== 'undefined') {
  window.QUANTUM = QUANTUM;
  window.FFT_SIZE_LIVE = FFT_SIZE_LIVE;
  window.FFT_SIZE_CREATOR = FFT_SIZE_CREATOR;
  window.HOP_SIZE = HOP_SIZE;
  window.QUANTA_PER_HOP = QUANTA_PER_HOP;
  window.QuantumHopBridge = QuantumHopBridge;
  window.OverlapAddReconstructor = OverlapAddReconstructor;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports.QUANTUM = QUANTUM;
  module.exports.FFT_SIZE_LIVE = FFT_SIZE_LIVE;
  module.exports.FFT_SIZE_CREATOR = FFT_SIZE_CREATOR;
  module.exports.HOP_SIZE = HOP_SIZE;
  module.exports.QUANTA_PER_HOP = QUANTA_PER_HOP;
  module.exports.hannWindow = hannWindow;
  module.exports.validateRingBufferConstants = validateRingBufferConstants;
  module.exports.QuantumHopBridge = QuantumHopBridge;
  module.exports.OverlapAddReconstructor = OverlapAddReconstructor;
}
