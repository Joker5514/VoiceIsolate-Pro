'use strict';

const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
const workletInitJs = fs.readFileSync(path.join(__dirname, '../public/app/pipeline-orchestrator-worklet-init.js'), 'utf8');

function getSliderIds() {
  const slidersBlockMatch = appJs.match(/const SLIDERS = \{([\s\S]*?)\};\n\nconst SLIDER_MAP/);
  const slidersBlock = slidersBlockMatch ? slidersBlockMatch[1] : '';
  const sliderIdRegex = /id:'(\w+)'/g;
  const sliderIds = [];
  let m;
  while ((m = sliderIdRegex.exec(slidersBlock)) !== null) sliderIds.push(m[1]);
  return sliderIds;
}

describe('Worklet slider propagation', () => {
  test('all 52 sliders post params to AudioWorkletNode.port on input', async () => {
    const sliderIds = getSliderIds();
    expect(sliderIds).toHaveLength(52);

    const listeners = {};
    const elements = {};
    for (const id of sliderIds) {
      elements[id] = {
        id,
        value: '50',
        classList: { contains: (cls) => cls === 'realtime' },
        addEventListener: (type, cb) => { if (type === 'input') listeners[id] = cb; },
      };
    }

    const postMessage = jest.fn();
    class MockAudioWorkletNode {
      constructor() {
        this.port = { postMessage, start: jest.fn(), addEventListener: jest.fn() };
      }
      connect() {}
    }

    const windowMock = { _vipApp: { attachDspWorkletToVisuals: jest.fn() } };
    const documentMock = { getElementById: (id) => elements[id] || null };

    const fn = new Function(
      'window', 'document', 'AudioWorkletNode', 'SharedArrayBuffer', 'Float32Array',
      'Int32Array', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'console',
      workletInitJs
    );
    fn(windowMock, documentMock, MockAudioWorkletNode, SharedArrayBuffer, Float32Array,
      Int32Array, () => 1, () => {}, setTimeout, clearTimeout, console);

    await windowMock._workletInit.init({
      audioWorklet: { addModule: jest.fn().mockResolvedValue() },
      destination: { channelCount: 2 },
      sampleRate: 48000,
    });

    for (const id of sliderIds) listeners[id]();

    const paramPosts = postMessage.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg && msg.type === 'params' && Object.keys(msg.params || {}).length === 1);
    expect(paramPosts).toHaveLength(52);
  });

  test('non-realtime slider debounce is capped at 16ms', async () => {
    const setTimeoutSpy = jest.fn((cb) => {
      cb();
      return 1;
    });
    const clearTimeoutSpy = jest.fn();
    const postMessage = jest.fn();
    let inputHandler = null;

    const nonRtSlider = {
      id: 'slider-gate-lookahead',
      value: '10',
      classList: { contains: () => false },
      addEventListener: (type, cb) => { if (type === 'input') inputHandler = cb; },
    };

    class MockAudioWorkletNode {
      constructor() {
        this.port = { postMessage, start: jest.fn(), addEventListener: jest.fn() };
      }
      connect() {}
    }

    const windowMock = { _vipApp: { attachDspWorkletToVisuals: jest.fn() } };
    const documentMock = {
      getElementById: (id) => (id === 'slider-gate-lookahead' ? nonRtSlider : null),
    };

    const fn = new Function(
      'window', 'document', 'AudioWorkletNode', 'SharedArrayBuffer', 'Float32Array',
      'Int32Array', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'console',
      workletInitJs
    );
    fn(windowMock, documentMock, MockAudioWorkletNode, SharedArrayBuffer, Float32Array,
      Int32Array, () => 1, () => {}, setTimeoutSpy, clearTimeoutSpy, console);

    await windowMock._workletInit.init({
      audioWorklet: { addModule: jest.fn().mockResolvedValue() },
      destination: { channelCount: 2 },
      sampleRate: 48000,
    });

    expect(typeof inputHandler).toBe('function');
    inputHandler();

    expect(setTimeoutSpy).toHaveBeenCalled();
    expect(setTimeoutSpy.mock.calls[0][1]).toBeLessThanOrEqual(16);
  });
});
