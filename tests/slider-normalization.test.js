'use strict';
let normalizeSliderValue;
beforeAll(async () => ({ normalizeSliderValue } = await import('../src/presentation/DspSlider.js')));

test.each([
  [0.707, { min: 0.5, max: 10, step: 0.5, default: 0.5 }, 0.5],
  [0.76, { min: 0.5, max: 10, step: 0.5 }, 1],
  [-23.37, { min: -60, max: 0, step: 0.5 }, -23.5],
  [0.30000000004, { min: 0, max: 1, step: 0.1 }, 0.3],
  ['bad', { min: 0, max: 100, step: 5, default: 35 }, 35],
])('normalizes %p against %p to %p', (raw, spec, expected) => {
  expect(normalizeSliderValue(raw, spec)).toBe(expected);
});
