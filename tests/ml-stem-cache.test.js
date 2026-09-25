'use strict';

let clearStemCache;
let getCachedStems;
let getStemCacheSize;
let setCachedStems;
let stemCacheKey;

beforeAll(async () => {
  const mod = await import('../src/pipeline/MLStemCache.js');
  clearStemCache = mod.clearStemCache;
  getCachedStems = mod.getCachedStems;
  getStemCacheSize = mod.getStemCacheSize;
  setCachedStems = mod.setCachedStems;
  stemCacheKey = mod.stemCacheKey;
});

describe('MLStemCache', () => {
  beforeEach(() => clearStemCache());

  test('stemCacheKey is stable for the same audio + models', () => {
    const ch = [new Float32Array([0.1, 0.2, 0.3, 0.4])];
    const a = stemCacheKey(ch, 48000, ['bsrnn_vocals'], 'clip.wav');
    const b = stemCacheKey(ch, 48000, ['bsrnn_vocals'], 'clip.wav');
    expect(a).toBe(b);
  });

  test('stemCacheKey differs when model chain changes', () => {
    const ch = [new Float32Array([0.1, 0.2, 0.3, 0.4])];
    const a = stemCacheKey(ch, 48000, ['bsrnn_vocals'], 'clip.wav');
    const b = stemCacheKey(ch, 48000, ['bsrnn_vocals', 'rnnoise'], 'clip.wav');
    expect(a).not.toBe(b);
  });

  test('stemCacheKey preserves model chain order', () => {
    const ch = [new Float32Array([0.1, 0.2, 0.3, 0.4])];
    const a = stemCacheKey(ch, 48000, ['demucs', 'rnnoise'], 'clip.wav');
    const b = stemCacheKey(ch, 48000, ['rnnoise', 'demucs'], 'clip.wav');
    expect(a).not.toBe(b);
  });

  test('stemCacheKey differentiates Process-time Engineer snapshots', () => {
    const ch = [new Float32Array([0.1, 0.2, 0.3, 0.4])];
    const a = stemCacheKey(ch, 48000, ['bsrnn_vocals'], 'clip.wav', 'emc1-alpha');
    const b = stemCacheKey(ch, 48000, ['bsrnn_vocals'], 'clip.wav', 'emc1-beta');
    expect(a).not.toBe(b);
    expect(a).toContain('engineer:emc1-alpha');
  });

  test('setCachedStems stores and getCachedStems retrieves copies', () => {
    const key = 'test-key';
    const cleanIn = new Float32Array([1, 2]);
    setCachedStems(key, {
      clean: [cleanIn],
      noise: [new Float32Array([3, 4])],
      sampleRate: 48000,
      passthrough: false,
    });
    expect(getStemCacheSize()).toBe(1);
    const hit = getCachedStems(key);
    expect(hit.sampleRate).toBe(48000);
    expect(hit.clean[0][0]).toBe(1);
    expect(hit.clean[0]).not.toBe(cleanIn);
  });

  test('clearStemCache empties the store', () => {
    setCachedStems('k', {
      clean: [new Float32Array([1])],
      noise: [new Float32Array([0])],
      sampleRate: 48000,
      passthrough: false,
    });
    clearStemCache();
    expect(getStemCacheSize()).toBe(0);
    expect(getCachedStems('k')).toBeNull();
  });
});

describe('stemCacheKey content identity', () => {
  test('an edit between sparse probe points changes the key', () => {
    const len = 48000;
    const original = new Float32Array(len);
    for (let i = 0; i < len; i++) original[i] = Math.sin(i * 0.01) * 0.3;
    const edited = original.slice();
    // Sample 7 is never a probe point of a 64-step sparse sample, the first,
    // middle or last sample; the old key missed exactly this kind of edit.
    edited[7] = 0;
    const a = stemCacheKey([original], 48000, ['bsrnn_vocals'], 'clip.wav');
    const b = stemCacheKey([edited], 48000, ['bsrnn_vocals'], 'clip.wav');
    expect(a).not.toBe(b);
  });

  test('swapping channels changes the key', () => {
    const l = new Float32Array([0.1, 0.2, 0.3]);
    const r = new Float32Array([0.4, 0.5, 0.6]);
    expect(stemCacheKey([l, r], 48000, ['m'])).not.toBe(stemCacheKey([r, l], 48000, ['m']));
  });

  test('subarray views hash only their own samples', () => {
    const backing = new Float32Array([9, 0.1, 0.2, 0.3, 9]);
    const view = backing.subarray(1, 4);
    expect(stemCacheKey([view], 48000, ['m'])).toBe(stemCacheKey([new Float32Array([0.1, 0.2, 0.3])], 48000, ['m']));
  });
});
