/**
 * Live-preview limiter: Chromium's DynamicsCompressor adds automatic make-up
 * gain, (1 / curve(1))^0.6 — +0.57 dB at a −1 dB, 20:1 setting (measured in
 * Chrome). On a limiter that lifts everything under the ceiling and drives more
 * audio into the clip stage, so the engaged leg now carries the inverse. Export
 * no longer uses the compressor at all (true-peak limiter, see
 * tests/true-peak-limiter.test.js and runtime-contracts F09).
 */
'use strict';

let PlaybackMixer;
let limiterMakeupCompensation;
beforeAll(async () => {
  ({ PlaybackMixer, limiterMakeupCompensation } = await import('../src/pipeline/PlaybackMixer.js'));
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
    createDynamicsCompressor: () => mockNode({ threshold: mockParam(0), knee: mockParam(0), ratio: mockParam(1), attack: mockParam(0), release: mockParam(0), reduction: 0 }),
    createDelay: () => mockNode({ delayTime: mockParam(0) }),
    createWaveShaper: () => mockNode({ curve: null }),
    createBufferSource: () => mockNode({ buffer: null, start: jest.fn(), stop: jest.fn() }),
    resume: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    audioWorklet: { addModule: jest.fn(() => new Promise(() => {})) },
  };
}

test('compensation is the inverse of the spec make-up gain (hard knee)', () => {
  // Make-up = (1 / curve(1))^0.6 with curve(1) = t · (1/t)^(1/r), t linear.
  for (const [db, r] of [[-1, 20], [-6, 20], [-12, 4], [-0.1, 20]]) {
    const t = 10 ** (db / 20);
    const makeup = (1 / (t * (1 / t) ** (1 / r))) ** 0.6;
    expect(limiterMakeupCompensation(db, r) * makeup).toBeCloseTo(1, 12);
  }
  // Chrome measured 1.0678 at −1 dB / 20:1.
  expect(1 / limiterMakeupCompensation(-1, 20)).toBeCloseTo(1.0678, 3);
  expect(limiterMakeupCompensation(-1, 1)).toBe(1);
  expect(limiterMakeupCompensation(0, 20)).toBe(1);
});

describe('PlaybackMixer limiter routing', () => {
  const realNode = globalThis.AudioWorkletNode;
  beforeEach(() => {
    globalThis.AudioWorkletNode = jest.fn(function Node() {
      return mockNode({ parameters: new Map(), port: { postMessage: jest.fn(), close: jest.fn() } });
    });
  });
  afterEach(() => { globalThis.AudioWorkletNode = realNode; });

  test('the engaged limiter leg carries the make-up compensation; bypass stays unity', () => {
    const mixer = new PlaybackMixer({ context: context() });
    const target = (p) => mixer._parameterTargets.get(p) ?? p.value;
    expect(target(mixer.limiterEngagedGain.gain)).toBe(0);
    mixer.setLimiterThreshold(-1);
    expect(target(mixer.limiterEngagedGain.gain)).toBeCloseTo(limiterMakeupCompensation(-1, 20), 12);
    expect(target(mixer.limiterBypassGain.gain)).toBe(0);
    mixer.setLimiterThreshold(-6);
    expect(target(mixer.limiterEngagedGain.gain)).toBeCloseTo(10 ** (0.6 * -6 * 0.95 / 20), 12);
    void mixer.dispose();
  });
});
