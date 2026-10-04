/**
 * SourceAuditionEngine — derived layers are built on first audition.
 *
 * Measured in Chromium: building hum/residual/transient/ambience buffers
 * eagerly after auto-analysis blocked the main thread 1.7 s for a 2-minute
 * file, for layers most sessions never play.
 */
'use strict';

let SourceAuditionEngine;

beforeAll(async () => {
  global.requestAnimationFrame = () => 0;
  global.cancelAnimationFrame = () => {};
  ({ SourceAuditionEngine } = await import('../src/pipeline/SourceAuditionEngine.js'));
});

function buffer(length, sampleRate = 48000, fill = 0.1) {
  const data = [new Float32Array(length).fill(fill)];
  return {
    numberOfChannels: 1, length, sampleRate, duration: length / sampleRate,
    getChannelData: (c) => data[c],
  };
}

function ctx() {
  const node = () => ({ connect: jest.fn(), disconnect: jest.fn() });
  return {
    state: 'running',
    currentTime: 0,
    destination: node(),
    createBuffer: (ch, len, sr) => buffer(len, sr, 0),
    createGain: () => ({ ...node(), gain: { value: 1, setValueAtTime: jest.fn() } }),
    createStereoPanner: () => ({ ...node(), pan: { value: 0 } }),
    createBufferSource: () => ({ ...node(), start: jest.fn(), stop: jest.fn(), buffer: null, onended: null }),
    resume: jest.fn(),
  };
}

afterAll(() => {
  delete global.requestAnimationFrame;
  delete global.cancelAnimationFrame;
});

test('buildFromAnalysis registers derived layers without computing them', () => {
  const engine = new SourceAuditionEngine();
  const spies = ['_residualBuffer', '_extractHumBuffer', '_extractTransientBuffer', '_extractAmbienceBuffer']
    .map((m) => jest.spyOn(engine, m));
  const original = buffer(48000 * 3);
  engine.buildFromAnalysis({ original, clean: buffer(48000 * 3, 48000, 0.05), noise: buffer(48000 * 3, 48000, 0.02), analysis: {} }, ctx());
  spies.forEach((s) => expect(s).not.toHaveBeenCalled());
  const states = engine.getLayerStates();
  for (const id of ['music', 'hum', 'transients', 'ambience']) {
    expect(states.find((s) => s.id === id)?.hasBuffer).toBe(true);
  }
  expect(engine._duration).toBeCloseTo(3, 6);
});

test('playing a soloed layer builds only that layer, once', async () => {
  const engine = new SourceAuditionEngine();
  const hum = jest.spyOn(engine, '_extractHumBuffer');
  const trans = jest.spyOn(engine, '_extractTransientBuffer');
  engine.buildFromAnalysis({ original: buffer(4800), clean: buffer(4800), noise: buffer(4800), analysis: {} }, ctx());
  engine.setMode('layer');
  for (const L of engine.layers.values()) L.solo = L.id === 'hum';
  await engine.play(0);
  await engine.play(0);
  expect(hum).toHaveBeenCalledTimes(1);
  expect(trans).not.toHaveBeenCalled();
  expect(engine.layers.get('hum').buffer.length).toBe(4800);
});

test('replacing a lazy layer with a concrete buffer drops the pending build', () => {
  const engine = new SourceAuditionEngine();
  engine.buildFromAnalysis({ original: buffer(4800), clean: buffer(4800), noise: buffer(4800), analysis: {} }, ctx());
  const replacement = buffer(100);
  engine.setLayer({ id: 'hum', buffer: replacement });
  const hum = jest.spyOn(engine, '_extractHumBuffer');
  expect(engine._ensureBuffer(engine.layers.get('hum'))).toBe(replacement);
  expect(hum).not.toHaveBeenCalled();
});
