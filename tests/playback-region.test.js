'use strict';

let PlaybackMixer;

beforeAll(async () => {
  const mod = await import('../src/pipeline/PlaybackMixer.js');
  PlaybackMixer = mod.PlaybackMixer;
});

function mockCtx() {
  const nodes = [];
  const makeNode = (extra = {}) => {
    const p = new Map();
    const n = {
      connect() {},
      disconnect() {},
      parameters: { get: (k) => ({ value: 0, setTargetAtTime() {} }) },
      gain: { value: 1, setTargetAtTime() {}, cancelScheduledValues() {} },
      ...extra,
    };
    nodes.push(n);
    return n;
  };
  return {
    state: 'running',
    currentTime: 0,
    sampleRate: 48000,
    destination: makeNode(),
    createGain: () => makeNode(),
    createBiquadFilter: () => makeNode({ frequency: { value: 0 }, Q: { value: 1 }, gain: { value: 0 }, type: '' }),
    createDynamicsCompressor: () => makeNode({
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 1 },
      attack: { value: 0 },
      release: { value: 0 },
    }),
    createAnalyser: () => makeNode({ fftSize: 2048, frequencyBinCount: 1024 }),
    createChannelSplitter: () => makeNode(),
    createChannelMerger: () => makeNode(),
    createBuffer: (ch, len, sr) => ({
      numberOfChannels: ch,
      length: len,
      duration: len / sr,
      sampleRate: sr,
      getChannelData: () => new Float32Array(len),
      copyToChannel() {},
    }),
    createBufferSource: () => makeNode({ buffer: null, start() {}, stop() {}, onended: null }),
    resume: async () => {},
    close: async () => {},
  };
}

describe('PlaybackMixer loop + crop', () => {
  test('setCropRegion and hasCrop detect active window', () => {
    const mixer = new PlaybackMixer({ context: mockCtx() });
    mixer.loadStems([new Float32Array(48000 * 3)], [new Float32Array(48000 * 3)], 48000);
    expect(mixer.hasCrop()).toBe(false);
    mixer.setCropRegion(1, 2);
    expect(mixer.hasCrop()).toBe(true);
    expect(mixer.getCropRegion()).toEqual({ in: 1, out: 2 });
    mixer.clearCrop();
    expect(mixer.hasCrop()).toBe(false);
  });

  test('setLoop toggles loop flag', () => {
    const mixer = new PlaybackMixer({ context: mockCtx() });
    expect(mixer.isLoopEnabled()).toBe(false);
    mixer.setLoop(true);
    expect(mixer.isLoopEnabled()).toBe(true);
  });

  test('stop rewinds to crop in-point', () => {
    const mixer = new PlaybackMixer({ context: mockCtx() });
    mixer.loadStems([new Float32Array(48000 * 5)], [new Float32Array(48000 * 5)], 48000);
    mixer.setCropRegion(0.5, 1.5);
    mixer._offset = 1.0;
    mixer.stop();
    expect(mixer.currentTime()).toBeCloseTo(0.5, 3);
  });
});
describe('PlaybackMixer settles in-flight ramps when playback stops', () => {
  // The mock's setTargetAtTime is a no-op, which models a ramp frozen mid-way
  // because the graph stopped processing when the sources ended.
  const loaded = () => {
    const mixer = new PlaybackMixer({ context: mockCtx() });
    mixer.loadStems([new Float32Array(48000 * 3)], [new Float32Array(48000 * 3)], 48000);
    return mixer;
  };

  test('natural end snaps the voice level to its target', async () => {
    const mixer = loaded();
    await mixer.play();
    expect(mixer.isPlaying()).toBe(true);
    mixer.setVoiceLevel(200);
    expect(mixer.cleanGain.gain.value).toBe(1); // ramp scheduled, not applied yet
    mixer._cleanSource.onended();
    expect(mixer.isPlaying()).toBe(false);
    expect(mixer.cleanGain.gain.value).toBe(2);
  });

  test('settling cancels the in-flight setTargetAtTime event, not just later ones', async () => {
    const mixer = loaded();
    // Model the AudioParam timeline: cancelScheduledValues(t) drops events at or after t.
    const events = [];
    const gain = mixer.cleanGain.gain;
    gain.setTargetAtTime = (target, time) => events.push({ target, time });
    gain.cancelScheduledValues = (t) => {
      for (let i = events.length - 1; i >= 0; i--) if (events[i].time >= t) events.splice(i, 1);
    };
    await mixer.play();
    mixer.ctx.currentTime = 1; // ramp starts at t=1
    mixer.setVoiceLevel(150);
    expect(events).toHaveLength(1);
    mixer.ctx.currentTime = 1.05; // playback ends mid-ramp
    mixer.pause();
    expect(events).toHaveLength(0);
    expect(gain.value).toBe(1.5);
  });

  test.each(['pause', 'stop'])('%s snaps the voice level to its target', async (method) => {
    const mixer = loaded();
    await mixer.play();
    mixer.setVoiceLevel(50);
    expect(mixer.cleanGain.gain.value).toBe(1); // ramp scheduled, not applied yet
    mixer[method]();
    expect(mixer.cleanGain.gain.value).toBe(0.5);
  });
});
