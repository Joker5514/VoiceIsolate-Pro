/**
 * VoiceIsolate Pro — streaming SHA-256 (Layer 1: Core)
 *
 * VIP-011 / VIP-010 (IMPLEMENTATION_READINESS_AUDIT_2026-11-02): security-grade
 * source digests for the forensic integrity record. The cache identity
 * (content-hash.js, MurmurHash3-128) is explicitly NOT a security hash; this
 * module is the real thing.
 *
 * Why not crypto.subtle only: SubtleCrypto digests one contiguous buffer, so a
 * large source file would need one full-size allocation up front. This
 * implementation is incremental (FIPS 180-4) and chunk-friendly; callers with
 * small buffers can still prefer `crypto.subtle.digest` for speed. Cross-checks
 * against Node's crypto and SubtleCrypto are pinned in tests/source-hash.test.js.
 *
 * Pure module: no DOM, no I/O, no side effects. Works in Node, workers, and
 * the browser.
 */
'use strict';

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/** Incremental SHA-256 (FIPS 180-4). Absorb any number of chunks, then digest. */
export class Sha256 {
  constructor() {
    this.h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    this.buffer = new Uint8Array(64);
    this.bufferLen = 0;
    this.totalBytes = 0;
    this._w = new Uint32Array(64);
    this._finished = false;
  }

  _compress(block, offset) {
    const w = this._w;
    const h = this.h;
    for (let i = 0; i < 16; i++) {
      const o = offset + i * 4;
      w[i] = ((block[o] << 24) | (block[o + 1] << 16) | (block[o + 2] << 8) | block[o + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  /** @param {ArrayBufferView|Uint8Array} data */
  update(data) {
    if (this._finished) throw new Error('[VIP][sha256] digest() already called');
    const bytes = data instanceof Uint8Array
      ? data
      : ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
    this.totalBytes += bytes.length;
    let off = 0;
    if (this.bufferLen > 0) {
      const take = Math.min(64 - this.bufferLen, bytes.length);
      this.buffer.set(bytes.subarray(0, take), this.bufferLen);
      this.bufferLen += take;
      off = take;
      if (this.bufferLen === 64) {
        this._compress(this.buffer, 0);
        this.bufferLen = 0;
      }
    }
    while (off + 64 <= bytes.length) {
      this._compress(bytes, off);
      off += 64;
    }
    if (off < bytes.length) {
      this.buffer.set(bytes.subarray(off), 0);
      this.bufferLen = bytes.length - off;
    }
    return this;
  }

  /** @returns {string} lowercase hex digest (64 chars) */
  digestHex() {
    if (!this._finished) {
      const bitLenHi = Math.floor(this.totalBytes / 0x20000000); // (totalBytes * 8) >> 32
      const bitLenLo = (this.totalBytes << 3) >>> 0;
      const pad = new Uint8Array(this.bufferLen < 56 ? 64 : 128);
      pad.set(this.buffer.subarray(0, this.bufferLen), 0);
      pad[this.bufferLen] = 0x80;
      const end = pad.length;
      pad[end - 8] = (bitLenHi >>> 24) & 0xff;
      pad[end - 7] = (bitLenHi >>> 16) & 0xff;
      pad[end - 6] = (bitLenHi >>> 8) & 0xff;
      pad[end - 5] = bitLenHi & 0xff;
      pad[end - 4] = (bitLenLo >>> 24) & 0xff;
      pad[end - 3] = (bitLenLo >>> 16) & 0xff;
      pad[end - 2] = (bitLenLo >>> 8) & 0xff;
      pad[end - 1] = bitLenLo & 0xff;
      for (let i = 0; i < pad.length; i += 64) this._compress(pad, i);
      this._finished = true;
    }
    let hex = '';
    for (let i = 0; i < 8; i++) hex += this.h[i].toString(16).padStart(8, '0');
    return hex;
  }
}

/** One-shot helper. @returns {string} lowercase hex */
export function sha256Hex(data) {
  return new Sha256().update(data).digestHex();
}

/**
 * Stream a Blob through SHA-256 with progress and cancellation.
 * Reads `chunkBytes` slices so peak memory stays flat for large files.
 *
 * @param {Blob} blob
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {(doneBytes: number, totalBytes: number) => void} [opts.onProgress]
 * @param {number} [opts.chunkBytes]
 * @param {() => Promise<void>|void} [opts.maybeYield] cooperative yield per chunk
 * @returns {Promise<{hex: string, bytes: number}>}
 */
export async function hashBlobSha256(blob, opts = {}) {
  const { signal = null, onProgress = null, chunkBytes = 4 * 1024 * 1024, maybeYield = null } = opts;
  const size = Number(blob?.size || 0);
  const hasher = new Sha256();
  let done = 0;
  while (done < size) {
    if (signal?.aborted) {
      const err = typeof DOMException === 'function'
        ? new DOMException('Hashing cancelled', 'AbortError')
        : Object.assign(new Error('Hashing cancelled'), { name: 'AbortError' });
      throw err;
    }
    const take = Math.min(chunkBytes, size - done);
    const buf = await blob.slice(done, done + take).arrayBuffer();
    hasher.update(new Uint8Array(buf));
    done += take;
    if (onProgress) {
      try { onProgress(done, size); } catch { /* progress is advisory */ }
    }
    if (maybeYield) await maybeYield();
  }
  return { hex: hasher.digestHex(), bytes: size };
}

/**
 * Verification helper for the forensic flow: recompute and compare.
 * @returns {Promise<{ok: boolean, expected: string, actual: string, error?: string}>}
 */
export async function verifyBlobSha256(blob, expectedHex, opts = {}) {
  const expected = String(expectedHex || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return { ok: false, expected, actual: '', error: 'invalid expected digest' };
  }
  try {
    const { hex } = await hashBlobSha256(blob, opts);
    return { ok: hex === expected, expected, actual: hex };
  } catch (err) {
    return { ok: false, expected, actual: '', error: err?.message || String(err) };
  }
}

export default { Sha256, sha256Hex, hashBlobSha256, verifyBlobSha256 };
