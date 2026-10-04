/**
 * Cooperative stem loading — regression guards for the post-Process freeze.
 *
 * Measured in Chromium on a 15-minute stereo file: the Live-Mix stem load ran
 * two full-length copyToChannel passes in one task (3.1 s), happened twice per
 * Process, and the stem cache copied ~350 MB synchronously (0.3 s). These tests
 * pin the fixed behaviour: same bytes, copied in slices, loaded once.
 */
'use strict';

let PlaybackMixer;
let EngineerModeBridge;
let copyChannelsToAudioBuffer;
let MLStemCache;

beforeAll(async () => {
  ({ PlaybackMixer } = await import('../src/pipeline/PlaybackMixer.js'));
  ({ EngineerModeBridge } = await import('../src/pipeline/EngineerModeBridge.js'));
  ({ copyChannelsToAudioBuffer } = await import('../src/pipeline/ui-yield.js'));
  MLStemCache = await import('../src/pipeline/MLStemCache.js');
});

function mockParam(initial = 0) {
  return { value: initial, setTargetAtTime: jest.fn(), cancelScheduledValues: jest.fn() };
}
function mockNode(extra = {}) {
  return { connect: jest.fn(), disconnect: jest.fn(), ...extra };
}
function fakeBuffer(channels, length, sampleRate) {
  const buf = {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    copies: [],
    _data: Array.from({ length: channels }, () => new Float32Array(length)),
    copyToChannel(data, ch, offset = 0) {
      buf.copies.push({ ch, offset, length: data.length });
      buf._data[ch].set(data, offset);
    },
    getChannelData(ch) { return buf._data[ch]; },
  };
  return buf;
}
function mockContext() {
  return {
    sampleRate: 48000,
    currentTime: 0,
    state: 'running',
    destination: mockNode(),
    createGain: () => mockNode({ gain: mockParam(0) }),
    createBiquadFilter: () => mockNode({ type: '', frequency: mockParam(0), gain: mockParam(0), Q: mockParam(0) }),
    createAnalyser: () => mockNode({ fftSize: 0 }),
    createChannelSplitter: () => mockNode(),
    createChannelMerger: () => mockNode(),
    createDynamicsCompressor: () => mockNode({
      threshold: mockParam(0), knee: mockParam(0), ratio: mockParam(1),
      attack: mockParam(0), release: mockParam(0), reduction: 0,
    }),
    createBuffer: fakeBuffer,
    createBufferSource: () => mockNode({ buffer: null, start: jest.fn(), stop: jest.fn(), onended: null }),
    resume: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}
const ramp = (n, k = 1) => Float32Array.from({ length: n }, (_, i) => ((i * k) % 997) / 997 - 0.5);

describe('copyChannelsToAudioBuffer', () => {
  test('writes identical samples in offset slices', async () => {
    const src = [ramp(10_000, 3), ramp(10_000, 7)];
    const buf = fakeBuffer(2, 10_000, 48000);
    await copyChannelsToAudioBuffer(buf, src, { chunkSize: 3000 });
    expect(buf._data[0]).toEqual(src[0]);
    expect(buf._data[1]).toEqual(src[1]);
    expect(buf.copies.filter((c) => c.ch === 0).map((c) => c.offset)).toEqual([0, 3000, 6000, 9000]);
    expect(Math.max(...buf.copies.map((c) => c.length))).toBe(3000);
  });

  test('stops on an aborted signal', async () => {
    const buf = fakeBuffer(1, 1000, 48000);
    const ac = new AbortController();
    ac.abort();
    await expect(copyChannelsToAudioBuffer(buf, [ramp(1000)], { signal: ac.signal, chunkSize: 100 }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('PlaybackMixer.loadStemsAsync', () => {
  test('installs the same audio as loadStems', async () => {
    const clean = [ramp(5000, 2)];
    const noise = [ramp(5000, 5)];
    const syncMixer = new PlaybackMixer({ context: mockContext() });
    syncMixer.loadStems(clean, noise, 48000);
    const asyncMixer = new PlaybackMixer({ context: mockContext() });
    await expect(asyncMixer.loadStemsAsync(clean, noise, 48000)).resolves.toBe(true);
    expect(asyncMixer.cleanBuffer.getChannelData(0)).toEqual(syncMixer.cleanBuffer.getChannelData(0));
    expect(asyncMixer.noiseBuffer.getChannelData(0)).toEqual(syncMixer.noiseBuffer.getChannelData(0));
    expect(asyncMixer.duration()).toBeCloseTo(syncMixer.duration(), 9);
  });

  test('a newer load supersedes an in-flight one', async () => {
    const mixer = new PlaybackMixer({ context: mockContext() });
    const first = mixer.loadStemsAsync([ramp(100, 1)], [ramp(100, 2)], 48000);
    mixer.loadStems([ramp(200, 3)], [ramp(200, 4)], 48000);
    await expect(first).resolves.toBe(false);
    expect(mixer.cleanBuffer.length).toBe(200);
  });
});

describe('EngineerModeBridge.loadStemPairAsync', () => {
  function bridgeWithSpy() {
    const mixer = new PlaybackMixer({ context: mockContext() });
    const spy = jest.spyOn(mixer, 'loadStemsAsync');
    return { bridge: new EngineerModeBridge({ mixer }), mixer, spy };
  }

  test('reloading the same stems is a no-op (one copy per Process)', async () => {
    const { bridge, spy } = bridgeWithSpy();
    const clean = [ramp(1000)];
    const noise = [ramp(1000, 3)];
    await expect(bridge.loadStemPairAsync(clean, noise, 48000)).resolves.toBe(true);
    await expect(bridge.loadStemPairAsync(clean, noise, 48000)).resolves.toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(bridge.hasNoiseStem()).toBe(true);
    expect(bridge.isLoaded()).toBe(true);
  });

  test('concurrent duplicate requests share one load', async () => {
    const { bridge, spy } = bridgeWithSpy();
    const clean = [ramp(1000)];
    const [a, b] = await Promise.all([
      bridge.loadStemPairAsync(clean, null, 48000),
      bridge.loadStemPairAsync(clean, null, 48000),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(bridge.hasNoiseStem()).toBe(false);
  });

  test('new stems, a new rate, or an intervening loadBuffer all reload', async () => {
    const { bridge, mixer, spy } = bridgeWithSpy();
    const clean = [ramp(1000)];
    await bridge.loadStemPairAsync(clean, null, 48000);
    await bridge.loadStemPairAsync([ramp(1000, 2)], null, 48000);
    await bridge.loadStemPairAsync(clean, null, 48000);
    await bridge.loadStemPairAsync(clean, null, 44100);
    expect(spy).toHaveBeenCalledTimes(4);
    bridge.loadBuffer(fakeBuffer(1, 500, 48000));
    expect(mixer.cleanBuffer.length).toBe(500);
    await bridge.loadStemPairAsync(clean, null, 44100);
    expect(spy).toHaveBeenCalledTimes(5);
    expect(mixer.cleanBuffer.getChannelData(0)).toEqual(clean[0]);
  });
});

describe('setCachedStemsAsync', () => {
  beforeEach(() => MLStemCache.clearStemCache());

  test('stores independent copies made by the supplied copier', async () => {
    const clean = ramp(100);
    const noise = ramp(100, 3);
    const copier = jest.fn(async (c) => c.slice());
    await MLStemCache.setCachedStemsAsync('k', { clean: [clean], noise: [noise], sampleRate: 48000 }, copier);
    expect(copier).toHaveBeenCalledTimes(2);
    clean[0] = 42;
    const hit = MLStemCache.getCachedStems('k');
    expect(hit.clean[0]).not.toBe(clean);
    expect(hit.clean[0][0]).not.toBe(42);
    expect(hit.noise[0]).toEqual(noise);
    expect(hit.sampleRate).toBe(48000);
  });

  test('ignores passthrough results', async () => {
    await MLStemCache.setCachedStemsAsync('p', { clean: [ramp(10)], passthrough: true }, async (c) => c.slice());
    expect(MLStemCache.getCachedStems('p')).toBeNull();
  });
});

describe('calcDownmixRms', () => {
  test('equals calcRms(downmixToMono(channels)) exactly', async () => {
    const { calcRms, calcDownmixRms, downmixToMono } = await import('../src/core/MixCalibration.js');
    const cases = [
      [Float32Array.from({ length: 200_003 }, (_, i) => Math.sin(i * 0.011) * 0.3)],
      [Float32Array.from({ length: 1_000_001 }, (_, i) => Math.sin(i * 0.007) * 0.71),
        Float32Array.from({ length: 1_000_001 }, (_, i) => Math.cos(i * 0.013) * 0.19)],
      [new Float32Array(10).fill(0.5), new Float32Array(10).fill(-0.25), new Float32Array(10).fill(0.1)],
    ];
    for (const channels of cases) {
      expect(calcDownmixRms(channels)).toBe(calcRms(downmixToMono(channels)));
    }
    expect(calcDownmixRms([new Float32Array(0)])).toBe(0);
  });
});

describe('review follow-ups: supersede, dispose, cache invalidation', () => {
  test('a superseded loadStemsAsync stops between slices, not after the whole pair', async () => {
    const mixer = new PlaybackMixer({ context: mockContext() });
    const big = [ramp(5_000_000)];
    const first = mixer.loadStemsAsync(big, big, 48000);
    mixer.loadStems([ramp(10)], [ramp(10)], 48000);
    await expect(first).resolves.toBe(false);
    expect(mixer.cleanBuffer.length).toBe(10);
  });

  test('an already-loaded source does not bypass a different pending load', async () => {
    const mixer = new PlaybackMixer({ context: mockContext() });
    const bridge = new EngineerModeBridge({ mixer });
    const a = [ramp(100, 1)];
    const b = [ramp(100, 2)];
    await bridge.loadStemPairAsync(a, null, 48000);
    const pendingB = bridge.loadStemPairAsync(b, null, 48000);
    const backToA = bridge.loadStemPairAsync(a, null, 48000);
    await expect(pendingB).resolves.toBe(false); // superseded by the later A request
    await expect(backToA).resolves.toBe(true);
    expect(mixer.cleanBuffer.getChannelData(0)).toEqual(a[0]);
  });

  test('a load that completes after dispose() does not mark the bridge loaded', async () => {
    const mixer = new PlaybackMixer({ context: mockContext() });
    const bridge = new EngineerModeBridge({ mixer });
    const pending = bridge.loadStemPairAsync([ramp(100)], null, 48000);
    await bridge.dispose();
    await expect(pending).resolves.toBe(false);
    expect(bridge.isLoaded()).toBe(false);
  });

  test('clearStemCache during an async store discards that store', async () => {
    MLStemCache.clearStemCache();
    let release;
    const gate = new Promise((r) => { release = r; });
    const pending = MLStemCache.setCachedStemsAsync('stale', { clean: [ramp(10)], noise: [ramp(10)], sampleRate: 48000 },
      async (c) => { await gate; return c.slice(); });
    MLStemCache.clearStemCache();
    release();
    await pending;
    expect(MLStemCache.getCachedStems('stale')).toBeNull();
  });
});
