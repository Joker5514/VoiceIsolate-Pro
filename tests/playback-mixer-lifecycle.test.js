/**
 * F03 — PlaybackMixer teardown is bounded and ownership-correct; F08/F09 —
 * latency bookkeeping and the output-ceiling stage. Real Web Audio behaviour
 * (impulses, dry/wet, ceiling, export alignment) is measured in Chromium by
 * scripts/audio-graph-browser-check.cjs; this suite pins the contracts that do
 * not need an audio thread.
 */
'use strict';

let PlaybackMixer;

beforeAll(async () => {
  ({ PlaybackMixer } = await import('../src/pipeline/PlaybackMixer.js'));
});

function mockParam(initial = 0) {
  return { value: initial, setTargetAtTime: jest.fn(), cancelScheduledValues: jest.fn() };
}
function mockNode(extra = {}) {
  return { connect: jest.fn(), disconnect: jest.fn(), ...extra };
}

/** Mock context whose addModule never settles (a stalled worklet fetch). */
function stalledContext() {
  const ctx = {
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
    createDelay: () => mockNode({ delayTime: mockParam(0) }),
    createWaveShaper: () => mockNode({ curve: null }),
    createBuffer: (channels, length, sampleRate) => ({
      numberOfChannels: channels, length, sampleRate, duration: length / sampleRate,
      _d: Array.from({ length: channels }, () => new Float32Array(length)),
      copyToChannel(data, ch) { this._d[ch].set(data); },
      getChannelData(ch) { return this._d[ch]; },
    }),
    createBufferSource: () => mockNode({ buffer: null, start: jest.fn(), stop: jest.fn(), onended: null }),
    resume: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    audioWorklet: { addModule: jest.fn(() => new Promise(() => {})) },
  };
  return ctx;
}

describe('PlaybackMixer.dispose (F03)', () => {
  const realNode = globalThis.AudioWorkletNode;
  const realCtx = globalThis.AudioContext;
  beforeEach(() => {
    globalThis.AudioWorkletNode = jest.fn(function Node() {
      return mockNode({ parameters: new Map(), port: { postMessage: jest.fn(), close: jest.fn() } });
    });
  });
  afterEach(() => {
    globalThis.AudioWorkletNode = realNode;
    globalThis.AudioContext = realCtx;
  });

  test('resolves promptly while worklet loads never settle, and is idempotent', async () => {
    const ctx = stalledContext();
    globalThis.AudioContext = jest.fn(() => ctx);
    const mixer = new PlaybackMixer();
    mixer.loadStems([new Float32Array(48)], [new Float32Array(48)]);
    const first = mixer.dispose();
    const outcome = await Promise.race([
      first.then(() => 'disposed'),
      new Promise((r) => setTimeout(() => r('hung'), 200)),
    ]);
    expect(outcome).toBe('disposed');
    expect(mixer.dispose()).toBe(first);
    expect(ctx.close).toHaveBeenCalledTimes(1);
    expect(mixer.cleanBuffer).toBeNull();
    expect(mixer.noiseBuffer).toBeNull();
    expect(mixer.masterGain.disconnect).toHaveBeenCalled();
    expect(mixer.dryDelay.disconnect).toHaveBeenCalled();
  });

  test('never closes an injected context it does not own', async () => {
    const ctx = stalledContext();
    const mixer = new PlaybackMixer({ context: ctx });
    await mixer.dispose();
    expect(ctx.close).not.toHaveBeenCalled();
  });

  test('a worklet load that settles after dispose does not touch the graph', async () => {
    const ctx = stalledContext();
    const finishLoads = [];
    ctx.audioWorklet.addModule = jest.fn(() => new Promise((r) => { finishLoads.push(r); }));
    const mixer = new PlaybackMixer({ context: ctx });
    await mixer.dispose();
    const connectsBefore = mixer.gateInput.connect.mock.calls.length;
    const deEsserBefore = mixer.deEsserInput.connect.mock.calls.length;
    // Both module loads (gate and de-esser) settle after dispose.
    expect(finishLoads).toHaveLength(2);
    finishLoads.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 20));
    expect(globalThis.AudioWorkletNode).not.toHaveBeenCalled();
    expect(mixer.gateInput.connect.mock.calls.length).toBe(connectsBefore);
    expect(mixer.deEsserInput.connect.mock.calls.length).toBe(deEsserBefore);
    expect(mixer.gate).toBeNull();
    expect(mixer.deEsser).toBeNull();
  });

  test('a worklet load that fails after dispose does not reconnect the bus', async () => {
    const ctx = stalledContext();
    const failLoads = [];
    ctx.audioWorklet.addModule = jest.fn(() => new Promise((_, reject) => { failLoads.push(reject); }));
    const mixer = new PlaybackMixer({ context: ctx });
    await mixer.dispose();
    const gateConnects = mixer.gateInput.connect.mock.calls.length;
    const deEsserConnects = mixer.deEsserInput.connect.mock.calls.length;
    expect(failLoads).toHaveLength(2);
    failLoads.forEach((reject) => reject(new Error('network')));
    await new Promise((r) => setTimeout(r, 50));
    expect(mixer.gateInput.connect.mock.calls.length).toBe(gateConnects);
    expect(mixer.deEsserInput.connect.mock.calls.length).toBe(deEsserConnects);
  });
});

describe('latency and ceiling bookkeeping (F08/F09)', () => {
  test('dry delay tracks compressor + gate lookahead; total adds the limiter', () => {
    const ctx = stalledContext();
    delete ctx.audioWorklet;
    const mixer = new PlaybackMixer({ context: ctx });
    mixer._compressorLatencyFrames = 288;
    mixer._updateDryDelay();
    expect(mixer.dryDelay.delayTime.value).toBeCloseTo(288 / 48000, 9);
    expect(mixer.latencyFrames()).toBe(576);
    // With the gate in the path its lookahead delays the wet side too.
    mixer.gate = mockNode({ parameters: new Map() });
    mixer.setGateLookahead(20);
    expect(mixer.dryDelay.delayTime.value).toBeCloseTo((288 + 960) / 48000, 9);
    expect(mixer.latencyFrames()).toBe(288 * 2 + 960);
  });

  test('while playing, gate lookahead steps with the dry delay instead of gliding', () => {
    const ctx = stalledContext();
    delete ctx.audioWorklet;
    const mixer = new PlaybackMixer({ context: ctx });
    mixer._compressorLatencyFrames = 288;
    const lookahead = mockParam(0);
    const threshold = mockParam(0);
    mixer.gate = mockNode({ parameters: new Map([['lookahead', lookahead], ['threshold', threshold]]) });
    mixer._isPlaying = true;
    mixer.setGateLookahead(10);
    expect(lookahead.setTargetAtTime).not.toHaveBeenCalled();
    expect(lookahead.value).toBe(10);
    expect(mixer.dryDelay.delayTime.value).toBeCloseTo((288 + 480) / 48000, 9);
    // Non-delay gate params still ramp.
    mixer._setGateParam('threshold', -40);
    expect(threshold.setTargetAtTime).toHaveBeenCalled();
  });

  test('ceiling curve is the identity to ±24 dBFS until a ceiling is set', () => {
    const ctx = stalledContext();
    delete ctx.audioWorklet;
    const mixer = new PlaybackMixer({ context: ctx });
    const gIn = mixer.ceilingIn.gain.value;
    const gOut = mixer.ceilingOut.gain.value;
    const through = (x) => {
      const curve = mixer.ceilingShaper.curve;
      const u = Math.max(-1, Math.min(1, x * gIn));
      const pos = ((u + 1) / 2) * (curve.length - 1);
      const k = Math.min(curve.length - 2, Math.floor(pos));
      return (curve[k] + (curve[k + 1] - curve[k]) * (pos - k)) * gOut;
    };
    for (const x of [-3, -1, -0.25, 0, 0.5, 1, 1.5, 12]) expect(through(x)).toBeCloseTo(x, 5);
    mixer.setLimiterThreshold(-6);
    expect(mixer.getCeilingDb()).toBe(-6);
    const c = 10 ** (-6 / 20);
    for (const x of [0.2, 0.49, -0.3]) expect(through(x)).toBeCloseTo(x, 4);
    for (const x of [0.6, 1, 4, 16, 40, -2]) expect(Math.abs(through(x))).toBeLessThanOrEqual(c + 1e-7);
  });
});
