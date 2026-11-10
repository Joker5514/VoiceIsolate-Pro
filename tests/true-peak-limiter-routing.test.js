/**
 * PlaybackMixer wiring of the true-peak limiter worklet: it takes over the
 * ceiling (native limiter leg bypassed), follows the Limiter control and the
 * safety ceiling, and adds its fixed latency to the graph's.
 */
'use strict';

let PlaybackMixer;
let TPL;
beforeAll(async () => {
  ({ PlaybackMixer } = await import('../src/pipeline/PlaybackMixer.js'));
  TPL = await import('../src/core/TruePeakLimiter.js');
});
const mockParam = (v = 0) => ({ value: v, setTargetAtTime: jest.fn(), setValueAtTime: jest.fn(), cancelScheduledValues: jest.fn() });
const mockNode = (extra = {}) => ({ connect: jest.fn(), disconnect: jest.fn(), ...extra });
function context() {
  return {
    sampleRate: 48000, currentTime: 0, state: 'running', destination: mockNode(),
    createGain: () => mockNode({ gain: mockParam(1) }),
    createBiquadFilter: () => mockNode({ type: '', frequency: mockParam(0), gain: mockParam(0), Q: mockParam(0) }),
    createAnalyser: () => mockNode({ fftSize: 0 }),
    createChannelSplitter: () => mockNode(),
    createChannelMerger: () => mockNode(),
    createDynamicsCompressor: () => mockNode({ threshold: mockParam(0), knee: mockParam(0), ratio: mockParam(1), attack: mockParam(0), release: mockParam(0.05), reduction: 0 }),
    createDelay: () => mockNode({ delayTime: mockParam(0) }),
    createWaveShaper: () => mockNode({ curve: null }),
    createBufferSource: () => mockNode({ buffer: null, start: jest.fn(), stop: jest.fn() }),
    resume: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    audioWorklet: { addModule: jest.fn().mockResolvedValue(undefined) },
  };
}

describe('true-peak limiter worklet routing', () => {
  const realNode = globalThis.AudioWorkletNode;
  let created;
  beforeEach(() => {
    created = [];
    globalThis.AudioWorkletNode = jest.fn(function Node(ctx, name) {
      const params = new Map(['threshold', 'range', 'attack', 'release', 'hold', 'lookahead', 'frequency', 'amount', 'ceiling', 'enabled']
        .map((n) => [n, mockParam(0)]));
      const node = mockNode({ name, parameters: params, port: { postMessage: jest.fn(), close: jest.fn() } });
      created.push(node);
      return node;
    });
  });
  afterEach(() => { globalThis.AudioWorkletNode = realNode; });

  async function loaded() {
    const mixer = new PlaybackMixer({ context: context() });
    await mixer.workletsReady();
    expect(mixer.getWorkletStatus().limiter).toEqual({ state: 'loaded', node: true });
    return mixer;
  }
  const value = (mixer, node, name) => mixer._parameterTargets.get(node.parameters.get(name)) ?? node.parameters.get(name).value;

  test('it is spliced between limiterOut and the ceiling stage', async () => {
    const mixer = await loaded();
    const node = mixer.truePeakLimiter;
    expect(node.name).toBe('vip-true-peak-limiter');
    expect(mixer.limiterOut.connect).toHaveBeenCalledWith(node);
    expect(node.connect).toHaveBeenCalledWith(mixer.ceilingIn);
  });

  test('disengaged until a ceiling exists; then it takes the Limiter control', async () => {
    const mixer = await loaded();
    const node = mixer.truePeakLimiter;
    expect(value(mixer, node, 'enabled')).toBe(0);
    mixer.setLimiterThreshold(-3);
    mixer.setLimiterRelease(450);
    expect(value(mixer, node, 'enabled')).toBe(1);
    expect(value(mixer, node, 'ceiling')).toBe(-3);
    expect(value(mixer, node, 'release')).toBeCloseTo(450, 6);
    // Below the 300 ms release floor the worklet gets the floor.
    mixer.setLimiterRelease(120);
    expect(value(mixer, node, 'release')).toBeCloseTo(300, 6);
    // Native limiter leg stays bypassed: no compressor make-up, no clip of overs.
    expect(mixer._parameterTargets.get(mixer.limiterEngagedGain.gain)).toBe(0);
    expect(mixer._parameterTargets.get(mixer.limiterBypassGain.gain)).toBe(1);
  });

  test('the safety ceiling engages it when the Limiter control is off', async () => {
    const mixer = await loaded();
    const node = mixer.truePeakLimiter;
    mixer.setSafetyCeiling(-1);
    expect(value(mixer, node, 'enabled')).toBe(1);
    expect(value(mixer, node, 'ceiling')).toBe(-1);
    mixer.setLimiterThreshold(-6); // the Limiter control wins
    expect(value(mixer, node, 'ceiling')).toBe(-6);
    mixer.setSafetyCeiling(null);
    expect(value(mixer, node, 'ceiling')).toBe(-6);
  });

  test('graph latency includes the worklet latency', async () => {
    const mixer = await loaded();
    mixer._compressorLatencyFrames = 288;
    expect(mixer.latencyFrames()).toBe(288 + 288 + TPL.truePeakLimiterLatencyFrames(48000));
  });
});
