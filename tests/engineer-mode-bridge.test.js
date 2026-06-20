/**
 * VoiceIsolate Pro — Engineer Mode bridge + PlaybackMixer parity controls.
 *
 * Verifies the real-time effects added so the legacy Engineer Mode rt sliders
 * map onto live AudioParams (10-band graphic EQ, spectral tilt, brick-wall
 * limiter, output trim, dry/wet, gate hold), and that EngineerModeBridge
 * routes legacy slider ids to the right mixer setter with correct conversions.
 *
 * ESM under --experimental-vm-modules, mock AudioContext (same pattern as
 * stem-split-core.test.js).
 */
'use strict';

let PlaybackMixer;
let EngineerModeBridge;

beforeAll(async () => {
  ({ PlaybackMixer } = await import('../src/pipeline/PlaybackMixer.js'));
  ({ EngineerModeBridge } = await import('../src/pipeline/EngineerModeBridge.js'));
});

function mockParam(initial = 0) {
  return { value: initial, setTargetAtTime: jest.fn(), cancelScheduledValues: jest.fn() };
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
    createGain: () => mockNode({ gain: mockParam(0) }),
    createBiquadFilter: () => mockNode({
      type: '', frequency: mockParam(0), gain: mockParam(0), Q: mockParam(0),
    }),
    createAnalyser: () => mockNode({ fftSize: 0 }),
    createChannelSplitter: () => mockNode(),
    createChannelMerger: () => mockNode(),
    createDynamicsCompressor: () => mockNode({
      threshold: mockParam(0), knee: mockParam(0), ratio: mockParam(1),
      attack: mockParam(0), release: mockParam(0), reduction: 0,
    }),
    createBuffer: (channels, length, sampleRate) => ({
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      _data: Array.from({ length: channels }, () => new Float32Array(length)),
      copyToChannel(data, ch) { this._data[ch].set(data); },
      getChannelData(ch) { return this._data[ch]; },
    }),
    createBufferSource: () => mockNode({
      buffer: null, start: jest.fn(), stop: jest.fn(), onended: null,
    }),
    resume: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

/** A fake AudioBuffer (stereo) the bridge can load. */
function fakeAudioBuffer(length = 4800, channels = 2, sampleRate = 48000) {
  const data = Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length }, (_, i) => Math.sin(i / 10) * (c + 1) * 0.1));
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: length / sampleRate,
    getChannelData: (c) => data[c],
  };
}

describe('PlaybackMixer — Engineer Mode parity controls', () => {
  let mixer;
  beforeEach(() => { mixer = new PlaybackMixer({ context: mockContext() }); });

  test('graphic EQ exposes all 10 legacy bands, flat by default', () => {
    const names = ['sub', 'bass', 'warmth', 'body', 'lowMid', 'mid', 'presence', 'clarity', 'air', 'brilliance'];
    for (const n of names) {
      expect(mixer.graphicBands.get(n)).toBeDefined();
      expect(mixer.graphicBands.get(n).gain.value).toBe(0);
    }
  });

  test('setGraphicEq drives the right band and clamps to ±12 dB (idle snaps)', () => {
    mixer.setGraphicEq('presence', 5);
    expect(mixer.graphicBands.get('presence').gain.value).toBeCloseTo(5);
    mixer.setGraphicEq('presence', 99);
    expect(mixer.graphicBands.get('presence').gain.value).toBe(12);
    mixer.setGraphicEq('nope', 4); // unknown band → ignored, no throw
  });

  test('spectral tilt sets equal and opposite shelves', () => {
    mixer.setSpectralTilt(4);
    expect(mixer.tiltLow.gain.value).toBeCloseTo(-4);
    expect(mixer.tiltHigh.gain.value).toBeCloseTo(4);
    mixer.setSpectralTilt(99); // clamp to 6
    expect(mixer.tiltHigh.gain.value).toBe(6);
  });

  test('limiter is transparent until engaged, then 20:1', () => {
    expect(mixer.limiter.ratio.value).toBe(1);
    mixer.setLimiterThreshold(-3);
    expect(mixer.limiter.ratio.value).toBe(20);
    expect(mixer.limiter.threshold.value).toBeCloseTo(-3);
    mixer.setLimiterRelease(200);
    expect(mixer.limiter.release.value).toBeCloseTo(0.2);
  });

  test('output trim converts dB to linear gain', () => {
    mixer.setOutputGain(6);
    expect(mixer.outputTrim.gain.value).toBeCloseTo(Math.pow(10, 6 / 20));
    mixer.setOutputGain(0);
    expect(mixer.outputTrim.gain.value).toBeCloseTo(1);
  });

  test('dry/wet cross-fades the parallel taps', () => {
    expect(mixer.wetGain.gain.value).toBe(1);
    expect(mixer.dryGain.gain.value).toBe(0);
    mixer.setDryWet(30);
    expect(mixer.wetGain.gain.value).toBeCloseTo(0.3);
    expect(mixer.dryGain.gain.value).toBeCloseTo(0.7);
  });

  test('gate hold is tracked in gate params', () => {
    mixer.setGateHold(80);
    expect(mixer._gateParams.hold).toBe(80);
    mixer.setGateHold(9999); // clamp 0..500
    expect(mixer._gateParams.hold).toBe(500);
  });
});

describe('EngineerModeBridge', () => {
  let mixer;
  let bridge;
  beforeEach(() => {
    mixer = new PlaybackMixer({ context: mockContext() });
    bridge = new EngineerModeBridge({ mixer });
  });

  test('handles() / supportedIds() cover the rt slider set', () => {
    expect(EngineerModeBridge.handles('eqMid')).toBe(true);
    expect(EngineerModeBridge.handles('limThresh')).toBe(true);
    expect(EngineerModeBridge.handles('nrAmount')).toBe(false); // worker-targeted, not bridged
    expect(EngineerModeBridge.supportedIds().length).toBeGreaterThanOrEqual(30);
  });

  test('loadBuffer copies channels into the mixer as the clean stem', () => {
    bridge.loadBuffer(fakeAudioBuffer());
    expect(bridge.isLoaded()).toBe(true);
    expect(mixer.cleanBuffer).toBeTruthy();
    expect(mixer.noiseBuffer).toBeTruthy();
    expect(mixer.duration()).toBeCloseTo(4800 / 48000);
  });

  test('applyParam maps legacy ids to mixer setters', () => {
    const spies = {
      setGraphicEq: jest.spyOn(mixer, 'setGraphicEq'),
      setSpectralTilt: jest.spyOn(mixer, 'setSpectralTilt'),
      setLimiterThreshold: jest.spyOn(mixer, 'setLimiterThreshold'),
      setOutputGain: jest.spyOn(mixer, 'setOutputGain'),
      setDryWet: jest.spyOn(mixer, 'setDryWet'),
      setGateHold: jest.spyOn(mixer, 'setGateHold'),
      setGateRange: jest.spyOn(mixer, 'setGateRange'),
      setDeEsserAmount: jest.spyOn(mixer, 'setDeEsserAmount'),
      setStereoWidth: jest.spyOn(mixer, 'setStereoWidth'),
    };
    bridge.applyParam('eqAir', 3);
    expect(spies.setGraphicEq).toHaveBeenCalledWith('air', 3);
    bridge.applyParam('specTilt', -2);
    expect(spies.setSpectralTilt).toHaveBeenCalledWith(-2);
    bridge.applyParam('outGain', 5);
    expect(spies.setOutputGain).toHaveBeenCalledWith(5);
    bridge.applyParam('dryWet', 50);
    expect(spies.setDryWet).toHaveBeenCalledWith(50);
    bridge.applyParam('gateHold', 100);
    expect(spies.setGateHold).toHaveBeenCalledWith(100);
    bridge.applyParam('outWidth', 120);
    expect(spies.setStereoWidth).toHaveBeenCalledWith(120);
  });

  test('gate range converts legacy floor (−dB) to attenuation depth', () => {
    const spy = jest.spyOn(mixer, 'setGateRange');
    bridge.applyParam('gateRange', -60);
    expect(spy).toHaveBeenCalledWith(60);
  });

  test('de-esser amount converts 0–30 dB to 0–100 %', () => {
    const spy = jest.spyOn(mixer, 'setDeEsserAmount');
    bridge.applyParam('deEssAmt', 15);
    expect(spy).toHaveBeenCalledWith(50);
  });

  test('unsupported ids and non-finite values are ignored', () => {
    expect(bridge.applyParam('hpQ', 2)).toBe(false);       // stub, no mixer control
    expect(bridge.applyParam('nrAmount', 50)).toBe(false); // worker param
    expect(bridge.applyParam('eqMid', NaN)).toBe(false);   // non-finite
    expect(bridge.applyParam('eqMid', 4)).toBe(true);
  });

  test('applyParams applies a whole slider map', () => {
    const spy = jest.spyOn(mixer, 'setGraphicEq');
    bridge.applyParams({ eqBass: 2, eqMid: -3, hpQ: 1 });
    expect(spy).toHaveBeenCalledWith('bass', 2);
    expect(spy).toHaveBeenCalledWith('mid', -3);
  });
});
