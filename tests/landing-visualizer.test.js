'use strict';

const { JSDOM } = require('jsdom');

describe('LandingVisualizer', () => {
  let dom;
  let LandingVisualizer;
  let mockMixer;

  function mock2dContext() {
    return {
      clearRect: jest.fn(),
      fillRect: jest.fn(),
      fillText: jest.fn(),
      stroke: jest.fn(),
      beginPath: jest.fn(),
      moveTo: jest.fn(),
      lineTo: jest.fn(),
      setLineDash: jest.fn(),
      createLinearGradient: () => ({ addColorStop: jest.fn() }),
      setTransform: jest.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      font: '',
      textAlign: '',
    };
  }

  beforeAll(async () => {
    dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      pretendToBeVisual: true,
      url: 'http://localhost/',
    });
    global.window = dom.window;
    global.document = dom.window.document;
    global.requestAnimationFrame = jest.fn(() => 1);
    global.cancelAnimationFrame = jest.fn();

    const ctx = mock2dContext();
    dom.window.HTMLCanvasElement.prototype.getContext = jest.fn(() => ctx);

    ({ LandingVisualizer } = await import('../src/presentation/LandingVisualizer.js'));
  });

  beforeEach(() => {
    const freqData = new Uint8Array(128);
    for (let i = 0; i < freqData.length; i++) freqData[i] = 128;
    mockMixer = {
      getAnalyser: () => ({
        frequencyBinCount: 128,
        getByteFrequencyData: (arr) => arr.set(freqData),
      }),
      currentTime: () => 0.5,
      isPlaying: () => true,
      seek: jest.fn().mockResolvedValue(undefined),
    };
  });

  function makeCanvas(id) {
    const c = document.createElement('canvas');
    c.id = id;
    c.style.width = '400px';
    c.style.height = '120px';
    document.body.appendChild(c);
    Object.defineProperty(c, 'clientWidth', { value: 400, configurable: true });
    Object.defineProperty(c, 'clientHeight', { value: 120, configurable: true });
    return c;
  }

  test('loads stems and starts animation loop', async () => {
    const wave = makeCanvas('wave');
    const spec = makeCanvas('spec');
    const viz = new LandingVisualizer(mockMixer, wave, spec);
    const clean = new Float32Array(4800);
    const noise = new Float32Array(4800);
    for (let i = 0; i < clean.length; i++) {
      clean[i] = Math.sin(i / 40) * 0.5;
      noise[i] = Math.cos(i / 60) * 0.2;
    }
    await viz.loadStems([clean], [noise], 1.0);
    expect(viz._envelope).not.toBeNull();
    expect(viz._duration).toBe(1.0);
    viz.dispose();
  });

  test('click-to-seek calls mixer.seek with proportional time', async () => {
    const wave = makeCanvas('wave2');
    const spec = makeCanvas('spec2');
    const viz = new LandingVisualizer(mockMixer, wave, spec);
    await viz.loadStems([new Float32Array(1000)], [new Float32Array(1000)], 10);
    wave.getBoundingClientRect = () => ({ left: 0, width: 400, top: 0, height: 120 });
    await viz._onWaveClick({ clientX: 200 });
    expect(mockMixer.seek).toHaveBeenCalledWith(5);
    viz.dispose();
  });

  test('dispose removes resize and interaction listeners', () => {
    const wave = makeCanvas('wave3');
    const spec = makeCanvas('spec3');
    const viz = new LandingVisualizer(mockMixer, wave, spec);
    const removeSpy = jest.spyOn(window, 'removeEventListener');
    viz.dispose();
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
    removeSpy.mockRestore();
  });
});