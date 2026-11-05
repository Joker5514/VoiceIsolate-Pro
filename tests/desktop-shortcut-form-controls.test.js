/**
 * @jest-environment jsdom
 *
 * VoiceIsolate Pro — Desktop shortcuts leave form controls alone
 *
 * #873 narrowed the DesktopAdapter guard from "any input/textarea/select" to
 * isTextEntry(), so Space on a focused checkbox or radio ran play/pause and
 * preventDefault() swallowed the toggle, and the new 1-4 profile keys fired
 * from a focused slider (re-applying a preset over the rack). Real elements,
 * real KeyboardEvents, through the adapter's own window listener.
 */
/* global document, KeyboardEvent */
'use strict';

let DesktopAdapter;
beforeAll(async () => {
  ({ DesktopAdapter } = await import('../src/platform/desktop/DesktopAdapter.js'));
});

let calls;
let teardown;
beforeEach(() => {
  document.body.innerHTML = `
    <input type="checkbox" id="cb"><input type="radio" id="rd"><input type="range" id="rg">
    <input type="number" id="num"><input type="text" id="txt"><select id="sel"><option>a</option></select>
    <div id="ce" contenteditable="true"></div><div id="plain" tabindex="0"></div>`;
  calls = [];
  teardown = new DesktopAdapter({}, {}).setupKeyboardShortcuts({
    playPause: () => calls.push('playPause'),
    selectProfile: (p) => calls.push(`profile:${p}`),
    abToggle: () => calls.push('abToggle'),
  });
});
afterEach(() => teardown());

function press(id, key, code) {
  const ev = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
  document.getElementById(id).dispatchEvent(ev);
  return { handlers: calls.splice(0), prevented: ev.defaultPrevented };
}

describe('form controls keep their native keys', () => {
  test.each(['cb', 'rd', 'rg', 'num', 'txt', 'sel'])('Space on #%s is not hijacked', (id) => {
    expect(press(id, ' ', 'Space')).toEqual({ handlers: [], prevented: false });
  });

  test.each(['rg', 'num', 'txt', 'sel', 'cb'])('digit 2 on #%s does not switch profile', (id) => {
    expect(press(id, '2', 'Digit2')).toEqual({ handlers: [], prevented: false });
  });

  test('contenteditable is text entry too', () => {
    // jsdom does not implement isContentEditable; browsers derive it from the attribute.
    Object.defineProperty(document.getElementById('ce'), 'isContentEditable', { value: true });
    expect(press('ce', '1', 'Digit1')).toEqual({ handlers: [], prevented: false });
  });
});

describe('shortcuts still work outside form controls', () => {
  test('Space plays/pauses and is consumed', () => {
    expect(press('plain', ' ', 'Space')).toEqual({ handlers: ['playPause'], prevented: true });
  });

  test('1-4 select Quick, Meeting, Studio, Forensic', () => {
    const got = ['1', '2', '3', '4'].map((k) => press('plain', k, `Digit${k}`).handlers[0]);
    expect(got).toEqual(['profile:quick', 'profile:meeting', 'profile:studio', 'profile:forensic']);
  });

  test('X still toggles A/B from a focused slider (no native action there)', () => {
    expect(press('rg', 'x', 'KeyX').handlers).toEqual(['abToggle']);
  });
});
