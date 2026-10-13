/**
 * Streaming 128-bit content hash (MurmurHash3 x86_128 block function).
 *
 * Used for local identity only: stem-cache keys, library de-duplication and
 * durable derived-cache ownership. It is not a security primitive. It replaces
 * word-wise FNV lanes, whose multiply-only mixing never carries a difference
 * downward: flipping the sign bit of any two samples (or inverting the
 * polarity of an even-length channel) left the digest unchanged.
 *
 * Pure: no DOM, no I/O. Same result whatever the chunking of the input.
 */
'use strict';

const C1 = 0x239b961b;
const C2 = 0xab0e9789;
const C3 = 0x38b34ae5;
const C4 = 0xa1e38b93;

function rotl(x, r) {
  return (x << r) | (x >>> (32 - r));
}

function fmix(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h;
}

function hex32(x) {
  return (x >>> 0).toString(16).padStart(8, '0');
}

export class ContentHasher128 {
  /** @param {number} [seed] */
  constructor(seed = 0) {
    this.h1 = seed | 0;
    this.h2 = seed | 0;
    this.h3 = seed | 0;
    this.h4 = seed | 0;
    this.total = 0;
    this._pending = new Uint8Array(16);
    this._pendingView = new DataView(this._pending.buffer);
    this._pendingLen = 0;
  }

  _block(k1, k2, k3, k4) {
    let { h1, h2, h3, h4 } = this;
    k1 = Math.imul(k1, C1); k1 = rotl(k1, 15); k1 = Math.imul(k1, C2); h1 ^= k1;
    h1 = rotl(h1, 19); h1 = (h1 + h2) | 0; h1 = (Math.imul(h1, 5) + 0x561ccd1b) | 0;
    k2 = Math.imul(k2, C2); k2 = rotl(k2, 16); k2 = Math.imul(k2, C3); h2 ^= k2;
    h2 = rotl(h2, 17); h2 = (h2 + h3) | 0; h2 = (Math.imul(h2, 5) + 0x0bcaa747) | 0;
    k3 = Math.imul(k3, C3); k3 = rotl(k3, 17); k3 = Math.imul(k3, C4); h3 ^= k3;
    h3 = rotl(h3, 15); h3 = (h3 + h4) | 0; h3 = (Math.imul(h3, 5) + 0x96cd1c35) | 0;
    k4 = Math.imul(k4, C4); k4 = rotl(k4, 18); k4 = Math.imul(k4, C1); h4 ^= k4;
    h4 = rotl(h4, 13); h4 = (h4 + h1) | 0; h4 = (Math.imul(h4, 5) + 0x32ac3b17) | 0;
    this.h1 = h1; this.h2 = h2; this.h3 = h3; this.h4 = h4;
  }

  /**
   * Absorb bytes. Any ArrayBufferView is read as its raw bytes.
   * @param {ArrayBufferView|ArrayBuffer} data
   * @returns {this}
   */
  update(data) {
    const bytes = data instanceof Uint8Array
      ? data
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
    const n = bytes.length;
    this.total += n;
    let off = 0;
    if (this._pendingLen > 0) {
      const take = Math.min(16 - this._pendingLen, n);
      this._pending.set(bytes.subarray(0, take), this._pendingLen);
      this._pendingLen += take;
      off = take;
      if (this._pendingLen < 16) return this;
      const v = this._pendingView;
      this._block(v.getUint32(0, true), v.getUint32(4, true), v.getUint32(8, true), v.getUint32(12, true));
      this._pendingLen = 0;
    }
    const blocks = (n - off) >>> 4;
    if (blocks > 0) {
      const start = bytes.byteOffset + off;
      if ((start & 3) === 0) {
        // All shipped targets are little-endian, so a Uint32 view reads the
        // same words as DataView#getUint32(…, true) at a fraction of the cost.
        const w = new Uint32Array(bytes.buffer, start, blocks * 4);
        for (let i = 0; i < w.length; i += 4) this._block(w[i], w[i + 1], w[i + 2], w[i + 3]);
      } else {
        const dv = new DataView(bytes.buffer, start, blocks * 16);
        for (let i = 0; i < blocks * 16; i += 16) {
          this._block(dv.getUint32(i, true), dv.getUint32(i + 4, true), dv.getUint32(i + 8, true), dv.getUint32(i + 12, true));
        }
      }
      off += blocks * 16;
    }
    if (off < n) {
      this._pending.set(bytes.subarray(off), 0);
      this._pendingLen = n - off;
    }
    return this;
  }

  /**
   * Absorb unsigned 32-bit integers (lengths, counts) as little-endian words.
   * @param {...number} values
   */
  updateU32(...values) {
    const words = new Uint32Array(values.length);
    for (let i = 0; i < values.length; i++) words[i] = values[i] >>> 0;
    return this.update(words);
  }

  /** @returns {string} 32 lowercase hex characters. Does not reset state. */
  digestHex() {
    let { h1, h2, h3, h4 } = this;
    const len = this._pendingLen;
    if (len > 0) {
      const t = new Uint8Array(16);
      t.set(this._pending.subarray(0, len));
      const v = new DataView(t.buffer);
      let k1 = v.getUint32(0, true);
      let k2 = v.getUint32(4, true);
      let k3 = v.getUint32(8, true);
      let k4 = v.getUint32(12, true);
      if (len > 12) { k4 = Math.imul(k4, C4); k4 = rotl(k4, 18); k4 = Math.imul(k4, C1); h4 ^= k4; }
      if (len > 8) { k3 = Math.imul(k3, C3); k3 = rotl(k3, 17); k3 = Math.imul(k3, C4); h3 ^= k3; }
      if (len > 4) { k2 = Math.imul(k2, C2); k2 = rotl(k2, 16); k2 = Math.imul(k2, C3); h2 ^= k2; }
      k1 = Math.imul(k1, C1); k1 = rotl(k1, 15); k1 = Math.imul(k1, C2); h1 ^= k1;
    }
    // Byte length mod 2^32 as in the reference, plus the high word so inputs
    // longer than 4 GiB still differ by length.
    const lo = this.total >>> 0;
    const hi = Math.floor(this.total / 0x100000000) >>> 0;
    h1 ^= lo; h2 ^= lo ^ hi; h3 ^= lo; h4 ^= lo;
    h1 = (h1 + h2 + h3 + h4) | 0;
    h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
    h1 = fmix(h1); h2 = fmix(h2); h3 = fmix(h3); h4 = fmix(h4);
    h1 = (h1 + h2 + h3 + h4) | 0;
    h2 = (h2 + h1) | 0; h3 = (h3 + h1) | 0; h4 = (h4 + h1) | 0;
    return hex32(h1) + hex32(h2) + hex32(h3) + hex32(h4);
  }
}

/**
 * One-shot hash of a string (UTF-16 code units) — for short identity labels.
 * @param {string} text
 */
export function hashString128(text) {
  const s = String(text);
  const units = new Uint16Array(s.length);
  for (let i = 0; i < s.length; i++) units[i] = s.charCodeAt(i);
  return new ContentHasher128().updateU32(s.length).update(units).digestHex();
}

/** Bytes hashed per slice by the PCM helpers (~1 MiB). */
const SLICE_SAMPLES = 1 << 18;

function absorbChannelHeader(hasher, channels, c) {
  // Channel index and length precede each channel's samples so layouts that
  // concatenate to the same bytes (or swap channels) never alias.
  hasher.updateU32(0x5643484e, c, channels.length, channels[c].length);
}

/**
 * Hash every sample bit pattern of every channel.
 * @param {Float32Array[]} channels
 * @returns {string}
 */
export function hashPcmChannels(channels) {
  const hasher = new ContentHasher128();
  for (let c = 0; c < channels.length; c++) {
    absorbChannelHeader(hasher, channels, c);
    hasher.update(channels[c]);
  }
  return hasher.digestHex();
}

/**
 * {@link hashPcmChannels} with `maybeYield()` between ~1 MiB slices; identical
 * result. `maybeYield` may throw (AbortError) to cancel.
 * @param {Float32Array[]} channels
 * @param {() => Promise<void>} maybeYield
 * @returns {Promise<string>}
 */
export async function hashPcmChannelsAsync(channels, maybeYield) {
  const hasher = new ContentHasher128();
  for (let c = 0; c < channels.length; c++) {
    absorbChannelHeader(hasher, channels, c);
    const ch = channels[c];
    for (let start = 0; start < ch.length; start += SLICE_SAMPLES) {
      hasher.update(ch.subarray(start, Math.min(ch.length, start + SLICE_SAMPLES)));
      await maybeYield();
    }
  }
  return hasher.digestHex();
}

export default { ContentHasher128, hashString128, hashPcmChannels, hashPcmChannelsAsync };
