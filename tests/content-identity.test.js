/**
 * F01 — audio identity. Each case is a pair of inputs that the previous sparse
 * or multiply-only digests mapped to one key (reproduced at 0b020cc), and which
 * must now differ, plus the invariants the caches rely on.
 */
'use strict';

let hash;
let cache;
let manifest;
let cacheManifest;
let derived;

beforeAll(async () => {
  hash = await import('../src/core/content-hash.js');
  cache = await import('../src/pipeline/MLStemCache.js');
  manifest = await import('../src/core/ModelManifest.js');
  cacheManifest = await import('../src/core/storage/CacheManifest.js');
  derived = await import('../src/core/storage/DerivedCache.js');
});

function tone(n, f = 0.05, amp = 0.5) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin(i * f) * amp;
  return a;
}

describe('ContentHasher128', () => {
  test('matches the published MurmurHash3 x86_128 vectors', () => {
    const enc = new TextEncoder();
    const h = (s) => new hash.ContentHasher128().update(enc.encode(s)).digestHex();
    expect(h('')).toBe('00000000000000000000000000000000');
    expect(h('The quick brown fox jumps over the lazy dog')).toBe('2f1583c3ecee2c675d7bf66ce5e91d2c');
  });

  test('result is independent of chunking and byte alignment', () => {
    const bytes = new Uint8Array(1031);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 131 + 7) & 255;
    const whole = new hash.ContentHasher128().update(bytes).digestHex();
    for (const step of [1, 3, 5, 16, 17, 100]) {
      const h = new hash.ContentHasher128();
      for (let i = 0; i < bytes.length; i += step) h.update(bytes.subarray(i, i + step));
      expect(h.digestHex()).toBe(whole);
    }
    // Unaligned view of the same bytes inside a larger buffer.
    const padded = new Uint8Array(bytes.length + 1);
    padded.set(bytes, 1);
    expect(new hash.ContentHasher128().update(padded.subarray(1)).digestHex()).toBe(whole);
  });

  test('async PCM digest equals the sync one, and an abort stops it', async () => {
    const ch = [tone(600_000), tone(600_000, 0.03)];
    const sync = hash.hashPcmChannels(ch);
    expect(await hash.hashPcmChannelsAsync(ch, async () => {})).toBe(sync);
    let calls = 0;
    await expect(hash.hashPcmChannelsAsync(ch, async () => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error('cancel'), { name: 'AbortError' });
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(2);
  });
});

describe('stemCacheKey identity (sk3)', () => {
  beforeEach(() => cache.clearStemCache());
  const key = (channels, ids = ['bsrnn_vocals']) => cache.stemCacheKey(channels, 48000, ids, 'same-name.wav');

  test('polarity-inverted audio does not share a key', () => {
    const a = tone(48_000);
    const inv = a.map((v) => -v);
    expect(key([a])).not.toBe(key([inv]));
  });

  test('two sign flips do not cancel', () => {
    const a = tone(48_000);
    const b = new Float32Array(a);
    b[100] = -b[100];
    b[2000] = -b[2000];
    expect(key([a])).not.toBe(key([b]));
  });

  test('right-channel-only change and channel swap change the key', () => {
    const l = tone(20_000);
    const r = tone(20_000, 0.07);
    const r2 = new Float32Array(r);
    r2[19_999] += 1e-3;
    expect(key([l, r])).not.toBe(key([l, r2]));
    expect(key([l, r])).not.toBe(key([r, l]));
  });

  test('every sample position is covered (single-ulp edits)', () => {
    const base = tone(4_097);
    const k0 = key([base]);
    for (const i of [0, 1, 2, 3, 4, 2048, 4095, 4096]) {
      const e = new Float32Array(base);
      const u = new Uint32Array(e.buffer);
      u[i] ^= 1;
      expect(key([e])).not.toBe(k0);
    }
  });

  test('model bytes and inference revision are part of the key', () => {
    const ch = [tone(1_000)];
    expect(key(ch)).toContain(manifest.modelChainRevision(['bsrnn_vocals']));
    expect(manifest.modelChainRevision(['bsrnn_vocals'])).toMatch(new RegExp(`^${manifest.INFERENCE_REVISION}-`));
    expect(manifest.modelChainRevision(['bsrnn_vocals']))
      .not.toBe(manifest.modelChainRevision(['bsrnn_vocals', 'rnnoise']));
    expect(derived.stemDurableKey('f', ['bsrnn_vocals'])).toContain(manifest.modelChainRevision(['bsrnn_vocals']));
  });

  test('async key equals sync key; aborted hashing stores no memo', async () => {
    const ch = [tone(700_000)];
    const before = cache.getDigestComputationCount();
    const ac = new AbortController();
    ac.abort();
    await expect(cache.stemCacheKeyAsync(ch, 48000, ['bsrnn_vocals'], '', '', { signal: ac.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(cache.getDigestComputationCount()).toBe(before);
    const asyncKey = await cache.stemCacheKeyAsync(ch, 48000, ['bsrnn_vocals'], '', '', { maybeYield: async () => {} });
    expect(asyncKey).toBe(cache.stemCacheKey(ch, 48000, ['bsrnn_vocals']));
    expect(cache.getDigestComputationCount()).toBe(before + 1);
  });

  test('the cache owns its arrays: later writes to the source never reach it', () => {
    const ch = [tone(256)];
    const k = key(ch);
    const clean = new Float32Array(256).fill(0.25);
    cache.setCachedStems(k, { clean: [clean], noise: [new Float32Array(256)], sampleRate: 48000 });
    clean.fill(0.9);
    expect(cache.getCachedStems(k).clean[0][0]).toBe(0.25);
  });
});

describe('contentFingerprint (file identity)', () => {
  function file(bytes, name = 'take.wav') {
    return new File([bytes], name, { type: 'audio/wav' });
  }
  const base = () => {
    const u = new Uint8Array(1 << 20);
    for (let i = 0; i < u.length; i++) u[i] = (i * 31) & 255;
    return u;
  };

  test('same name and size, different middle byte → different fingerprint', async () => {
    const a = base();
    const b = base();
    b[b.length >> 1] ^= 0xff;
    expect(await cacheManifest.contentFingerprint(file(a))).not.toBe(await cacheManifest.contentFingerprint(file(b)));
  });

  test('a head byte off the old sampling stride changes the fingerprint', async () => {
    const a = base();
    const b = base();
    b[1] ^= 0xff;
    expect(await cacheManifest.contentFingerprint(file(a))).not.toBe(await cacheManifest.contentFingerprint(file(b)));
  });

  test('identical bytes under another name share an identity', async () => {
    const a = base();
    expect(await cacheManifest.contentFingerprint(file(a, 'one.wav')))
      .toBe(await cacheManifest.contentFingerprint(file(a.slice(), 'two.wav')));
  });

  test('spans multiple 4 MiB read chunks and honours abort', async () => {
    const big = new Uint8Array(9 * 1024 * 1024 + 5);
    big[big.length - 1] = 1;
    const fp = await cacheManifest.contentFingerprint(file(big));
    expect(fp).toMatch(/^c128_[0-9a-f]{32}_/);
    const big2 = big.slice();
    big2[5 * 1024 * 1024] = 9;
    expect(await cacheManifest.contentFingerprint(file(big2))).not.toBe(fp);
    const ac = new AbortController();
    ac.abort();
    await expect(cacheManifest.contentFingerprint(file(big), { signal: ac.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});
