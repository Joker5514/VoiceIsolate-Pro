/**
 * @jest-environment jsdom
 *
 * Accessible Engineer Mode DspSlider factory + filter helpers.
 * UI-only: no DSP math, no worklet ports.
 */
'use strict';

/* global document, KeyboardEvent, MouseEvent */

let createDspSliderRow;
let clampSnap;
let buildAriaValueText;
let spokenUnit;
let sliderMatchesQuery;
let SLIDER_SEARCH_ALIASES;

beforeAll(async () => {
  const mod = await import('../src/presentation/DspSlider.js');
  createDspSliderRow = mod.createDspSliderRow;
  clampSnap = mod.clampSnap;
  buildAriaValueText = mod.buildAriaValueText;
  spokenUnit = mod.spokenUnit;
  sliderMatchesQuery = mod.sliderMatchesQuery;
  SLIDER_SEARCH_ALIASES = mod.SLIDER_SEARCH_ALIASES;
});

describe('clampSnap / aria helpers', () => {
  test('clampSnap respects min/max/step', () => {
    expect(clampSnap(12.4, 0, 100, 5)).toBe(10);
    expect(clampSnap(12.6, 0, 100, 5)).toBe(15);
    expect(clampSnap(-200, -120, 0, 5)).toBe(-120);
    expect(clampSnap(1.24, -24, 24, 0.5)).toBe(1);
  });

  test('buildAriaValueText includes label and spoken unit', () => {
    expect(buildAriaValueText('NR Amount', 18, 'dB')).toMatch(/NR Amount/);
    expect(buildAriaValueText('NR Amount', 18, 'dB')).toMatch(/18/);
    expect(buildAriaValueText('NR Amount', 18, 'dB')).toMatch(/decibel/i);
    expect(spokenUnit('%')).toBe('percent');
  });

  test('sliderMatchesQuery finds aliases', () => {
    expect(sliderMatchesQuery({
      id: 'nrAmount',
      label: 'NR Amount',
      aliases: ['denoise', 'snr'],
    }, 'denoise')).toBe(true);
    expect(sliderMatchesQuery({ id: 'nrAmount', label: 'NR Amount' }, 'zzz')).toBe(false);
    expect(sliderMatchesQuery({ id: 'x', label: 'X' }, '')).toBe(true);
  });

  test('shared alias dictionary covers core DSP terms', () => {
    expect(SLIDER_SEARCH_ALIASES.nrAmount).toEqual(expect.arrayContaining(['denoise', 'snr']));
    expect(SLIDER_SEARCH_ALIASES.derevAmt).toEqual(expect.arrayContaining(['de-reverb']));
  });
});

describe('createDspSliderRow', () => {
  /** @type {ReturnType<typeof createDspSliderRow>} */
  let widget;
  let changes;

  beforeEach(() => {
    document.body.innerHTML = '';
    changes = [];
    let locked = false;
    widget = createDspSliderRow({
      document,
      spec: {
        id: 'nrAmount',
        label: 'NR Amount',
        min: 0,
        max: 100,
        step: 5,
        val: 50,
        unit: '%',
        rt: false,
      },
      value: 50,
      isLocked: () => locked,
      onToggleLock: () => { locked = !locked; widget.setLocked(locked); },
      onChange: (id, value, meta) => {
        changes.push({ id, value, source: meta?.source });
      },
    });
    // expose lock flip for tests via widget
    widget._testSetLockedFlag = (v) => { locked = v; widget.setLocked(v); };
    document.body.appendChild(widget.row);
  });

  afterEach(() => {
    widget?.dispose?.();
  });

  test('renders label, range, number, reset, lock with ARIA', () => {
    expect(widget.row.dataset.sliderId).toBe('nrAmount');
    expect(widget.range.type).toBe('range');
    expect(widget.range.id).toBe('sl_nrAmount');
    expect(widget.range.dataset.sliderId).toBe('nrAmount');
    expect(widget.range.getAttribute('aria-label')).toBe('NR Amount');
    expect(widget.range.getAttribute('aria-valuemin')).toBe('0');
    expect(widget.range.getAttribute('aria-valuemax')).toBe('100');
    expect(widget.range.getAttribute('aria-valuenow')).toBe('50');
    expect(widget.range.getAttribute('aria-valuetext')).toMatch(/NR Amount/);
    expect(widget.number.type).toBe('number');
    expect(widget.number.id).toBe('val_nrAmount');
    expect(widget.lockBtn.getAttribute('aria-label')).toMatch(/Lock NR Amount/);
    expect(widget.resetBtn.getAttribute('aria-label')).toMatch(/Reset NR Amount/);
    expect(widget.row.querySelector('.sr-label')?.textContent).toMatch(/NR Amount/);
  });

  test('range input emits correct id/value', () => {
    widget.range.value = '75';
    widget.range.dispatchEvent(new Event('input', { bubbles: true }));
    expect(changes.at(-1)).toEqual({ id: 'nrAmount', value: 75, source: 'range' });
    expect(widget.number.value).toBe('75');
  });

  test('numeric field clamps and snaps', () => {
    widget.number.value = '73';
    widget.number.dispatchEvent(new Event('change', { bubbles: true }));
    expect(changes.at(-1).value).toBe(75);
  });

  test('PageUp/PageDown/Home/End keyboard steps', () => {
    widget.range.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    expect(widget.value).toBeGreaterThan(50);
    widget.setValue(50, { silent: true });
    widget.range.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(widget.value).toBe(0);
    widget.range.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(widget.value).toBe(100);
  });

  test('double-click resets to default', () => {
    widget.setValue(90, { silent: true });
    widget.range.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(widget.value).toBe(50);
  });

  test('locked rejects range, keyboard, number, and reset', () => {
    widget._testSetLockedFlag(true);
    changes = [];
    widget.range.value = '80';
    widget.range.dispatchEvent(new Event('input', { bubbles: true }));
    widget.number.value = '90';
    widget.number.dispatchEvent(new Event('change', { bubbles: true }));
    widget.range.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true }));
    widget.resetBtn.click();
    expect(changes).toHaveLength(0);
    expect(widget.value).toBe(50);
    expect(widget.range.getAttribute('aria-readonly')).toBe('true');
    expect(widget.resetBtn.disabled).toBe(true);
    expect(widget.lockBtn.getAttribute('aria-label')).toMatch(/Unlock/);
  });

  test('dispose removes listeners without throwing', () => {
    expect(() => widget.dispose()).not.toThrow();
  });
});
