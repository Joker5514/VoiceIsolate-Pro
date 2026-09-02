/** @jest-environment jsdom */
/* global document, HTMLCanvasElement */

let TimelineRenderer;

beforeAll(async () => {
  ({ TimelineRenderer } = await import('../src/presentation/TimelineRenderer.js'));
});

function createRenderer() {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: 640 });
  document.body.appendChild(container);

  const context = {
    setTransform: jest.fn(), clearRect: jest.fn(), fillRect: jest.fn(), fillText: jest.fn(),
    beginPath: jest.fn(), moveTo: jest.fn(), lineTo: jest.fn(), stroke: jest.fn(),
  };
  HTMLCanvasElement.prototype.getContext = jest.fn(() => context);
  HTMLCanvasElement.prototype.getBoundingClientRect = jest.fn(() => ({ left: 0, top: 0 }));

  return { renderer: new TimelineRenderer(container), context };
}

afterEach(() => {
  document.body.replaceChildren();
  jest.restoreAllMocks();
});

describe('TimelineRenderer input hardening', () => {
  test('renders tooltip metadata as text rather than executable markup', () => {
    const { renderer } = createRenderer();
    renderer.setAnalysis({
      duration: 10,
      visualLayers: [{
        id: 'speech',
        label: '<img src=x onerror="globalThis.timelineXss=true">',
        segments: [{ start: 1, end: 2, confidence: 0.8, meta: '<script>globalThis.timelineXss=true</script>' }],
      }],
    });

    renderer._showTip({ clientX: 10, clientY: 20 }, {
      layer: renderer.layers[0],
      segment: renderer.layers[0].segments[0],
      time: 1,
    });

    expect(renderer._tooltip.querySelector('img, script')).toBeNull();
    expect(renderer._tooltip.textContent).toContain('<img src=x');
    expect(renderer._tooltip.textContent).toContain('<script>');
  });

  test('normalizes non-finite timeline values before canvas operations', () => {
    const { renderer, context } = createRenderer();
    renderer.setAnalysis({
      duration: Number.NaN,
      visualLayers: [{
        id: 'noise',
        segments: [{ start: -Infinity, end: Infinity, confidence: 9 }],
      }],
    });
    renderer.setPlayhead(Infinity);

    expect(renderer.duration).toBe(1);
    expect(renderer.playhead).toBe(0);
    for (const call of context.fillRect.mock.calls) {
      expect(call.every(Number.isFinite)).toBe(true);
    }
  });

  test('treats a non-array visualLayers value as an empty analysis', () => {
    const { renderer } = createRenderer();
    expect(() => renderer.setAnalysis({ duration: 2, visualLayers: { length: 1 } })).not.toThrow();
    expect(renderer.layers).toEqual([]);
  });
});
