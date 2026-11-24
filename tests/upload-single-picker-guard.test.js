/**
 * guardSinglePicker(): one file picker per gesture, never a stuck control.
 * @jest-environment jsdom
 */
'use strict';
/* global document, MouseEvent */

let guardSinglePicker; let PICKER_REOPEN_GUARD_MS;
beforeAll(async () => {
  ({ guardSinglePicker, PICKER_REOPEN_GUARD_MS } = await import('../src/presentation/UploadWiring.js'));
});

function setup() {
  document.body.innerHTML = '<label for="fileInput" id="b">Browse</label><input type="file" id="fileInput">';
  const input = document.getElementById('fileInput');
  let t = 1000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  expect(guardSinglePicker(input, { now: clock.now })).toBe(true);
  const activations = [];
  input.addEventListener('click', (e) => activations.push(e.defaultPrevented ? 'blocked' : 'open'));
  const click = () => { const e = new MouseEvent('click', { bubbles: true, cancelable: true }); input.dispatchEvent(e); return e.defaultPrevented; };
  return { input, clock, click, activations };
}

test('a second activation inside the window is cancelled and stops propagating', () => {
  const { clock, click, activations } = setup();
  expect(click()).toBe(false);
  clock.advance(120);
  expect(click()).toBe(true);
  expect(activations).toEqual(['open']);
});

test('change or cancel from the first picker re-arms the control at once', () => {
  const { input, clock, click } = setup();
  click(); clock.advance(50);
  input.dispatchEvent(new Event('cancel'));
  expect(click()).toBe(false);
  clock.advance(50);
  input.dispatchEvent(new Event('change'));
  expect(click()).toBe(false);
});

test('without a cancel event the guard expires, so the control never locks', () => {
  const { clock, click } = setup();
  click();
  clock.advance(PICKER_REOPEN_GUARD_MS - 1);
  expect(click()).toBe(true);
  clock.advance(2);
  expect(click()).toBe(false);
});

test('installing twice binds one guard; missing input is a no-op', () => {
  const { input } = setup();
  expect(guardSinglePicker(input)).toBe(true);
  expect(input.dataset.vipPickerGuard).toBe('1');
  expect(guardSinglePicker(null)).toBe(false);
});
