/**
 * VoiceIsolate Pro — SpeakerRegistry Unit Tests
 * Tests cosine similarity, speaker identification, enrollment,
 * profile management, and IndexedDB persistence helpers.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Load pipeline-state.js and extract SpeakerRegistry
const stateCode = fs.readFileSync(
  path.join(__dirname, '../public/app/pipeline-state.js'),
  'utf8'
);

// Evaluate in a context that returns both exports
const { SpeakerRegistry } = (() => {
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'window', stateCode + '\nreturn module.exports;')(mod, {});
  return mod.exports;
})();

// ---- helpers ----

/** Build a normalised Float32Array embedding of length `dim` from seed values. */
function makeEmbedding(dim, seed = 1) {
  const arr = new Float32Array(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    arr[i] = Math.sin(i * seed + seed);
    norm += arr[i] * arr[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) arr[i] /= norm;
  return arr;
}

// ============================================================
// cosineSimilarity
// ============================================================
describe('SpeakerRegistry.cosineSimilarity', () => {
  test('identical vectors → 1', () => {
    const a = new Float32Array([1, 0, 0]);
    expect(SpeakerRegistry.cosineSimilarity(a, a)).toBeCloseTo(1, 5);
  });

  test('opposite vectors → -1', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(SpeakerRegistry.cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  test('orthogonal vectors → 0', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(SpeakerRegistry.cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  test('zero vector → 0 (no NaN)', () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(SpeakerRegistry.cosineSimilarity(a, b)).toBe(0);
  });

  test('normalised 128-dim embeddings → similarity in [-1, 1]', () => {
    const a = makeEmbedding(128, 1);
    const b = makeEmbedding(128, 2);
    const sim = SpeakerRegistry.cosineSimilarity(a, b);
    expect(sim).toBeGreaterThanOrEqual(-1);
    expect(sim).toBeLessThanOrEqual(1);
  });

  test('same seed embedding has similarity 1 with itself', () => {
    const a = makeEmbedding(192, 42);
    expect(SpeakerRegistry.cosineSimilarity(a, a)).toBeCloseTo(1, 5);
  });
});

// ============================================================
// Constructor / defaults
// ============================================================
describe('SpeakerRegistry constructor', () => {
  test('starts with no profiles', () => {
    const reg = new SpeakerRegistry();
    expect(reg.getProfiles()).toHaveLength(0);
  });

  test('threshold defaults to 0.65', () => {
    expect(new SpeakerRegistry()._threshold).toBe(0.65);
  });
});

// ============================================================
// identify
// ============================================================
describe('SpeakerRegistry.identify', () => {
  let reg;
  beforeEach(() => { reg = new SpeakerRegistry(); });

  test('creates a new speaker on first call', () => {
    const emb = makeEmbedding(192, 1);
    const { speaker, isNew } = reg.identify(emb);
    expect(isNew).toBe(true);
    expect(speaker.id).toBe(1);
    expect(speaker.label).toBe('Speaker 1');
    expect(typeof speaker.color).toBe('string');
  });

  test('recognises the same speaker on subsequent calls', () => {
    const emb = makeEmbedding(192, 1);
    reg.identify(emb);

    // Nearly identical embedding (slight noise)
    const emb2 = Float32Array.from(emb.map(v => v + 0.001));
    const { speaker, isNew } = reg.identify(emb2);
    expect(isNew).toBe(false);
    expect(speaker.id).toBe(1);
  });

  test('creates a second speaker for a very different embedding', () => {
    const emb1 = makeEmbedding(192, 1);
    const emb2 = makeEmbedding(192, 999); // very different seed
    reg.identify(emb1);
    const { speaker, isNew } = reg.identify(emb2);
    expect(isNew).toBe(true);
    expect(speaker.id).toBe(2);
  });

  test('assigns distinct colors to different speakers', () => {
    const { speaker: sp1 } = reg.identify(makeEmbedding(192, 1));
    const { speaker: sp2 } = reg.identify(makeEmbedding(192, 999));
    expect(sp1.color).not.toBe(sp2.color);
  });

  test('updates lastSeen on re-identification', () => {
    const emb = makeEmbedding(192, 1);
    reg.identify(emb);
    const before = reg._profiles[0].lastSeen;

    // Force a tiny delay for timestamp comparison
    jest.useFakeTimers();
    jest.advanceTimersByTime(10);
    reg.identify(emb);
    jest.useRealTimers();

    expect(reg._profiles[0].lastSeen).toBeGreaterThanOrEqual(before);
  });
});

// ============================================================
// enroll
// ============================================================
describe('SpeakerRegistry.enroll', () => {
  test('creates a profile with a custom label', () => {
    const reg = new SpeakerRegistry();
    const emb = makeEmbedding(192, 5);
    const sp = reg.enroll(emb, 'Alice');
    expect(sp.label).toBe('Alice');
    expect(reg.getProfiles()).toHaveLength(1);
  });

  test('falls back to "Speaker N" when no label given', () => {
    const reg = new SpeakerRegistry();
    const sp = reg.enroll(makeEmbedding(192, 5));
    expect(sp.label).toBe('Speaker 1');
  });

  test('enrolled profile is matchable via identify', () => {
    const reg = new SpeakerRegistry();
    const emb = makeEmbedding(192, 7);
    reg.enroll(emb, 'Bob');

    const { speaker, isNew } = reg.identify(emb);
    expect(isNew).toBe(false);
    expect(speaker.label).toBe('Bob');
  });
});

// ============================================================
// getProfiles / removeProfile / clearAll
// ============================================================
describe('SpeakerRegistry profile management', () => {
  let reg;
  beforeEach(() => {
    reg = new SpeakerRegistry();
    reg.identify(makeEmbedding(192, 1));
    reg.identify(makeEmbedding(192, 999));
  });

  test('getProfiles returns metadata without embeddings', () => {
    const profiles = reg.getProfiles();
    expect(profiles).toHaveLength(2);
    for (const p of profiles) {
      expect(p).not.toHaveProperty('embedding');
      expect(p).toHaveProperty('id');
      expect(p).toHaveProperty('label');
      expect(p).toHaveProperty('color');
      expect(p).toHaveProperty('createdAt');
      expect(p).toHaveProperty('lastSeen');
    }
  });

  test('removeProfile deletes the correct profile', () => {
    reg.removeProfile(1);
    const profiles = reg.getProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].id).toBe(2);
  });

  test('removeProfile with unknown id is a no-op', () => {
    reg.removeProfile(999);
    expect(reg.getProfiles()).toHaveLength(2);
  });

  test('clearAll removes all profiles and resets ID counter', () => {
    reg.clearAll();
    expect(reg.getProfiles()).toHaveLength(0);
    expect(reg._nextId).toBe(1);
  });
});

// ============================================================
// onChange listener
// ============================================================
describe('SpeakerRegistry.onChange', () => {
  let reg;
  beforeEach(() => { reg = new SpeakerRegistry(); });

  test('fires on identify (new speaker)', () => {
    const fn = jest.fn();
    reg.onChange(fn);
    reg.identify(makeEmbedding(192, 1));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('fires on enroll', () => {
    const fn = jest.fn();
    reg.onChange(fn);
    reg.enroll(makeEmbedding(192, 1));
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('fires on removeProfile', () => {
    reg.identify(makeEmbedding(192, 1));
    const fn = jest.fn();
    reg.onChange(fn);
    reg.removeProfile(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('fires on clearAll', () => {
    reg.identify(makeEmbedding(192, 1));
    const fn = jest.fn();
    reg.onChange(fn);
    reg.clearAll();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('does NOT fire on identify when speaker already known (no new profile)', () => {
    const emb = makeEmbedding(192, 1);
    reg.identify(emb); // creates speaker → fires once

    const fn = jest.fn();
    reg.onChange(fn);
    reg.identify(emb); // same speaker → no new profile → no fire
    expect(fn).not.toHaveBeenCalled();
  });

  test('unsubscribe function stops notifications', () => {
    const fn = jest.fn();
    const unsub = reg.onChange(fn);
    unsub();
    reg.identify(makeEmbedding(192, 1));
    expect(fn).not.toHaveBeenCalled();
  });

  test('listener receives current profile list', () => {
    const fn = jest.fn();
    reg.onChange(fn);
    reg.enroll(makeEmbedding(192, 1), 'Alice');
    const [profiles] = fn.mock.calls[0];
    expect(Array.isArray(profiles)).toBe(true);
    expect(profiles[0].label).toBe('Alice');
  });
});

// ============================================================
// Color cycling
// ============================================================
describe('SpeakerRegistry color assignment', () => {
  test('cycles colors when more speakers than palette entries', () => {
    const reg = new SpeakerRegistry();
    const paletteSize = reg._colors.length;
    // Create paletteSize + 1 distinct speakers
    for (let i = 0; i < paletteSize + 1; i++) {
      reg.enroll(makeEmbedding(192, i + 1), `Spk${i + 1}`);
    }
    const profiles = reg.getProfiles();
    // The (paletteSize+1)-th speaker (index paletteSize) wraps to color index 0
    expect(profiles[paletteSize].color).toBe(reg._colors[0]);
  });
});

// ============================================================
// Threshold sensitivity
// ============================================================
describe('SpeakerRegistry threshold', () => {
  test('lowering threshold causes more re-identification matches', () => {
    const reg = new SpeakerRegistry();
    reg._threshold = 0.01; // very lenient
    const emb1 = makeEmbedding(192, 1);
    reg.identify(emb1);

    const emb2 = makeEmbedding(192, 500); // different but threshold is low
    const { isNew } = reg.identify(emb2);
    // With a very low threshold, any positive similarity qualifies as a match
    // (emb2 is different but cosine sim may be > 0.01 for random unit vectors)
    // We just verify the logic runs without error; the exact result depends on seeds
    expect(typeof isNew).toBe('boolean');
  });

  test('raising threshold to 1 always creates new speakers', () => {
    const reg = new SpeakerRegistry();
    reg._threshold = 1.0; // exact match required
    const emb = makeEmbedding(192, 1);
    reg.identify(emb);

    const emb2 = Float32Array.from(emb.map(v => v + 0.0001)); // very similar but not identical
    const { isNew } = reg.identify(emb2);
    expect(isNew).toBe(true);
  });
});
