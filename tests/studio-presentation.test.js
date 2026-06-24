/**
 * @jest-environment jsdom
 */
'use strict';

let PlaybackMixer;
let PresetManager;
let DiagnosticsPanel;
let BatchProcessor;
let listPresets;

beforeAll(async () => {
  ({ PlaybackMixer } = await import('../src/pipeline/PlaybackMixer.js'));
  ({ PresetManager } = await import('../src/presentation/PresetManager.js'));
  ({ DiagnosticsPanel } = await import('../src/presentation/DiagnosticsPanel.js'));
  ({ BatchProcessor } = await import('../src/pipeline/BatchProcessor.js'));
  ({ listPresets } = await import('../src/core/StudioPresets.js'));
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
    createBiquadFilter: () => mockNode({
      type: '', frequency: mockParam(), gain: mockParam(), Q: mockParam(),
    }),
    createAnalyser: () => mockNode({ fftSize: 2048 }),
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

describe('PresetManager', () => {
  let mixer;

  beforeEach(() => {
    document.body.innerHTML = `
      <input id="noiseReductionSlider" value="10">
      <input id="voiceLevelSlider" value="20">
      <input id="volumeSlider" value="30">
      <input id="eqLowSlider" value="0">
      <input id="eqHighSlider" value="0">
    `;
    mixer = new PlaybackMixer({ context: mockContext() });
  });

  test('lists the eight built-in presets', () => {
    expect(listPresets()).toHaveLength(8);
  });

  test('applyPreset updates DOM sliders and mixer state', () => {
    const manager = new PresetManager(mixer, { document, storage: null });
    const preset = manager.applyPreset('forensic-extract');
    expect(preset.name).toBe('Forensic Extract');
    expect(document.getElementById('noiseReductionSlider').value).toBe('96');
    expect(document.getElementById('voiceLevelSlider').value).toBe('126');
  });

  test('saveCustomPreset captures current slider values and persists them', () => {
    const storage = {
      _value: null,
      getItem: jest.fn(() => null),
      setItem: jest.fn((key, value) => { storage._value = value; }),
    };
    const manager = new PresetManager(mixer, { document, storage });
    document.getElementById('noiseReductionSlider').value = '77';
    const preset = manager.saveCustomPreset('My Capture', 'Saved from UI');
    expect(preset.values.noiseReductionSlider).toBe(77);
    expect(storage.setItem).toHaveBeenCalled();
    expect(manager.listCustomPresets()).toHaveLength(1);
  });
});

describe('BatchProcessor', () => {
  test('runs queued files through ingestion and processing hooks', async () => {
    const ingest = jest.fn(async (file) => ({
      channelData: [new Float32Array(8)],
      sampleRate: 48000,
      duration: 1,
      numberOfChannels: 1,
      sourceName: file.name,
    }));
    const processFile = jest.fn(async ({ presetId, jobId }) => ({ presetId, jobId, ok: true }));
    const events = [];
    const batch = new BatchProcessor({
      concurrency: 1,
      ingestFile: ingest,
      processFile,
      onEvent: (type, payload) => events.push({ type, payload }),
    });

    batch.enqueue([{ name: 'a.wav' }, { name: 'b.wav' }], { presetId: 'voice-clarity' });
    const stats = await batch.run();

    expect(ingest).toHaveBeenCalledTimes(2);
    expect(processFile).toHaveBeenCalledTimes(2);
    expect(stats.done).toBe(2);
    expect(events.some((entry) => entry.type === 'job:done')).toBe(true);
  });
});

describe('DiagnosticsPanel', () => {
  test('captures mixer, batch, worker, and preset state', () => {
    const mixer = new PlaybackMixer({ context: mockContext() });
    mixer.loadSpeakerSegments([{ speakerId: 'S1', start: 0, end: 1 }]);
    const batchProcessor = { getStats: () => ({ total: 1, queued: 0, processing: 0, done: 1, errors: 0, paused: false }) };
    const panel = new DiagnosticsPanel(mixer, {
      document,
      batchProcessor,
      getWorkerState: () => ({ ml: 'ready', diarization: 'idle' }),
      getPresetState: () => ({ activePresetId: 'voice-clarity' }),
      getIngestionState: () => ({ sourceName: 'clip.wav', sampleRate: 48000 }),
    });
    panel.record('info', 'ready');
    const snap = panel.snapshot();
    expect(snap.audio.sampleRate).toBe(48000);
    expect(snap.audio.speakers).toEqual(['S1']);
    expect(snap.batch.done).toBe(1);
    expect(snap.presets.activePresetId).toBe('voice-clarity');
    expect(snap.logs).toHaveLength(1);
  });

  test('render writes a JSON snapshot into the container', () => {
    const mixer = new PlaybackMixer({ context: mockContext() });
    const panel = new DiagnosticsPanel(mixer, { document });
    const container = document.createElement('div');
    panel.render(container);
    expect(container.textContent).toContain('"audio"');
  });
});