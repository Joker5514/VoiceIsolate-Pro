'use strict';

let ExportEngine;
let PlaybackMixer;

beforeAll(async () => {
  ({ ExportEngine } = await import('../src/pipeline/ExportEngine.js'));
  ({ PlaybackMixer } = await import('../src/pipeline/PlaybackMixer.js'));
});

function mockParam() {
  return { value: 0, setTargetAtTime: jest.fn(), cancelScheduledValues: jest.fn() };
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
    createBiquadFilter: () => mockNode({ type: '', frequency: mockParam(), gain: mockParam() }),
    createAnalyser: () => mockNode({ fftSize: 2048 }),
    createBuffer: (channels, length, sampleRate) => ({
      numberOfChannels: channels,
      length,
      sampleRate,
      duration: length / sampleRate,
      _data: Array.from({ length: channels }, () => new Float32Array(length)),
      copyToChannel(data, ch) { this._data[ch].set(data); },
      getChannelData(ch) { return this._data[ch]; },
    }),
    createBufferSource: () => mockNode({ buffer: null, start: jest.fn(), stop: jest.fn(), onended: null }),
    resume: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

describe('ExportEngine', () => {
  test('exports mix/voice/noise WAV downloads', () => {
    const clicks = [];
    const appended = [];
    const removed = [];
    const document = {
      body: {
        appendChild: (node) => appended.push(node),
        removeChild: (node) => removed.push(node),
      },
      createElement: () => ({
        href: '',
        download: '',
        click: () => clicks.push(true),
      }),
    };
    const url = {
      createObjectURL: jest.fn(() => 'blob:vip'),
      revokeObjectURL: jest.fn(),
    };
    const engine = new ExportEngine({ document, url, now: () => 'now' });
    const payload = {
      sourceName: 'clip.wav',
      sampleRate: 48000,
      cleanChannels: [new Float32Array([0.25, -0.25])],
      noiseChannels: [new Float32Array([0.1, 0.2])],
    };

    const mix = engine.exportMix(payload);
    const voice = engine.exportVoice(payload);
    const noise = engine.exportNoise(payload);

    expect(mix.filename).toBe('clip-mix.wav');
    expect(voice.filename).toBe('clip-voice.wav');
    expect(noise.filename).toBe('clip-noise.wav');
    expect(clicks).toHaveLength(3);
    expect(appended).toHaveLength(3);
    expect(removed).toHaveLength(3);
    expect(url.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  test('PlaybackMixer exposes cloned stem channels for export', () => {
    const mixer = new PlaybackMixer({ context: mockContext() });
    const clean = [new Float32Array([0.1, 0.2])];
    const noise = [new Float32Array([0.3, 0.4])];
    mixer.loadStems(clean, noise, 48000);
    const stems = mixer.getStemChannels();
    expect(Array.from(stems.clean[0])).toEqual(Array.from(new Float32Array([0.1, 0.2])));
    expect(Array.from(stems.noise[0])).toEqual(Array.from(new Float32Array([0.3, 0.4])));
    expect(stems.clean[0]).not.toBe(clean[0]);
  });
});