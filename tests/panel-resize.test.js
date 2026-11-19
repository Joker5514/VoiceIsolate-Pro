/**
 * @jest-environment jsdom
 *
 * Resizable Engineer Console rack panels (PanelResize.js).
 * Handles on each slider-group section resize that block's height
 * independently and the shared rack column width; sizes persist per block
 * in localStorage and reset to defaults. CSS is asserted through the real
 * CSSOM (parsed stylesheet), never by substring-matching CSS text.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RACK_FIXTURE = `
<div class="ec-col-rack">
  <nav class="ec-rack-nav"></nav>
  <details class="vip-section" id="section-presets" open>
    <summary>Presets</summary>
    <div class="vip-section-body">
      <div class="presets-wrap"></div>
      <details class="vip-section slider-group" id="section-gate" open>
        <summary>Gate<span>Noise gate</span></summary>
        <div class="slider-group-content vip-section-body"><div class="slider-panel"></div></div>
      </details>
      <details class="vip-section slider-group" id="section-eq">
        <summary>EQ (10 bands)</summary>
        <div class="slider-group-content vip-section-body"><div class="slider-panel"></div></div>
      </details>
      <details class="vip-section slider-group" id="section-dynamics">
        <summary>Dynamics</summary>
        <div class="slider-group-content vip-section-body"><div class="slider-panel"></div></div>
      </details>
      <details class="vip-section slider-group" id="tab-extreme-group">
        <summary>Whisper Mode</summary>
        <div class="slider-group-content vip-section-body"><div class="slider-panel"></div></div>
      </details>
    </div>
  </details>
</div>`;

function mapStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
    _store: store,
  };
}

function stubMatchMedia(win, matches) {
  win.matchMedia = (query) => ({
    matches,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
  });
}

describe('clamps (pure)', () => {
  let PanelResize;
  beforeAll(async () => {
    PanelResize = await import('../src/presentation/PanelResize.js');
  });

  test('panel height clamps to 120px .. 90vh', () => {
    expect(PanelResize.clampPanelHeight(50, 800)).toBe(120);
    expect(PanelResize.clampPanelHeight(400, 800)).toBe(400);
    expect(PanelResize.clampPanelHeight(5000, 800)).toBe(720);
    expect(PanelResize.clampPanelHeight(5000, 560)).toBe(504);
    expect(PanelResize.clampPanelHeight(NaN, 800)).toBe(120);
    expect(PanelResize.clampPanelHeight(Infinity, 800)).toBe(720);
  });

  test('rack width clamps to 300px .. 900px and keeps >=900px for session + stage', () => {
    expect(PanelResize.clampRackWidth(100, 1920)).toBe(300);
    expect(PanelResize.clampRackWidth(700, 1920)).toBe(700);
    expect(PanelResize.clampRackWidth(2000, 1920)).toBe(900);
    // 1440px viewport: at most 1440 - 900 = 540px of rack.
    expect(PanelResize.clampRackWidth(700, 1440)).toBe(540);
    // 1280px viewport: at most 380px.
    expect(PanelResize.clampRackWidth(700, 1280)).toBe(380);
    // Narrow viewport: the 300px floor wins, never below it.
    expect(PanelResize.clampRackWidth(700, 1100)).toBe(300);
    expect(PanelResize.clampRackWidth(NaN, 1920)).toBe(300);
    expect(PanelResize.clampRackWidth(Infinity, 1920)).toBe(900);
    expect(PanelResize.clampRackWidth(Infinity, 1440)).toBe(540);
  });
});

describe('panel-size storage', () => {
  let UiPersistence;
  beforeAll(async () => {
    UiPersistence = await import('../src/core/UiPersistence.js');
  });

  test('sizes round-trip through storage', () => {
    const storage = mapStorage();
    const sizes = { rackW: 640, heights: { 'section-gate': 480, 'section-eq': 300 } };
    expect(UiPersistence.writeStoredPanelSizes(sizes, storage)).toBe(true);
    expect(UiPersistence.readStoredPanelSizes(storage)).toEqual(sizes);
  });

  test('malformed or junk values fall back to empty defaults', () => {
    const storage = mapStorage();
    storage.setItem(UiPersistence.PANEL_SIZES_KEY, 'not-json{');
    expect(UiPersistence.readStoredPanelSizes(storage)).toEqual({ rackW: null, heights: {} });
    storage.setItem(UiPersistence.PANEL_SIZES_KEY, JSON.stringify({
      rackW: 'wide', heights: { 'section-gate': -5, 'section-eq': 'tall', ok: 200 },
    }));
    expect(UiPersistence.readStoredPanelSizes(storage)).toEqual({ rackW: null, heights: { ok: 200 } });
    expect(UiPersistence.readStoredPanelSizes(mapStorage())).toEqual({ rackW: null, heights: {} });
  });

  test('a failing storage backend never throws', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(UiPersistence.readStoredPanelSizes(broken)).toEqual({ rackW: null, heights: {} });
    expect(UiPersistence.writeStoredPanelSizes({ rackW: 500, heights: {} }, broken)).toBe(false);
  });
});

describe('PanelResize wiring', () => {
  let PanelResize;
  let UiPersistence;
  let document;
  let window;
  let storage;
  let controller;

  beforeAll(async () => {
    PanelResize = await import('../src/presentation/PanelResize.js');
    UiPersistence = await import('../src/core/UiPersistence.js');
  });

  beforeEach(() => {
    document = globalThis.document;
    window = globalThis.window;
    document.body.innerHTML = RACK_FIXTURE;
    Object.defineProperty(window, 'innerWidth', { value: 1920, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    stubMatchMedia(window, true);
    storage = mapStorage();
    controller = null;
  });

  afterEach(() => {
    if (controller) controller.destroy();
    document.body.innerHTML = '';
    document.documentElement.style.cssText = '';
  });

  function init() {
    controller = PanelResize.initPanelResize({ document, window, storage });
    return controller;
  }

  function section(id) {
    return document.getElementById(id);
  }

  function handles(id, kind) {
    return section(id).querySelector(`:scope > .vip-panel-resize-handle--${kind}`);
  }

  function drag(handle, fromX, fromY, toX, toY) {
    handle.dispatchEvent(new window.MouseEvent('pointerdown', {
      bubbles: true, button: 0, clientX: fromX, clientY: fromY,
    }));
    window.dispatchEvent(new window.MouseEvent('pointermove', {
      bubbles: true, clientX: toX, clientY: toY,
    }));
    window.dispatchEvent(new window.MouseEvent('pointerup', {
      bubbles: true, clientX: toX, clientY: toY,
    }));
  }

  function key(handle, keyName, shift = false) {
    handle.dispatchEvent(new window.KeyboardEvent('keydown', {
      bubbles: true, cancelable: true, key: keyName, shiftKey: shift,
    }));
  }

  test('every slider-group section gets a height and a width handle; presets itself gets none', () => {
    init();
    for (const id of ['section-gate', 'section-eq', 'section-dynamics', 'tab-extreme-group']) {
      expect(handles(id, 'height')).not.toBeNull();
      expect(handles(id, 'width')).not.toBeNull();
    }
    expect(section('section-presets').querySelector(':scope > .vip-panel-resize-handle')).toBeNull();
    expect(document.getElementById('vipPanelReset')).not.toBeNull();
  });

  test('handles are keyboard-reachable sliders with labels and bounds', () => {
    init();
    const height = handles('section-gate', 'height');
    expect(height.getAttribute('role')).toBe('slider');
    expect(height.getAttribute('tabindex')).toBe('0');
    expect(height.getAttribute('aria-label')).toMatch(/Gate/);
    expect(height.getAttribute('aria-orientation')).toBe('vertical');
    expect(height.getAttribute('aria-valuemin')).toBe('120');
    expect(height.getAttribute('aria-valuemax')).toBe('810'); // 90% of 900px viewport height
    const width = handles('section-gate', 'width');
    expect(width.getAttribute('role')).toBe('slider');
    expect(width.getAttribute('aria-orientation')).toBe('horizontal');
    expect(width.getAttribute('aria-label')).toMatch(/shared by all panels/);
    expect(width.getAttribute('aria-valuemin')).toBe('300');
    expect(width.getAttribute('aria-valuemax')).toBe('900');
  });

  test('dragging a height handle resizes only that block and persists it', () => {
    init();
    // JSDOM measures no layout, so the unset start height is the 320px fallback.
    drag(handles('section-gate', 'height'), 0, 100, 0, 300);
    expect(section('section-gate').style.getPropertyValue('--vip-panel-h')).toBe('520px');
    expect(section('section-gate').dataset.vipSized).toBe('1');
    expect(handles('section-gate', 'height').getAttribute('aria-valuenow')).toBe('520');
    expect(section('section-eq').style.getPropertyValue('--vip-panel-h')).toBe('');
    expect(section('section-dynamics').style.getPropertyValue('--vip-panel-h')).toBe('');
    expect(UiPersistence.readStoredPanelSizes(storage).heights['section-gate']).toBe(520);
    expect(UiPersistence.readStoredPanelSizes(storage).heights['section-eq']).toBeUndefined();
  });

  test('dragging a width handle resizes the shared rack column, not any block height', () => {
    init();
    drag(handles('section-eq', 'width'), 300, 0, 500, 0);
    expect(document.documentElement.style.getPropertyValue('--vip-rack-w')).toBe('540px');
    expect(handles('section-eq', 'width').getAttribute('aria-valuenow')).toBe('540');
    for (const id of ['section-gate', 'section-eq', 'section-dynamics', 'tab-extreme-group']) {
      expect(section(id).style.getPropertyValue('--vip-panel-h')).toBe('');
    }
    expect(UiPersistence.readStoredPanelSizes(storage).rackW).toBe(540);
  });

  test('dragging past the limits clamps instead of overflowing', () => {
    init();
    drag(handles('section-gate', 'height'), 0, 100, 0, 9100);
    expect(section('section-gate').style.getPropertyValue('--vip-panel-h')).toBe('810px');
    drag(handles('section-gate', 'width'), 300, 0, 9300, 0);
    expect(document.documentElement.style.getPropertyValue('--vip-rack-w')).toBe('900px');
    drag(handles('section-gate', 'height'), 0, 810, 0, -9100);
    expect(section('section-gate').style.getPropertyValue('--vip-panel-h')).toBe('120px');
  });

  test('stored sizes are restored on init', () => {
    UiPersistence.writeStoredPanelSizes(
      { rackW: 640, heights: { 'section-gate': 480, 'section-dynamics': 260 } },
      storage,
    );
    init();
    expect(document.documentElement.style.getPropertyValue('--vip-rack-w')).toBe('640px');
    expect(section('section-gate').style.getPropertyValue('--vip-panel-h')).toBe('480px');
    expect(section('section-dynamics').style.getPropertyValue('--vip-panel-h')).toBe('260px');
    expect(section('section-eq').style.getPropertyValue('--vip-panel-h')).toBe('');
  });

  test('double-click resets one dimension; the reset button resets everything', () => {
    init();
    drag(handles('section-gate', 'height'), 0, 100, 0, 300);
    drag(handles('section-gate', 'width'), 300, 0, 500, 0);
    expect(UiPersistence.readStoredPanelSizes(storage)).toEqual({
      rackW: 540, heights: { 'section-gate': 520 },
    });
    handles('section-gate', 'height').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    expect(section('section-gate').style.getPropertyValue('--vip-panel-h')).toBe('');
    expect(section('section-gate').dataset.vipSized).toBeUndefined();
    expect(UiPersistence.readStoredPanelSizes(storage)).toEqual({ rackW: 540, heights: {} });
    // The rack width survives a single-block reset.
    expect(document.documentElement.style.getPropertyValue('--vip-rack-w')).toBe('540px');
    document.getElementById('vipPanelReset').click();
    expect(document.documentElement.style.getPropertyValue('--vip-rack-w')).toBe('');
    expect(UiPersistence.readStoredPanelSizes(storage)).toEqual({ rackW: null, heights: {} });
  });

  test('arrow keys resize; Home/End jump to the limits', () => {
    init();
    const height = handles('section-gate', 'height');
    key(height, 'ArrowDown');
    expect(section('section-gate').style.getPropertyValue('--vip-panel-h')).toBe('336px');
    key(height, 'ArrowDown', true);
    expect(section('section-gate').style.getPropertyValue('--vip-panel-h')).toBe('400px');
    key(height, 'ArrowUp');
    expect(section('section-gate').style.getPropertyValue('--vip-panel-h')).toBe('384px');
    key(height, 'End');
    expect(section('section-gate').style.getPropertyValue('--vip-panel-h')).toBe('810px');
    key(height, 'Home');
    expect(section('section-gate').style.getPropertyValue('--vip-panel-h')).toBe('120px');
    const width = handles('section-eq', 'width');
    key(width, 'ArrowRight');
    expect(document.documentElement.style.getPropertyValue('--vip-rack-w')).toBe('356px');
    key(width, 'End');
    expect(document.documentElement.style.getPropertyValue('--vip-rack-w')).toBe('900px');
    key(width, 'Home');
    expect(document.documentElement.style.getPropertyValue('--vip-rack-w')).toBe('300px');
  });

  test('below the workstation breakpoint no stored size is applied', () => {
    UiPersistence.writeStoredPanelSizes(
      { rackW: 640, heights: { 'section-gate': 480 } },
      storage,
    );
    stubMatchMedia(window, false);
    init();
    expect(document.documentElement.style.getPropertyValue('--vip-rack-w')).toBe('');
    expect(section('section-gate').style.getPropertyValue('--vip-panel-h')).toBe('');
    // Handles still exist in the DOM; the CSS gates their visibility on body.ws.
    expect(handles('section-gate', 'height')).not.toBeNull();
  });

  test('init returns null without a presets rack, and is idempotent', () => {
    document.body.innerHTML = '<div></div>';
    expect(PanelResize.initPanelResize({ document, window, storage })).toBeNull();
    document.body.innerHTML = RACK_FIXTURE;
    expect(init()).not.toBeNull();
    expect(PanelResize.initPanelResize({ document, window, storage })).toBeNull();
  });
});

describe('engineer-console.css, parsed through the CSSOM', () => {
  /** Find a top-level rule by exact selector text. */
  function findRule(sheet, selector) {
    for (const rule of sheet.cssRules) {
      if (rule.selectorText === selector) return rule;
    }
    return null;
  }

  let sheet;
  beforeAll(() => {
    const doc = globalThis.document;
    doc.head.innerHTML = `<style>${read('public/app/engineer-console.css')}</style>`;
    sheet = doc.styleSheets[doc.styleSheets.length - 1];
    expect(sheet.cssRules.length).toBeGreaterThan(50);
  });

  afterAll(() => {
    globalThis.document.head.innerHTML = '';
  });

  test('the workstation grid defaults the rack to clamp(300px, 19vw, 360px) behind --vip-rack-w', () => {
    const rule = findRule(sheet, 'body.eng-console.ws .main-grid.ec-grid');
    expect(rule).not.toBeNull();
    const value = rule.style.getPropertyValue('grid-template-columns');
    expect(value).toMatch(/--vip-rack-w/);
    expect(value).toMatch(/clamp\(300px, 19vw, 360px\)/);
    expect(value).toMatch(/minmax\(0, 1fr\)/);
  });

  test('a sized panel gets a fixed body height with internal scroll', () => {
    const rule = findRule(
      sheet,
      'body.eng-console.ws details.vip-section[data-vip-sized][open] > .vip-section-body',
    );
    expect(rule).not.toBeNull();
    expect(rule.style.getPropertyValue('height')).toBe('var(--vip-panel-h)');
    expect(rule.style.getPropertyValue('overflow-y')).toBe('auto');
  });

  test('handles are workstation-gated and carry the resize cursors', () => {
    const height = findRule(sheet, 'body.eng-console.ws .vip-panel-resize-handle--height');
    expect(height).not.toBeNull();
    expect(height.style.getPropertyValue('cursor')).toBe('ns-resize');
    const width = findRule(sheet, 'body.eng-console.ws .vip-panel-resize-handle--width');
    expect(width).not.toBeNull();
    expect(width.style.getPropertyValue('cursor')).toBe('ew-resize');
    // Every resize rule is prefixed with body.eng-console.ws, so below the
    // workstation breakpoint the handles never render.
    for (const rule of sheet.cssRules) {
      if (rule.selectorText && rule.selectorText.includes('vip-panel-resize-handle')) {
        expect(rule.selectorText.startsWith('body.eng-console.ws')).toBe(true);
      }
      if (rule.selectorText && rule.selectorText.includes('vip-panel-reset')) {
        expect(rule.selectorText.startsWith('body.eng-console.ws')).toBe(true);
      }
    }
  });
});
