/**
 * VoiceIsolate Pro — Float32Array Buffer Pool (Layer 1: Core)
 *
 * Pre-allocates fixed-size Float32Array scratch buffers so DSP hot paths
 * never allocate during processing — eliminating V8 garbage-collection
 * pauses that previously caused audible clipping.
 *
 * Usage:
 *   const pool = new BufferPool();
 *   const frame = pool.acquire(2048);
 *   try { ... } finally { pool.release(frame); }
 *
 * Pure module: no DOM, no Web Audio, no I/O.
 */
'use strict';

import { POOL_BUFFER_SIZES } from './audio-config.js';

/** Buffers pre-allocated per size class at construction. */
const DEFAULT_PREALLOCATE = 8;

/** Hard cap of retained buffers per size class (excess releases are dropped). */
const DEFAULT_MAX_PER_SIZE = 32;

export class BufferPool {
  /**
   * @param {object} [options]
   * @param {number[]} [options.sizes]        size classes to manage
   * @param {number}   [options.preallocate]  buffers per class up front
   * @param {number}   [options.maxPerSize]   retention cap per class
   */
  constructor(options = {}) {
    const {
      sizes = POOL_BUFFER_SIZES,
      preallocate = DEFAULT_PREALLOCATE,
      maxPerSize = DEFAULT_MAX_PER_SIZE,
    } = options;

    if (!Array.isArray(sizes) || sizes.length === 0 ||
        sizes.some((s) => !Number.isInteger(s) || s <= 0)) {
      throw new RangeError('[VIP][BufferPool] sizes must be positive integers.');
    }

    this._maxPerSize = maxPerSize;
    /** @type {Map<number, Float32Array[]>} free lists keyed by size */
    this._free = new Map();
    /** @type {WeakSet<Float32Array>} guards against double-release */
    this._loaned = new WeakSet();
    this._stats = { acquired: 0, released: 0, misses: 0, dropped: 0 };

    for (const size of sizes) {
      const list = [];
      for (let i = 0; i < preallocate; i++) list.push(new Float32Array(size));
      this._free.set(size, list);
    }
  }

  /**
   * Acquire a zeroed Float32Array of exactly `size` samples.
   * Sizes outside the managed classes are allocated fresh (counted as misses)
   * and adopted into the pool on release.
   *
   * @param {number} size
   * @returns {Float32Array}
   */
  acquire(size) {
    if (!Number.isInteger(size) || size <= 0) {
      throw new RangeError(`[VIP][BufferPool] invalid acquire size: ${size}`);
    }
    this._stats.acquired++;

    const list = this._free.get(size);
    let buf;
    if (list && list.length > 0) {
      buf = list.pop();
    } else {
      this._stats.misses++;
      buf = new Float32Array(size);
      if (!this._free.has(size)) this._free.set(size, []);
    }
    this._loaned.add(buf);
    return buf;
  }

  /**
   * Return a buffer to the pool. The buffer is zero-filled so the next
   * acquirer always starts clean. Double-releases and foreign buffers are
   * ignored safely.
   *
   * @param {Float32Array} buf
   */
  release(buf) {
    if (!(buf instanceof Float32Array) || !this._loaned.has(buf)) return;
    this._loaned.delete(buf);
    this._stats.released++;

    const list = this._free.get(buf.length);
    if (!list || list.length >= this._maxPerSize) {
      this._stats.dropped++;
      return;
    }
    buf.fill(0);
    list.push(buf);
  }

  /**
   * Snapshot of pool health for diagnostics.
   * @returns {{ acquired: number, released: number, misses: number,
   *             dropped: number, free: Record<number, number> }}
   */
  stats() {
    const free = {};
    for (const [size, list] of this._free) free[size] = list.length;
    return { ...this._stats, free };
  }
}

/** Shared default pool for pipeline modules. */
export const defaultPool = new BufferPool();

export default BufferPool;
