/**
 * Browse-label taps must open the picker through the single hardened path.
 *
 * Randy (Nov 26): the upload button "is not clicking" on Stems and Engineer —
 * the tap is accepted but no file picker opens, no status change, no error.
 * Live repro: the Browse control is a <label for="fileInput"> nested inside
 * the drop-zone button (role="button"), with the file input itself nested
 * inside the zone on Stems; the input sits 1px at the viewport corner and
 * the browser reports it covered/unreachable. The tap therefore has two
 * competing activation paths — the label's native activation click and the
 * zone handler's programmatic fileInput.click() — and guardSinglePicker
 * arbitrates by swallowing the second one while openFilePicker still
 * reports success, so the button fails silently.
 *
 * @jest-environment jsdom
 */
'use strict';
/* global document, MouseEvent, Event, DOMParser */

const fs = require('fs');
const path = require('path');

let guardSinglePicker;
let openFilePicker;
beforeAll(async () => {
  ({ guardSinglePicker, openFilePicker } = await import('../src/presentation/UploadWiring.js'));
});

function stemsDom() {
  document.body.innerHTML = '<div id="uploadZone" role="button" tabindex="0">'
    + '<label for="fileInput" id="browseBtn">Browse files</label>'
    + '<input type="file" id="fileInput" accept="audio/*,video/*">'
    + '</div>';
  return {
    zone: document.getElementById('uploadZone'),
    label: document.getElementById('browseBtn'),
    input: document.getElementById('fileInput'),
  };
}

describe('openFilePicker reports a swallowed click', () => {
  test('a programmatic open right after a label activation is swallowed — and must report failure, not success', () => {
    const { input } = stemsDom();
    guardSinglePicker(input);
    // First tap: the label's native activation click reaches the input and
    // arms the single-picker guard (picker would open from this click).
    const first = new MouseEvent('click', { bubbles: true, cancelable: true });
    input.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(false);
    // A follow-up programmatic open inside the guard window is swallowed:
    // its click is cancelled, so no picker opens. openFilePicker must say
    // so instead of returning true for a picker that never opened.
    expect(openFilePicker(input)).toBe(false);
    // The guard is armed by a real label tap, not just a synthetic input click.
    const { label: label2, input: input2 } = stemsDom();
    guardSinglePicker(input2);
    label2.click();
    expect(openFilePicker(input2)).toBe(false);
  });

  test('a first programmatic open still reports success', () => {
    const { input } = stemsDom();
    guardSinglePicker(input);
    expect(openFilePicker(input)).toBe(true);
  });

  test('the control recovers after the picker reports back (cancel)', () => {
    const { label, input } = stemsDom();
    guardSinglePicker(input);
    label.click();
    expect(openFilePicker(input)).toBe(false);
    input.dispatchEvent(new Event('cancel'));
    expect(openFilePicker(input)).toBe(true);
  });
});

describe('file input is not nested inside the drop-zone button', () => {
  test('Stems: #fileInput is a sibling of #uploadZone, not a child', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const zone = doc.getElementById('uploadZone');
    const input = doc.getElementById('fileInput');
    expect(zone).not.toBeNull();
    expect(input).not.toBeNull();
    expect(zone.contains(input)).toBe(false);
    const label = doc.getElementById('browseBtn');
    expect(label && label.tagName).toBe('LABEL');
    expect(label && label.getAttribute('for')).toBe('fileInput');
  });

  test('Engineer: #fileInput stays outside #uploadZone', () => {
    const html = fs.readFileSync(path.join(__dirname, '../public/app/index.html'), 'utf8');
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const zone = doc.getElementById('uploadZone');
    const input = doc.getElementById('fileInput');
    expect(zone).not.toBeNull();
    expect(input).not.toBeNull();
    expect(zone.contains(input)).toBe(false);
    const label = doc.getElementById('fileBtn');
    expect(label && label.tagName).toBe('LABEL');
    expect(label && label.getAttribute('for')).toBe('fileInput');
  });
});

describe('zone handlers drive the Browse tap through the programmatic path', () => {
  test('Stems: a Browse click cancels the label native activation and opens the picker', () => {
    const landingJs = fs.readFileSync(path.join(__dirname, '../public/landing.js'), 'utf8');
    // No silent early-return that leaves the tap to the label's native
    // activation (which opens no picker nested inside the zone button).
    expect(landingJs).not.toContain(
      "if (event.target.closest('#browseBtn') || event.target.closest('#openDriveBtn')) return;"
    );
    expect(landingJs).toMatch(/closest\('#browseBtn'\)\) event\.preventDefault\(\);/);
    expect(landingJs).toMatch(/closest\('#browseBtn'\)\) event\.preventDefault\(\);[\s\S]*?openPickerSafely\(\)/);
  });

  test('Engineer: a Browse click cancels the label native activation and opens the picker', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
    expect(appJs).not.toContain("if (e.target.closest('#fileBtn')) return;");
    expect(appJs).toMatch(/closest\('#fileBtn'\)\) e\.preventDefault\(\);/);
    expect(appJs).toMatch(/closest\('#fileBtn'\)\) e\.preventDefault\(\);[\s\S]*?openFilePicker\(\)/);
  });
});
