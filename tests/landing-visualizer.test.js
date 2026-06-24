'use strict';

let LandingVisualizer;

beforeAll(async () => {
  ({ LandingVisualizer } = await import('../src/presentation/LandingVisualizer.js'));
});

function makeCanvas(width = 640, height = 120) {
  const calls = [];
  const ctx = {
    calls,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    clearRect: jest.fn(),
    fillRect: jest.fn((...args) => calls.push(['fillRect', ...args])),
    beginPath: jest.fn(),
    moveTo: jest.fn(),
    lineTo: jest.fn(),
    stroke: jest.fn(),
    fill: jest.fn(),
    fillText: jest.fn(),
    setLineDash: jest.fn(),
    setTransform: jest.fn(),
    createLinearGradient: jest.fn(() => ({ addColorStop: jest.fn() })),
    roundRect: jest.fn(),
    quadraticCurveTo: jest.fn(),
  };
  return {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    getContext: jest.fn(() => ctx),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    getBoundingClientRect: jest.fn(() => ({ left: 0, width })),
    _ctx: ctx,
  };
}

function makeMixer() {
  return {
    currentTime: jest.fn(() => 1.5),
    getAnalyser: jest.fn(() => ({
      frequencyBinCount: 128,
      getByteFrequencyData: (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = (i * 7) % 255;
      },
    })),
    isPlaying: jest.fn(() => true),
    seek: jest.fn(),
  };
}

describe('LandingVisualizer', () => {
  const originalWindow = global.window;
  const originalRAF = global.requestAnimationFrame;
  const originalCAF = global.cancelAnimationFrame;

  beforeEach(() => {
    global.window = {
      devicePixelRatio: 1,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    };
    global.requestAnimationFrame = jest.fn(() => 1);
    global.cancelAnimationFrame = jest.fn();
  });

  afterEach(() => {
    global.window = originalWindow;
    global.requestAnimationFrame = originalRAF;
    global.cancelAnimationFrame = originalCAF;
  });

  test('draws diarization timeline lanes when speaker segments are loaded', () => {
    const mixer = makeMixer();
    const wave = makeCanvas();
    const spec = makeCanvas();
    const diar = makeCanvas(640, 140);
    const viz = new LandingVisualizer(mixer, wave, spec, diar);

    viz.loadStems([new Float32Array(4800)], [new Float32Array(4800)], 6);
    viz.loadSpeakerSegments([
      { speakerId: 'S1', label: 'Speaker S1', start: 0.2, end: 1.4, confidence: 0.9 },
      { speakerId: 'S2', label: 'Speaker S2', start: 1.6, end: 2.8, confidence: 0.8 },
    ]);
    viz._drawTimeline();

    expect(diar._ctx.roundRect).toHaveBeenCalled();
    expect(diar._ctx.fillText).toHaveBeenCalledWith('S1', 8, expect.any(Number));
    expect(diar._ctx.stroke).toHaveBeenCalled();
  });

  test('accumulates spectrogram history for the pseudo-3D waterfall', () => {
    const mixer = makeMixer();
    const wave = makeCanvas();
    const spec = makeCanvas();
    const viz = new LandingVisualizer(mixer, wave, spec);

    viz.loadStems([new Float32Array(4800)], [new Float32Array(4800)], 6);
    viz._drawSpectrum();
    viz._drawSpectrum();

    expect(viz._spectrogram.length).toBe(2);
    expect(spec._ctx.fillRect).toHaveBeenCalled();
  });
});