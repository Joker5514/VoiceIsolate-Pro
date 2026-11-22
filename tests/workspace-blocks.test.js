/**
 * @jest-environment jsdom
 *
 * Independent Stems and Engineer workspace blocks. Layout only:
 * resizing must not touch playback or processing state.
 */
'use strict';

const STEMS_FIXTURE = `
<section id="stems">
  <div class="v3-section__head"></div>
  <main id="workspace" class="v3-workspace">
    <details id="uploadPanel" open><summary>Import</summary><p>drop</p></details>
    <details id="signalCanvasSection" open><summary>Signal</summary><div id="unifiedSignalCanvas"></div></details>
    <details id="enhancePanel" open>
      <summary>Stems</summary>
      <div class="v3-tilt">
        <div class="v3-lane v3-lane--voice"><span>Voice</span></div>
        <div class="v3-lane v3-lane--bg"><span>Background</span></div>
        <div class="v3-lanes__wave"><canvas id="waveCanvas" class="vis-canvas"></canvas></div>
        <details id="landingTransport" open><summary>Play</summary><button id="playBtn" type="button">Play</button></details>
        <details id="compareRow" open><summary>Compare</summary><div id="exportRow"></div></details>
        <div class="v3-spectrum"><canvas id="specCanvas" class="vis-canvas"></canvas></div>
        <div id="sourceConfidencePanel" data-state="ANALYZING">analyzing</div>
        <details id="advancedMixDetails"><summary>Advanced</summary><div>eq</div></details>
      </div>
    </details>
  </main>
</section>
<nav class="v3-nav"><a href="#stems">Stems</a></nav>
<details id="settings" open><summary>Settings</summary><p>local</p></details>
<audio id="probe"></audio>`;

const ENGINEER_FIXTURE = `
<main class="main-grid ec-grid">
  <div class="ec-col ec-col-stage"></div>
  <div class="ec-col ec-col-session" style="display:flex;flex-direction:column">
    <details id="section-upload" open><summary>Upload</summary><p>file</p></details>
    <details id="section-save" open><summary>Export</summary><p>wav</p></details>
    <details id="section-processing" open><summary>Processing</summary><ol id="vipSignalChain"><li>gate</li></ol></details>
  </div>
  <div class="ec-col ec-col-rack"><nav class="ec-rack-nav"></nav>
    <details id="section-presets" open><summary>Presets</summary><div></div></details>
  </div>
</main>
<details id="vizCard" open><summary>Waveform</summary><canvas id="waveCanvas"></canvas></details>
<details id="section-signal-canvas" open><summary>Signal</summary><div></div></details>
<details id="section-forensic" open><summary>Forensic</summary><div id="forensicInspectorMount"></div></details>
<details id="section-analysis" open><summary>Diagnostics</summary><p data-state="READY">ready</p></details>
<details id="section-cockpit" open><summary>Launch</summary><p></p></details>
<details id="ecIntegrityCard" open><summary>Integrity</summary><p></p></details>
<details id="ecOutputSafety" open><summary>Safety</summary><p></p></details>
<details id="section-transport" open><summary>Play</summary><button id="tpPlay" type="button">Play</button></details>
<details id="section-target-speaker"><summary>Target</summary><p></p></details>
<audio id="probe"></audio>`;

function mapStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value); },
    removeItem: (key) => store.delete(key),
  };
}

function stubMatchMedia(win, matches) {
  let current = matches;
  const listeners = [];
  win.matchMedia = () => ({
    get matches() { return current; },
    media: '',
    addEventListener: (_type, fn) => listeners.push(fn),
    removeEventListener: jest.fn(),
    addListener: (fn) => listeners.push(fn),
    removeListener: jest.fn(),
  });
  return {
    set(value) {
      current = value;
      for (const fn of listeners) fn({ matches: value });
    },
  };
}

function drag(handle, fromX, fromY, toX, toY) {
  const win = globalThis.window;
  handle.dispatchEvent(new win.MouseEvent('pointerdown', {
    bubbles: true, button: 0, clientX: fromX, clientY: fromY,
  }));
  win.dispatchEvent(new win.MouseEvent('pointermove', {
    bubbles: true, clientX: toX, clientY: toY,
  }));
  win.dispatchEvent(new win.MouseEvent('pointerup', {
    bubbles: true, clientX: toX, clientY: toY,
  }));
}

describe('workspace layout persistence', () => {
  let UiPersistence;

  beforeAll(async () => {
    UiPersistence = await import('../src/core/UiPersistence.js');
  });

  test('round-trips stems and engineer without sharing blocks', () => {
    const storage = mapStorage();
    const layouts = UiPersistence.emptyWorkspaceLayouts();
    layouts.stems.blocks.waveform = { h: 420 };
    layouts.engineer.blocks.forensic = { h: 360, collapsed: true };
    expect(UiPersistence.writeWorkspaceLayouts(layouts, storage)).toBe(true);
    expect(UiPersistence.readWorkspaceLayouts(storage)).toEqual(layouts);
    expect(UiPersistence.readStoredPanelSizes(storage)).toEqual({ rackW: null, heights: {} });
  });

  test('drops a bad version, broken JSON, and junk fields', () => {
    const storage = mapStorage();
    const key = UiPersistence.WORKSPACE_LAYOUT_KEY;
    storage.setItem(key, '{');
    expect(UiPersistence.readWorkspaceLayouts(storage)).toEqual(UiPersistence.emptyWorkspaceLayouts());
    storage.setItem(key, JSON.stringify({ v: 99, stems: { blocks: { waveform: { h: 400 } } } }));
    expect(UiPersistence.readWorkspaceLayouts(storage).stems.blocks).toEqual({});
    storage.setItem(key, JSON.stringify({
      v: 1,
      stems: { blocks: { waveform: { h: 'tall', w: -4, collapsed: 'yes', order: 2.5 }, ok: { h: 300, collapsed: true } } },
      engineer: null,
    }));
    expect(UiPersistence.readWorkspaceLayouts(storage).stems.blocks).toEqual({
      ok: { h: 300, collapsed: true },
    });
  });

  test('a failing storage backend never throws', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(UiPersistence.readWorkspaceLayouts(broken)).toEqual(UiPersistence.emptyWorkspaceLayouts());
    expect(UiPersistence.writeWorkspaceLayouts(UiPersistence.emptyWorkspaceLayouts(), broken)).toBe(false);
  });
});

describe('WorkspaceBlocks behavior', () => {
  let WorkspaceBlocks;
  let document;
  let window;
  let storage;
  let controller;
  let media;

  beforeAll(async () => {
    WorkspaceBlocks = await import('../src/presentation/WorkspaceBlocks.js');
  });

  beforeEach(() => {
    document = globalThis.document;
    window = globalThis.window;
    Object.defineProperty(window, 'innerWidth', { value: 1600, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true });
    media = stubMatchMedia(window, true);
    storage = mapStorage();
    controller = null;
  });

  afterEach(() => {
    if (controller) controller.destroy();
    document.body.innerHTML = '';
    document.documentElement.style.cssText = '';
    delete document.documentElement.dataset.vipWorkspaceBlocks;
  });

  function mount(mode, html) {
    document.body.innerHTML = html;
    const audio = document.getElementById('probe');
    audio.play = jest.fn();
    controller = WorkspaceBlocks.initWorkspaceBlocks({ mode, document, window, storage });
    return controller;
  }

  function block(id) {
    return document.querySelector(`[data-vip-block="${id}"]`);
  }

  test('stems blocks resize independently and do not touch playback or analysis state', () => {
    mount('stems', STEMS_FIXTURE);
    expect(controller).not.toBeNull();
    expect(controller.blocks.length).toBe(WorkspaceBlocks.BLOCKS.stems.length);
    const waveHandle = block('waveform').querySelector('.vip-block-handle--height');
    const mixerBefore = block('mixer').style.height;
    drag(waveHandle, 0, 200, 0, 360);
    expect(block('waveform').style.height).toBe('280px');
    expect(block('mixer').style.height).toBe(mixerBefore);
    expect(document.getElementById('probe').play).not.toHaveBeenCalled();
    expect(document.getElementById('sourceConfidencePanel').dataset.state).toBe('ANALYZING');
    expect(controller.getLayouts().stems.blocks.waveform.h).toBe(280);
    expect(controller.getLayouts().engineer.blocks).toEqual({});
  });

  test('a corner grip changes width and height, and a narrow viewport drops the width', () => {
    mount('stems', STEMS_FIXTURE);
    const corner = block('signal').querySelector('.vip-block-handle--corner');
    drag(corner, 400, 200, 520, 360);
    expect(block('signal').style.height).toBe('320px');
    expect(block('signal').style.width).not.toBe('');
    media.set(false);
    expect(block('signal').style.width).toBe('');
    expect(controller.getLayouts().stems.blocks.signal.w).toBeGreaterThan(0);
    media.set(true);
    expect(block('signal').style.width).not.toBe('');
  });

  test('collapse, maximize, restore, and reset keep the other mode', () => {
    mount('stems', STEMS_FIXTURE);
    const upload = block('upload');
    upload.querySelector('[data-act="collapse"]').click();
    expect(upload.open).toBe(false);
    expect(controller.getLayouts().stems.blocks.upload.collapsed).toBe(true);
    upload.querySelector('[data-act="collapse"]').click();
    expect(upload.open).toBe(true);
    expect(controller.getLayouts().stems.blocks.upload).toBeUndefined();

    const diagnostics = block('diagnostics');
    diagnostics.querySelector('[data-act="maximize"]').click();
    expect(diagnostics.classList.contains('vip-block--maximized')).toBe(true);
    expect(diagnostics.style.height).toBe('765px');
    diagnostics.querySelector('[data-act="maximize"]').click();
    expect(diagnostics.style.height).toBe('');

    drag(block('waveform').querySelector('.vip-block-handle--height'), 0, 0, 0, 80);
    document.getElementById('vipWorkspaceReset').click();
    expect(controller.getLayouts().stems.blocks).toEqual({});
    expect(upload.open).toBe(true);

    drag(block('settings').querySelector('.vip-block-handle--height'), 0, 0, 0, 40);
    const stemsHeight = controller.getLayouts().stems.blocks.settings.h;
    expect(stemsHeight).toBeGreaterThan(96);
    controller.destroy();
    controller = null;
    mount('engineer', ENGINEER_FIXTURE);
    expect(controller.getLayouts().stems.blocks.settings.h).toBe(stemsHeight);
    drag(block('forensic').querySelector(':scope > .vip-block-handle--height'), 0, 100, 0, 280);
    expect(controller.getLayouts().engineer.blocks.forensic.h).toBe(300);
    expect(controller.getLayouts().stems.blocks.settings.h).toBe(stemsHeight);
    document.getElementById('vipWorkspaceReset').click();
    expect(controller.getLayouts().engineer.blocks).toEqual({});
    expect(controller.getLayouts().stems.blocks.settings.h).toBe(stemsHeight);
  });

  test('engineer column width is independent of the rack variable and of panel height', () => {
    mount('engineer', ENGINEER_FIXTURE);
    drag(block('stage-column').querySelector('.vip-block-handle--width'), 0, 0, 200, 0);
    const grid = document.querySelector('main.main-grid.ec-grid');
    expect(grid.style.gridTemplateColumns).toContain('620px');
    expect(grid.style.gridTemplateColumns).toContain('--vip-rack-w');
    expect(block('waveform').style.height).toBe('');
    const forensic = block('forensic');
    drag(forensic.querySelector(':scope > .vip-block-handle--height'), 0, 100, 0, 260);
    expect(forensic.style.height).toBe('280px');
    expect(grid.style.gridTemplateColumns).toContain('620px');
    media.set(false);
    expect(grid.style.gridTemplateColumns).toBe('');
    expect(forensic.style.height).toBe('280px');
  });

  test('a panel already taller than the viewport cap grows on a downward drag', () => {
    mount('engineer', ENGINEER_FIXTURE);
    const forensic = block('forensic');
    Object.defineProperty(forensic, 'offsetHeight', { configurable: true, value: 924 });
    drag(forensic.querySelector(':scope > .vip-block-handle--height'), 0, 100, 0, 220);
    expect(forensic.style.height).toBe('1044px');
    expect(document.getElementById('vipSignalChain')).not.toBeNull();
  });

  test('neural console writes the stage width to the center track', () => {
    document.body.classList.add('neural-console');
    mount('engineer', ENGINEER_FIXTURE);
    drag(block('stage-column').querySelector('.vip-block-handle--width'), 0, 0, 200, 0);
    const grid = document.querySelector('main.main-grid.ec-grid');
    expect(grid.style.gridTemplateColumns).toBe(
      'minmax(240px, 280px) 620px var(--vip-rack-w, minmax(280px, 340px))',
    );
    document.body.classList.remove('neural-console');
  });

  test('keyboard resize, reorder, and a second init are safe', () => {
    mount('engineer', ENGINEER_FIXTURE);
    const upload = block('upload');
    const handle = upload.querySelector('.vip-block-handle--height');
    handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(upload.style.height).toBe('136px');
    handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(upload.style.height).toBe('120px');

    const later = upload.querySelector('[data-act="later"]');
    expect(later.hidden).toBe(false);
    later.click();
    const save = block('export');
    expect(Number(upload.style.order)).toBeGreaterThan(Number(save.style.order));

    expect(WorkspaceBlocks.initWorkspaceBlocks({
      mode: 'engineer', document, window, storage,
    })).toBeNull();
    expect(document.getElementById('probe').play).not.toHaveBeenCalled();
    expect(document.querySelector('#section-analysis p').dataset.state).toBe('READY');
  });

  test('double-click clears one axis and junk storage does not apply', () => {
    storage.setItem('vip-workspace-layouts', JSON.stringify({
      v: 1,
      stems: { blocks: { waveform: { h: 12 }, signal: { h: 'nope' } } },
      engineer: { blocks: {} },
    }));
    mount('stems', STEMS_FIXTURE);
    expect(block('waveform').style.height).toBe('120px');
    expect(block('signal').style.height).toBe('');
    const handle = block('waveform').querySelector('.vip-block-handle--height');
    handle.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    expect(block('waveform').style.height).toBe('');
    expect(controller.getLayouts().stems.blocks.waveform).toBeUndefined();
  });
});
