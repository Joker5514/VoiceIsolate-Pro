/**
 * VoiceIsolate Pro — app.js Utility Function Tests (v24 PR changes)
 *
 * Tests the new/changed utility functions added to public/app/app.js in v24:
 *   1. structuredLog() — debug gating: info/debug logs suppressed unless
 *      window.VIP_DEBUG is truthy; errors/warns always surface.
 *   2. SLIDER_BY_ID — flat lookup map derived from SLIDERS.
 *   3. clampToSlider() — clamps a value to slider min/max, falls back on NaN.
 *   4. numFromInput() — parses a numeric input element value with fallback.
 *
 * Because app.js is a browser ES module, all tests use source-inspection and
 * direct function re-implementation (same pattern as dsp-core.test.js).
 *
 * @jest-environment node
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const appSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/app.js'),
  'utf8'
);

// ── Re-implemented functions from app.js (mirrors exact logic) ────────────────

// structuredLog — re-implemented to run in Node (window is simulated)
function makeStructuredLog(windowObj) {
  return function structuredLog(level, msg, data = {}) {
    const entry = { ts: new Date().toISOString(), level, msg, ...data };
    const debugEnabled = (typeof windowObj !== 'undefined') && !!windowObj.VIP_DEBUG;
    if (level === 'error') console.error('[VIP]', msg, data);
    else if (level === 'warn') console.warn('[VIP]', msg, data);
    else if (debugEnabled) console.log('[VIP]', msg, data);
    if (typeof windowObj !== 'undefined') {
      if (!windowObj._vipLogs) windowObj._vipLogs = [];
      if (windowObj._vipLogs.length >= 200) windowObj._vipLogs.shift();
      windowObj._vipLogs.push(entry);
    }
    return entry;
  };
}

// Minimal SLIDERS definitions for clampToSlider tests
const TEST_SLIDERS = {
  gate: [
    { id: 'gateThresh', min: -80, max: -5, val: -55, step: 1 },
  ],
  nr: [
    { id: 'nrAmount', min: 0, max: 100, val: 78, step: 1 },
  ],
};

// SLIDER_BY_ID — mirrors app.js
const SLIDER_BY_ID = Object.freeze(
  Object.values(TEST_SLIDERS).flat().reduce((acc, s) => { acc[s.id] = s; return acc; }, {})
);

// clampToSlider — re-implemented from app.js
function clampToSlider(id, value) {
  const s = SLIDER_BY_ID[id];
  const v = Number(value);
  if (!Number.isFinite(v)) return s ? s.val : 0;
  if (!s) return v;
  if (v < s.min) return s.min;
  if (v > s.max) return s.max;
  return v;
}

// numFromInput — re-implemented from app.js
function numFromInput(el, fallback = 0) {
  if (!el) return fallback;
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
}

// ── structuredLog() — debug gating (v24 change) ───────────────────────────────
describe('structuredLog() — v24 debug gating', () => {
  test('always calls console.error for level="error"', () => {
    const win = {};
    const structuredLog = makeStructuredLog(win);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    structuredLog('error', 'test error', {});
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('always calls console.warn for level="warn"', () => {
    const win = {};
    const structuredLog = makeStructuredLog(win);
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    structuredLog('warn', 'test warning', {});
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('does NOT call console.log for info level when VIP_DEBUG is falsy', () => {
    const win = { VIP_DEBUG: false };
    const structuredLog = makeStructuredLog(win);
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    structuredLog('info', 'silent info', {});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('does NOT call console.log for debug level when VIP_DEBUG is absent', () => {
    const win = {};  // no VIP_DEBUG property
    const structuredLog = makeStructuredLog(win);
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    structuredLog('debug', 'silent debug', {});
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('calls console.log for info level when VIP_DEBUG is truthy', () => {
    const win = { VIP_DEBUG: true };
    const structuredLog = makeStructuredLog(win);
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    structuredLog('info', 'visible info', {});
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('calls console.log for any non-error non-warn level when VIP_DEBUG=1', () => {
    const win = { VIP_DEBUG: 1 };
    const structuredLog = makeStructuredLog(win);
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    structuredLog('trace', 'trace msg', {});
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('appends entries to window._vipLogs', () => {
    const win = {};
    const structuredLog = makeStructuredLog(win);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    structuredLog('warn', 'log test', { x: 1 });
    jest.restoreAllMocks();
    expect(win._vipLogs).toBeDefined();
    expect(win._vipLogs.length).toBe(1);
    expect(win._vipLogs[0].msg).toBe('log test');
  });

  test('_vipLogs entries include ts, level, msg fields', () => {
    const win = {};
    const structuredLog = makeStructuredLog(win);
    jest.spyOn(console, 'error').mockImplementation(() => {});
    structuredLog('error', 'check fields', { detail: 'abc' });
    jest.restoreAllMocks();
    const entry = win._vipLogs[0];
    expect(typeof entry.ts).toBe('string');
    expect(entry.level).toBe('error');
    expect(entry.msg).toBe('check fields');
    expect(entry.detail).toBe('abc');
  });

  test('_vipLogs caps at 200 entries (oldest entry is shifted)', () => {
    const win = {};
    const structuredLog = makeStructuredLog(win);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    for (let i = 0; i < 202; i++) {
      structuredLog('error', `msg ${i}`, {});
    }
    errSpy.mockRestore();
    expect(win._vipLogs.length).toBe(200);
    // The oldest (msg 0, msg 1) should have been shifted out
    expect(win._vipLogs[0].msg).toBe('msg 2');
    expect(win._vipLogs[199].msg).toBe('msg 201');
  });

  test('does not crash when window is undefined', () => {
    // Pass undefined as the window object to simulate server-side
    const structuredLog = makeStructuredLog(undefined);
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => structuredLog('error', 'no window', {})).not.toThrow();
    errSpy.mockRestore();
  });

  test('app.js source checks typeof window !== undefined before accessing _vipLogs', () => {
    expect(appSrc).toContain("typeof window !== 'undefined'");
  });

  test('app.js source checks VIP_DEBUG before calling console.log', () => {
    expect(appSrc).toContain('VIP_DEBUG');
    expect(appSrc).toContain('debugEnabled');
  });
});

// ── clampToSlider() (v24 new function) ────────────────────────────────────────
describe('clampToSlider()', () => {
  test('returns value unchanged when within range', () => {
    expect(clampToSlider('nrAmount', 50)).toBe(50);
  });

  test('clamps to min when value is below min', () => {
    // nrAmount min=0
    expect(clampToSlider('nrAmount', -10)).toBe(0);
  });

  test('clamps to max when value is above max', () => {
    // nrAmount max=100
    expect(clampToSlider('nrAmount', 150)).toBe(100);
  });

  test('returns exactly min for value equal to min', () => {
    expect(clampToSlider('nrAmount', 0)).toBe(0);
  });

  test('returns exactly max for value equal to max', () => {
    expect(clampToSlider('nrAmount', 100)).toBe(100);
  });

  test('returns s.val for NaN input (known slider)', () => {
    // nrAmount val=78
    expect(clampToSlider('nrAmount', NaN)).toBe(78);
  });

  test('returns s.val for Infinity input (known slider)', () => {
    expect(clampToSlider('nrAmount', Infinity)).toBe(78);
  });

  test('returns s.val for -Infinity input (known slider)', () => {
    expect(clampToSlider('nrAmount', -Infinity)).toBe(78);
  });

  test('returns 0 for NaN input when slider ID is unknown', () => {
    expect(clampToSlider('unknownSlider', NaN)).toBe(0);
  });

  test('returns the numeric value unchanged for unknown slider ID (no clamping)', () => {
    expect(clampToSlider('unknownSlider', 42)).toBe(42);
  });

  test('coerces string numbers to numeric values', () => {
    expect(clampToSlider('nrAmount', '50')).toBe(50);
  });

  test('clamps string number below min', () => {
    expect(clampToSlider('nrAmount', '-5')).toBe(0);
  });

  test('returns 0 for string "NaN" (non-numeric)', () => {
    expect(clampToSlider('unknownSlider', 'NaN')).toBe(0);
  });

  test('gateThresh clamping: below min (-80) → -80', () => {
    // gateThresh min=-80 max=-5 val=-55
    expect(clampToSlider('gateThresh', -100)).toBe(-80);
  });

  test('gateThresh clamping: above max (-5) → -5', () => {
    expect(clampToSlider('gateThresh', 0)).toBe(-5);
  });

  test('gateThresh within range unchanged', () => {
    expect(clampToSlider('gateThresh', -30)).toBe(-30);
  });

  test('app.js source defines SLIDER_BY_ID as Object.freeze(…)', () => {
    expect(appSrc).toContain('SLIDER_BY_ID = Object.freeze(');
  });

  test('app.js source defines clampToSlider function', () => {
    expect(appSrc).toContain('function clampToSlider(');
  });
});

// ── numFromInput() (v24 new function) ─────────────────────────────────────────
describe('numFromInput()', () => {
  test('returns the numeric value of el.value', () => {
    const el = { value: '42.5' };
    expect(numFromInput(el)).toBe(42.5);
  });

  test('returns fallback (0) when el is null', () => {
    expect(numFromInput(null)).toBe(0);
  });

  test('returns fallback (0) when el is undefined', () => {
    expect(numFromInput(undefined)).toBe(0);
  });

  test('returns fallback when el.value is empty string', () => {
    const el = { value: '' };
    expect(numFromInput(el)).toBe(0);
  });

  test('returns fallback when el.value is non-numeric', () => {
    const el = { value: 'abc' };
    expect(numFromInput(el)).toBe(0);
  });

  test('returns fallback when el.value is NaN string', () => {
    const el = { value: 'NaN' };
    expect(numFromInput(el)).toBe(0);
  });

  test('returns custom fallback when provided', () => {
    expect(numFromInput(null, -99)).toBe(-99);
  });

  test('returns custom fallback for non-numeric input', () => {
    const el = { value: 'x' };
    expect(numFromInput(el, 1)).toBe(1);
  });

  test('handles integer string correctly', () => {
    const el = { value: '100' };
    expect(numFromInput(el)).toBe(100);
  });

  test('handles negative value correctly', () => {
    const el = { value: '-55' };
    expect(numFromInput(el)).toBe(-55);
  });

  test('handles float with leading dot', () => {
    const el = { value: '.5' };
    expect(numFromInput(el)).toBe(0.5);
  });

  test('handles value "0" (falsy but valid)', () => {
    const el = { value: '0' };
    expect(numFromInput(el)).toBe(0);
  });

  test('app.js source defines numFromInput function', () => {
    expect(appSrc).toContain('function numFromInput(');
  });

  test('app.js registers numFromInput on window when available', () => {
    expect(appSrc).toContain('window.numFromInput = numFromInput');
  });
});

// ── SLIDER_BY_ID (v24: new flat lookup object) ────────────────────────────────
describe('SLIDER_BY_ID (v24 flat slider lookup)', () => {
  test('app.js source defines SLIDER_BY_ID', () => {
    expect(appSrc).toContain('SLIDER_BY_ID');
  });

  test('app.js SLIDER_BY_ID is built from Object.values(SLIDERS).flat()', () => {
    expect(appSrc).toContain('Object.values(SLIDERS).flat()');
  });

  test('built SLIDER_BY_ID has at least one known slider ID', () => {
    // Our re-implemented test version has nrAmount and gateThresh
    expect(SLIDER_BY_ID).toHaveProperty('nrAmount');
    expect(SLIDER_BY_ID).toHaveProperty('gateThresh');
  });

  test('SLIDER_BY_ID maps slider id to slider definition object', () => {
    expect(SLIDER_BY_ID['nrAmount']).toMatchObject({ id: 'nrAmount', min: 0, max: 100 });
  });

  test('SLIDER_BY_ID is frozen (immutable)', () => {
    // Attempting to add a property should silently fail (strict mode) or be a no-op
    const original = SLIDER_BY_ID['nrAmount'];
    SLIDER_BY_ID['newProp'] = 'test';
    expect(SLIDER_BY_ID['newProp']).toBeUndefined();
    expect(SLIDER_BY_ID['nrAmount']).toBe(original);
  });
});

// ── applyPreset clampToSlider integration (v24 change) ────────────────────────
describe('applyPreset uses clampToSlider for clamping (source inspection)', () => {
  test('app.js source calls clampToSlider within applyPreset', () => {
    expect(appSrc).toContain('clampToSlider(sliderId, rawValue)');
  });

  test('app.js source checks SLIDER_BY_ID[sliderId] before clamping', () => {
    expect(appSrc).toContain('SLIDER_BY_ID[sliderId]');
  });

  test('app.js applyPreset uses rawValue variable (not value)', () => {
    // v24 renamed value → rawValue in the for loop to clarify that clamping happens next
    const applyPresetSrc = appSrc.slice(appSrc.indexOf('applyPreset(name)'));
    expect(applyPresetSrc.slice(0, 500)).toContain('rawValue');
  });
});