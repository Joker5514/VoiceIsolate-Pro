/**
 * VoiceIsolate Pro — Stem-Split & Live-Mix Core Tests
 *
 * Covers the Layer 1 primitives (audio-config, BufferPool, ModelManifest)
 * and the PlaybackMixer control surface against a mock AudioContext.
 * Modules are ESM (src/), loaded via dynamic import under
 * --experimental-vm-modules (same pattern as server.test.js).
 */

'use strict';

let audioConfig;
let BufferPool;
let manifest;
let PlaybackMixer;

beforeAll(async () => {
  audioConfig = await import('../src/core/audio-config.js');
  ({ BufferPool } = await import('../src/core/BufferPool.js'));
  manifest = await import('../src/core/ModelManifest.js');
  ({ PlaybackMixer } = await import('../src/pipeline/PlaybackMixer.js'));
});

// ── audio-config ──────────────────────────────────────────────────────────────
describe('audio-config (Layer 1)', () => {
  test('canonical sample rate is 48000', () => {
    expect(audioConfig.SAMPLE_RATE).toBe(48000);
  });

  test('resampledLength converts 44.1k lengths to 48k', () => {
    expect(audioConfig.resampledLength(44100, 44100)).toBe(48000);
    expect(() => audioConfig.resampledLength(10, 0)).toThrow(RangeError);
  });

  test('verifyContextSampleRate warns on mismatch and passes on match', () => {
    const warnings = [];
    const warn = (m) => warnings.push(m);
    expect(audioConfig.verifyContextSampleRate({ sampleRate: 48000 }, warn)).toBe(true);
    expect(warnings).toHaveLength(0);
    expect(audioConfig.verifyContextSampleRate({ sampleRate: 44100 }, warn)).toBe(false);
    expect(warnings[0]).toContain('44100');
  });
});

// ── BufferPool ────────────────────────────────────────────────────────────────
describe('BufferPool (Layer 1)', () => {
  test('acquires pre-allocated buffers without allocation misses', () => {
    const pool = new BufferPool({ sizes: [128, 2048, 4096], preallocate: 2 });
    const a = pool.acquire(2048);
    expect(a).toBeInstanceOf(Float32Array);
    expect(a.length).toBe(2048);
    expect(pool.stats().misses).toBe(0);
  });

  test('release zero-fills and recycles the same buffer', () => {
    const pool = new BufferPool({ sizes: [128], preallocate: 1 });
    const a = pool.acquire(128);
    a[0] = 42;
    pool.release(a);
    const b = pool.acquire(128);
    expect(b).toBe(a);
    expect(b[0]).toBe(0);
  });

  test('double-release and foreign buffers are ignored safely', () => {
    const pool = new BufferPool({ sizes: [128], preallocate: 1 });
    const a = pool.acquire(128);
    pool.release(a);
    pool.release(a);                       // double release
    pool.release(new Float32Array(128));   // never acquired
    expect(pool.stats().released).toBe(1);
  });

  test('unmanaged sizes are adopted (counted as misses)', () => {
    const pool = new BufferPool({ sizes: [128], preallocate: 1 });
    const odd = pool.acquire(777);
    expect(odd.length).toBe(777);
    expect(pool.stats().misses).toBe(1);
    pool.release(odd);
    expect(pool.acquire(777)).toBe(odd);
  });

  test('rejects invalid configuration and sizes', () => {
    expect(() => new BufferPool({ sizes: [] })).toThrow(RangeError);
    const pool = new BufferPool({ sizes: [128] });
    expect(() => pool.acquire(0)).toThrow(RangeError);
    expect(() => pool.acquire(1.5)).toThrow(RangeError);
  });
});

// ── ModelManifest ─────────────────────────────────────────────────────────────
describe('ModelManifest (Layer 1)', () => {
  test('declares the noise-suppression and vocal-separation models with valid entries', () => {
    expect(manifest.MODEL_IDS).toEqual(
      expect.arrayContaining(['rnnoise', 'bsrnn_vocals'])
    );
    for (const id of manifest.MODEL_IDS) {
      expect(manifest.isValidEntry(manifest.MODEL_MANIFEST[id])).toBe(true);
    }
  });

  test('model URLs are same-origin paths (never CDN)', () => {
    for (const id of manifest.MODEL_IDS) {
      const { url } = manifest.MODEL_MANIFEST[id];
      expect(url.startsWith('/')).toBe(true);
      expect(url).not.toMatch(/^https?:/);
    }
  });

  test('every shipped model has a pinned 64-char lowercase hex sha256', () => {
    for (const id of manifest.MODEL_IDS) {
      const { sha256 } = manifest.MODEL_MANIFEST[id];
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('getModel throws a descriptive error on unknown ids', () => {
    expect(() => manifest.getModel('nope')).toThrow(/Unknown model 'nope'/);
    expect(manifest.getModel('bsrnn_vocals').task).toBe('vocal-separation');
    expect(manifest.getModel('rnnoise').task).toBe('noise-suppression');
  });

  test('manifest is frozen (no runtime mutation)', () => {
    expect(Object.isFrozen(manifest.MODEL_MANIFEST)).toBe(true);
    expect(Object.isFrozen(manifest.MODEL_MANIFEST.bsrnn_vocals)).toBe(true);
  });

  test('committed model binaries match the manifest size and SHA-256 exactly', () => {
    const fs = require('fs');
    const path = require('path');
    const crypto = require('crypto');
    for (const id of manifest.MODEL_IDS) {
      const entry = manifest.MODEL_MANIFEST[id];
      const file = path.join(__dirname, '../public', entry.url);
      expect(fs.existsSync(file)).toBe(true);
      const bytes = fs.readFileSync(file);
      expect(bytes.length).toBe(entry.sizeBytes);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      expect(digest).toBe(entry.sha256);
    }
  });
});

// ── PlaybackMixer (mock AudioContext) ─────────────────────────────────────────
function mockParam() {
  return { value: 0, setTargetAtTime: jest.fn() };
}

function mockNode(extra = {}) {
  return { connect: jest.fn(), disconnect: jest.fn(), ...extra };
}

function mockContext() {
  return {
    sampleRate: 48000,
    currentTime: 0,
    state: 'running',
    destination: mockNode(),
    createGain: () => mockNode({ gain: mockParam() }),
    createBiquadFilter: () => mockNode({
      type: '', frequency: mockParam(), gain: mockParam(), Q: mockParam(),
    }),
    createAnalyser: () => mockNode({ fftSize: 0 }),
    createBuffer: (channels, length, sampleRate) => ({
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      _data: Array.from({ length: channels }, () => new Float32Array(length)),
      copyToChannel(data, ch) { this._data[ch].set(data); },
    }),
    createBufferSource: () => mockNode({
      buffer: null, start: jest.fn(), stop: jest.fn(), onended: null,
    }),
    resume: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('PlaybackMixer (Layer 3) — Live-Mix control surface', () => {
  let mixer;
  const stems = () => [new Float32Array(48000)];

  beforeEach(() => {
    mixer = new PlaybackMixer({ context: mockContext() });
  });

  test('defaults: clean stem at unity, noise stem muted', () => {
    expect(mixer.cleanGain.gain.value).toBe(1);
    expect(mixer.noiseGain.gain.value).toBe(0);
  });

  test('setNoiseReduction(75) smoothly drives NoiseGain toward 0.25', () => {
    mixer.setNoiseReduction(75);
    const call = mixer.noiseGain.gain.setTargetAtTime.mock.calls.at(-1);
    expect(call[0]).toBeCloseTo(0.25);
  });

  test('control inputs are clamped and never use bare value jumps', () => {
    mixer.setNoiseReduction(250);
    expect(mixer.noiseGain.gain.setTargetAtTime.mock.calls.at(-1)[0]).toBe(0);
    mixer.setVolume(-50);
    expect(mixer.masterGain.gain.setTargetAtTime.mock.calls.at(-1)[0]).toBe(0);
    mixer.setLowShelf(99);
    expect(mixer.lowShelf.gain.setTargetAtTime.mock.calls.at(-1)[0]).toBe(24);
  });

  test('loadStems builds sample-locked buffers; transport round-trips', async () => {
    mixer.loadStems(stems(), stems());
    expect(mixer.duration()).toBeCloseTo(1);
    await mixer.play();
    expect(mixer.isPlaying()).toBe(true);
    mixer.pause();
    expect(mixer.isPlaying()).toBe(false);
    await mixer.seek(0.5);
    expect(mixer.currentTime()).toBeCloseTo(0.5);
    mixer.stop();
    expect(mixer.currentTime()).toBe(0);
  });

  test('play() without stems rejects loudly', async () => {
    await expect(mixer.play()).rejects.toThrow(/No stems loaded/);
  });
});
