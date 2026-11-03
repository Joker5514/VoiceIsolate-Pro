/**
 * tests/source-hash.test.js — VIP-011 source SHA-256 (streaming, cross-checked
 * against Node's authoritative crypto) + verification semantics.
 */
'use strict';

const crypto = require('crypto');

let sha;

beforeAll(async () => {
  sha = await import('../src/core/sha256.js');
});

function refHex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

describe('streaming SHA-256 core', () => {
  test('FIPS/NIST vectors and edge buffer lengths match Node crypto', () => {
    const cases = [
      new Uint8Array(0),
      new TextEncoder().encode('abc'),
      new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
      new Uint8Array(55).fill(0x61),
      new Uint8Array(56).fill(0x62),
      new Uint8Array(63).fill(0x63),
      new Uint8Array(64).fill(0x64),
      new Uint8Array(65).fill(0x65),
      new Uint8Array(1_000_003).map((_, i) => (i * 131) & 0xff),
    ];
    for (const data of cases) {
      expect(sha.sha256Hex(data)).toBe(refHex(data));
    }
  });

  test('chunked updates equal a one-shot digest (any chunking)', () => {
    const data = new Uint8Array(3_000_003).map((_, i) => (i * 31) & 0xff);
    for (const step of [1, 3, 63, 64, 65, 7777, 1 << 20]) {
      const h = new sha.Sha256();
      for (let i = 0; i < data.length; i += step) h.update(data.subarray(i, Math.min(i + step, data.length)));
      expect(h.digestHex()).toBe(refHex(data));
    }
  });

  test('update after digest is refused (no accidental reuse)', () => {
    const h = new sha.Sha256();
    h.update(new Uint8Array([1]));
    h.digestHex();
    expect(() => h.update(new Uint8Array([2]))).toThrow(/already called/);
  });
});

describe('hashBlobSha256 (streaming over a Blob)', () => {
  test('matches Node crypto on a multi-chunk blob', async () => {
    const data = new Uint8Array(2_000_000).map((_, i) => (i * 7) & 0xff);
    const { hex, bytes } = await sha.hashBlobSha256(new Blob([data]), { chunkBytes: 4096 });
    expect(hex).toBe(refHex(data));
    expect(bytes).toBe(data.length);
  });

  test('reports monotonic progress and reaches 100%', async () => {
    const data = new Uint8Array(300_000);
    const seen = [];
    await sha.hashBlobSha256(new Blob([data]), {
      chunkBytes: 64 * 1024,
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen.length).toBeGreaterThan(1);
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBeGreaterThan(seen[i - 1][0]);
    expect(seen[seen.length - 1][0]).toBe(seen[seen.length - 1][1]);
  });

  test('cancellation rejects with AbortError', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sha.hashBlobSha256(new Blob([new Uint8Array(10)]), { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  test('empty blob hashes to the empty-string digest', async () => {
    const { hex } = await sha.hashBlobSha256(new Blob([]));
    expect(hex).toBe(refHex(Buffer.alloc(0)));
  });
});

describe('verifyBlobSha256 (verification action)', () => {
  const data = new Uint8Array([1, 2, 3, 4, 5]);

  test('a changed file produces a different digest — mismatch is reported', async () => {
    const original = sha.sha256Hex(data);
    const changed = new Uint8Array([1, 2, 3, 4, 6]);
    const r1 = await sha.verifyBlobSha256(new Blob([data]), original);
    expect(r1.ok).toBe(true);
    expect(r1.actual).toBe(original);
    const r2 = await sha.verifyBlobSha256(new Blob([changed]), original);
    expect(r2.ok).toBe(false);
    expect(r2.actual).not.toBe(r2.expected);
  });

  test('invalid expected digests fail clearly', async () => {
    const r = await sha.verifyBlobSha256(new Blob([data]), 'not-a-hash');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid expected digest/);
    const r2 = await sha.verifyBlobSha256(new Blob([data]), null);
    expect(r2.ok).toBe(false);
  });

  test('cancellation is reported as a verification error, not a mismatch', async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await sha.verifyBlobSha256(new Blob([data]), sha.sha256Hex(data), { signal: controller.signal });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cancelled/i);
  });
});

describe('hashSourceBlob host (VIP-011)', () => {
  test('falls back to the main-thread streaming path when no Worker exists (Node)', async () => {
    const host = await import('../src/pipeline/SourceHash.js');
    const data = new Uint8Array(100_000).map((_, i) => i & 0xff);
    const { hex, via } = await host.hashSourceBlob(new Blob([data]));
    expect(via).toBe('main');
    expect(hex).toBe(refHex(data));
  });

  test('cancellation rejects with an AbortError-named error', async () => {
    const host = await import('../src/pipeline/SourceHash.js');
    const controller = new AbortController();
    controller.abort();
    await expect(host.hashSourceBlob(new Blob([new Uint8Array(8)]), { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  test('the worker module exists and registers the hash handler', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'src', 'workers', 'SourceHashWorker.js'), 'utf8');
    expect(src).toMatch(/hashBlobSha256/);
    expect(src).toMatch(/self\.onmessage/);
  });
});
