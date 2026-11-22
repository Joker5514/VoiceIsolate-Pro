/**
 * Independent workspace blocks for Stems (Landing) and Engineer.
 *
 * Presentation only. Resizing writes CSS sizes and a layout record. It does
 * not start audio playback, workers, or the processing path.
 * Stems and Engineer keep separate records in `vip-workspace-layouts`.
 * Rack slider sections keep their own sizes in `vip-panel-sizes`.
 *
 * Width tracks for the Engineer stage and inspector apply only at ≥1280px.
 * The neural skin places the inspector, the stage, then the rack. The older
 * workstation grid places the stage first. Below that width, and on a phone,
 * blocks keep height, collapse, and maximize. A stored width is left
 * untouched and comes back when the viewport is wide again.
 */
import { readWorkspaceLayouts, writeWorkspaceLayouts } from '../core/UiPersistence.js';

export const WIDE_QUERY = '(min-width: 1280px)';

export const BLOCKS = {
  stems: [
    { id: 'nav', selector: '.v3-nav', label: 'Navigation', axes: 'width', minW: 180, maxW: 520, overlay: true, collapse: false, reorder: false },
    { id: 'upload', selector: '#uploadPanel', label: 'Import', axes: 'height', minH: 140, reorder: true },
    { id: 'signal', selector: '#signalCanvasSection', label: 'Signal workspace', axes: 'both', minH: 160, minW: 280, maxW: 1400, reorder: true },
    { id: 'mixer', selector: '#enhancePanel', label: 'Stem mixer', axes: 'height', minH: 180, reorder: true },
    { id: 'stem-voice', selector: '#enhancePanel .v3-lane--voice', label: 'Voice stem', axes: 'height', minH: 88, reorder: false },
    { id: 'stem-background', selector: '#enhancePanel .v3-lane--bg', label: 'Background stem', axes: 'height', minH: 88, reorder: false },
    { id: 'waveform', selector: '#enhancePanel .v3-lanes__wave', label: 'Stem waveforms', axes: 'height', minH: 120, fillCanvas: true, reorder: false },
    { id: 'transport', selector: '#landingTransport', label: 'Playback', axes: 'height', minH: 72, reorder: true },
    { id: 'export', selector: '#compareRow', label: 'Compare and export', axes: 'height', minH: 96, reorder: true },
    { id: 'spectrum', selector: '#enhancePanel .v3-spectrum', label: 'Live spectrum', axes: 'height', minH: 96, fillCanvas: true, reorder: true },
    { id: 'diagnostics', selector: '#sourceConfidencePanel', label: 'Source confidence', axes: 'height', minH: 64, reorder: true },
    { id: 'processing', selector: '#advancedMixDetails', label: 'Advanced mix', axes: 'height', minH: 120, reorder: true },
    { id: 'settings', selector: '#settings', label: 'Settings', axes: 'height', minH: 96, reorder: false },
  ],
  engineer: [
    { id: 'stage-column', selector: '.ec-col-stage', label: 'Stage column', axes: 'width', track: 'stage', minW: 420, overlay: true, collapse: false, reorder: false },
    { id: 'session-column', selector: '.ec-col-session', label: 'Inspector column', axes: 'width', track: 'session', minW: 280, maxW: 640, overlay: true, collapse: false, reorder: false },
    { id: 'upload', selector: '#section-upload', label: 'Upload', axes: 'height', minH: 120, reorder: true },
    { id: 'waveform', selector: '#vizCard', label: 'Waveform', axes: 'height', minH: 180, reorder: true },
    { id: 'signal', selector: '#section-signal-canvas', label: 'Signal canvas', axes: 'both', minH: 160, minW: 280, maxW: 1200, reorder: true },
    { id: 'forensic', selector: '#section-forensic', label: 'Forensic Inspector', axes: 'height', minH: 120, reorder: true },
    { id: 'evidence', selector: '#forensicInspectorMount', label: 'Forensic evidence', axes: 'height', minH: 80, reorder: false },
    { id: 'diagnostics', selector: '#section-analysis', label: 'Diagnostics', axes: 'height', minH: 120, reorder: true },
    { id: 'cockpit', selector: '#section-cockpit', label: 'Launch diagnostics', axes: 'height', minH: 88, reorder: true },
    { id: 'integrity', selector: '#ecIntegrityCard', label: 'DSP integrity', axes: 'height', minH: 88, reorder: true },
    { id: 'safety', selector: '#ecOutputSafety', label: 'Output safety', axes: 'height', minH: 88, reorder: true },
    { id: 'processing', selector: '#section-processing', label: 'Processing and signal chain', axes: 'height', minH: 120, reorder: true },
    { id: 'presets', selector: '#section-presets', label: 'Signal-chain rack', axes: 'height', minH: 160, reorder: false },
    { id: 'export', selector: '#section-save', label: 'Export', axes: 'height', minH: 96, reorder: true },
    { id: 'transport', selector: '#section-transport', label: 'Playback', axes: 'height', minH: 64, maxH: 280, overlay: true, reorder: false },
    { id: 'target', selector: '#section-target-speaker', label: 'Target speaker', axes: 'height', minH: 88, reorder: true },
  ],
};

/** Surfaces the parity suite requires. Both shells ship this one catalog. */
export const REQUIRED_BLOCKS = {
  stems: ['nav', 'upload', 'signal', 'mixer', 'stem-voice', 'stem-background', 'waveform', 'transport', 'export', 'spectrum', 'diagnostics', 'processing', 'settings'],
  engineer: ['stage-column', 'session-column', 'upload', 'waveform', 'signal', 'forensic', 'evidence', 'diagnostics', 'cockpit', 'integrity', 'safety', 'processing', 'presets', 'export', 'transport', 'target'],
};

const HEIGHT_STEP = 16;
const WIDTH_STEP = 16;

export function clampDimension(px, min, max) {
  const floor = Math.max(0, Math.round(min));
  const ceiling = Math.max(floor, Math.round(max));
  if (px === Infinity) return ceiling;
  if (!Number.isFinite(px)) return floor;
  return Math.min(ceiling, Math.max(floor, Math.round(px)));
}

function hasHeight(spec) {
  return spec.axes === 'height' || spec.axes === 'both';
}

function hasWidth(spec) {
  return spec.axes === 'width' || spec.axes === 'both';
}

function makeHandle(doc, kind, label) {
  const handle = doc.createElement('div');
  handle.className = `vip-block-handle vip-block-handle--${kind}`;
  handle.tabIndex = 0;
  handle.setAttribute('role', 'slider');
  const orientation = kind === 'width' ? 'horizontal' : 'vertical';
  if (kind !== 'corner') handle.setAttribute('aria-orientation', orientation);
  handle.setAttribute('aria-label', kind === 'corner'
    ? `Resize ${label} width and height`
    : `Resize ${label} ${kind}`);
  handle.dataset.vipResizeKind = kind;
  return handle;
}

function syncHandle(handle, value, min, max) {
  if (!handle) return;
  const now = Math.round(value);
  handle.setAttribute('aria-valuemin', String(Math.round(min)));
  handle.setAttribute('aria-valuemax', String(Math.round(max)));
  handle.setAttribute('aria-valuenow', String(now));
  handle.setAttribute('aria-valuetext', `${now} pixels`);
}

function button(doc, action, label) {
  const el = doc.createElement('button');
  el.type = 'button';
  el.className = 'vip-block-btn';
  el.dataset.act = action;
  el.textContent = label;
  el.setAttribute('aria-label', label);
  return el;
}

/**
 * Wire one mode. Returns null when that document was already wired or when
 * none of the catalog nodes are present. `options.blocks` replaces the
 * catalog in tests.
 */
export function initWorkspaceBlocks(options = {}) {
  const doc = options.document || globalThis.document;
  const win = options.window || globalThis.window;
  const storage = options.storage;
  if (!doc || !win || !doc.documentElement) return null;

  const mode = options.mode === 'engineer' ? 'engineer' : 'stems';
  if (doc.documentElement.dataset.vipWorkspaceBlocks === mode) return null;

  const specs = options.blocks || BLOCKS[mode];
  const found = [];
  for (const spec of specs) {
    const el = doc.querySelector(spec.selector);
    if (el) found.push({ spec, el });
  }
  if (found.length === 0) return null;

  doc.documentElement.dataset.vipWorkspaceBlocks = mode;
  let layouts = readWorkspaceLayouts(storage);
  const listeners = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  };

  const wideMq = typeof win.matchMedia === 'function'
    ? win.matchMedia(WIDE_QUERY)
    : { matches: false, addEventListener() {}, removeEventListener() {} };

  const viewportHeight = () => win.innerHeight || 800;
  const viewportWidth = () => win.innerWidth || 1280;
  const isWide = () => Boolean(wideMq.matches);
  const neuralColumns = () => Boolean(doc.body && doc.body.classList.contains('neural-console'));

  const mounted = [];

  function maxHeight(spec) {
    if (Number.isFinite(spec.maxH)) return spec.maxH;
    const ratio = Number.isFinite(spec.maxHRatio) ? spec.maxHRatio : 0.85;
    return Math.max(spec.minH || 88, Math.floor(viewportHeight() * ratio));
  }

  function maxWidth(spec) {
    if (spec.track === 'stage') {
      // Leave room for the inspector, the rack, and the grid gap.
      const reserve = neuralColumns() ? (240 + 280 + 52) : (280 + 300 + 48);
      return Math.max(spec.minW, viewportWidth() - reserve);
    }
    if (Number.isFinite(spec.maxW)) return spec.maxW;
    return Math.max(spec.minW || 200, viewportWidth() - 48);
  }

  function recordOf(id) {
    return layouts[mode].blocks[id] || {};
  }

  function persist() {
    const blocks = {};
    for (const block of mounted) {
      const { h, w, collapsed, maximized, order, pre } = block.record;
      const next = {};
      if (Number.isFinite(h) && h > 0) next.h = Math.round(h);
      if (Number.isFinite(w) && w > 0) next.w = Math.round(w);
      if (collapsed === true) next.collapsed = true;
      if (maximized === true) next.maximized = true;
      if (Number.isInteger(order)) next.order = order;
      if (pre && (Number.isFinite(pre.h) || Number.isFinite(pre.w))) {
        next.pre = {};
        if (Number.isFinite(pre.h)) next.pre.h = Math.round(pre.h);
        if (Number.isFinite(pre.w)) next.pre.w = Math.round(pre.w);
      }
      if (Object.keys(next).length) blocks[block.spec.id] = next;
    }
    layouts[mode] = { blocks };
    writeWorkspaceLayouts(layouts, storage);
  }

  function syncColumnTracks() {
    const grid = doc.querySelector('main.main-grid.ec-grid');
    if (!grid) return;
    const stage = mounted.find((block) => block.spec.track === 'stage');
    const session = mounted.find((block) => block.spec.track === 'session');
    const stageW = stage && Number.isFinite(stage.record.w) ? stage.record.w : null;
    const sessionW = session && Number.isFinite(session.record.w) ? session.record.w : null;
    if (!isWide() || (stageW == null && sessionW == null)) {
      grid.style.removeProperty('grid-template-columns');
      return;
    }
    const stageTrack = stageW == null ? 'minmax(0, 1fr)' : `${stageW}px`;
    const sessionTrack = sessionW == null
      ? (neuralColumns() ? 'minmax(240px, 280px)' : 'clamp(380px, 24vw, 460px)')
      : `${sessionW}px`;
    const rackTrack = neuralColumns()
      ? 'var(--vip-rack-w, minmax(280px, 340px))'
      : 'var(--vip-rack-w, clamp(300px, 19vw, 360px))';
    // Neural skin (engineer-console.js) pins inspector, stage, rack.
    const tracks = neuralColumns()
      ? [sessionTrack, stageTrack, rackTrack]
      : [stageTrack, sessionTrack, rackTrack];
    grid.style.gridTemplateColumns = tracks.join(' ');
  }

  function applyOrders() {
    for (const block of mounted) {
      if (!block.spec.reorder || !isWide() || !Number.isInteger(block.record.order)) {
        block.el.style.removeProperty('order');
      } else {
        block.el.style.order = String(block.record.order);
      }
    }
  }

  function syncChrome(block) {
    const collapsed = block.record.collapsed === true;
    const maximized = block.record.maximized === true;
    if (block.collapseBtn) {
      const label = collapsed ? `Expand ${block.spec.label}` : `Collapse ${block.spec.label}`;
      block.collapseBtn.textContent = collapsed ? 'Expand' : 'Collapse';
      block.collapseBtn.setAttribute('aria-label', label);
      block.collapseBtn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
    }
    if (block.maximizeBtn) {
      const label = maximized ? `Restore ${block.spec.label}` : `Maximize ${block.spec.label}`;
      block.maximizeBtn.textContent = maximized ? 'Restore' : 'Maximize';
      block.maximizeBtn.setAttribute('aria-label', label);
      block.maximizeBtn.setAttribute('aria-pressed', maximized ? 'true' : 'false');
    }
    const group = siblingGroup(block);
    const showOrder = group.length > 1;
    if (block.earlierBtn) block.earlierBtn.hidden = !showOrder;
    if (block.laterBtn) block.laterBtn.hidden = !showOrder;
  }

  function siblingGroup(block) {
    if (!block.spec.reorder) return [];
    return mounted.filter((other) => other.spec.reorder && other.el.parentElement === block.el.parentElement);
  }

  function applyHeight(block, px, { persistSize = true, max = null } = {}) {
    const limit = Number.isFinite(max) ? max : maxHeight(block.spec);
    const value = clampDimension(px, block.spec.minH || 88, limit);
    block.record.h = value;
    block.el.style.height = `${value}px`;
    block.el.classList.add('vip-block--sized');
    syncHandle(block.heightHandle, value, block.spec.minH || 88, limit);
    if (block.cornerHandle && Number.isFinite(block.record.w)) {
      syncHandle(block.cornerHandle, value, block.spec.minH || 88, limit);
    }
    if (persistSize) persist();
    return value;
  }

  function clearHeight(block, { persistSize = true } = {}) {
    delete block.record.h;
    block.el.style.removeProperty('height');
    block.el.classList.remove('vip-block--sized');
    const now = block.el.offsetHeight || block.spec.minH || 88;
    syncHandle(block.heightHandle, now, block.spec.minH || 88, maxHeight(block.spec));
    if (persistSize) persist();
  }

  function applyWidth(block, px, { persistSize = true } = {}) {
    const value = clampDimension(px, block.spec.minW || 200, maxWidth(block.spec));
    block.record.w = value;
    if (block.spec.track) {
      syncColumnTracks();
    } else if (isWide()) {
      block.el.style.width = `${value}px`;
      block.el.style.maxWidth = '100%';
      block.el.classList.add('vip-block--sized-w');
    } else {
      block.el.style.removeProperty('width');
      block.el.style.removeProperty('max-width');
      block.el.classList.remove('vip-block--sized-w');
    }
    syncHandle(block.widthHandle, value, block.spec.minW || 200, maxWidth(block.spec));
    if (persistSize) persist();
    return value;
  }

  function clearWidth(block, { persistSize = true } = {}) {
    delete block.record.w;
    block.el.style.removeProperty('width');
    block.el.style.removeProperty('max-width');
    block.el.classList.remove('vip-block--sized-w');
    if (block.spec.track) syncColumnTracks();
    const now = block.el.offsetWidth || block.spec.minW || 200;
    syncHandle(block.widthHandle, now, block.spec.minW || 200, maxWidth(block.spec));
    if (persistSize) persist();
  }

  function noteManual(block) {
    block.record.maximized = false;
    delete block.record.pre;
    block.el.classList.remove('vip-block--maximized');
  }

  function setCollapsed(block, collapsed) {
    if (block.spec.collapse === false) return;
    block.record.collapsed = collapsed;
    if (collapsed) {
      block.record.maximized = false;
      delete block.record.pre;
      block.el.classList.remove('vip-block--maximized');
    }
    block.el.classList.toggle('vip-block--collapsed', collapsed);
    if (block.el.tagName === 'DETAILS') block.el.open = !collapsed;
    syncChrome(block);
    persist();
  }

  function toggleMaximize(block) {
    if (block.spec.maximize === false) return;
    if (block.record.maximized) {
      const pre = block.record.pre || {};
      block.record.maximized = false;
      delete block.record.pre;
      block.el.classList.remove('vip-block--maximized');
      if (hasHeight(block.spec)) {
        if (Number.isFinite(pre.h)) applyHeight(block, pre.h, { persistSize: false });
        else clearHeight(block, { persistSize: false });
      }
      if (hasWidth(block.spec)) {
        if (Number.isFinite(pre.w)) applyWidth(block, pre.w, { persistSize: false });
        else clearWidth(block, { persistSize: false });
      }
      syncChrome(block);
      persist();
      return;
    }
    const pre = {};
    if (Number.isFinite(block.record.h)) pre.h = block.record.h;
    if (Number.isFinite(block.record.w)) pre.w = block.record.w;
    block.record.pre = pre;
    block.record.maximized = true;
    block.record.collapsed = false;
    block.el.classList.remove('vip-block--collapsed');
    block.el.classList.add('vip-block--maximized');
    if (block.el.tagName === 'DETAILS') block.el.open = true;
    if (hasHeight(block.spec)) applyHeight(block, Infinity, { persistSize: false });
    if (hasWidth(block.spec)) applyWidth(block, Infinity, { persistSize: false });
    syncChrome(block);
    persist();
  }

  function moveBlock(block, delta) {
    const group = siblingGroup(block).slice().sort(
      (a, b) => (a.record.order ?? a.domIndex) - (b.record.order ?? b.domIndex),
    );
    const index = group.indexOf(block);
    const next = index + delta;
    if (index < 0 || next < 0 || next >= group.length) return;
    const other = group[next];
    const aOrder = block.record.order ?? block.domIndex;
    const bOrder = other.record.order ?? other.domIndex;
    block.record.order = bOrder;
    other.record.order = aOrder;
    applyOrders();
    persist();
  }

  function clearBlock(block) {
    const open = block.defaultOpen;
    delete layouts[mode].blocks[block.spec.id];
    block.record = {};
    block.el.style.removeProperty('height');
    block.el.style.removeProperty('width');
    block.el.style.removeProperty('max-width');
    block.el.style.removeProperty('order');
    block.el.classList.remove('vip-block--sized', 'vip-block--sized-w', 'vip-block--collapsed', 'vip-block--maximized');
    if (block.el.tagName === 'DETAILS') block.el.open = open;
    syncChrome(block);
  }

  function wireDrag(handle, kind, block) {
    on(handle, 'pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      noteManual(block);
      const startX = event.clientX;
      const startY = event.clientY;
      const startH = Number.isFinite(block.record.h) ? block.record.h : (block.el.offsetHeight || block.spec.minH || 88);
      const startW = Number.isFinite(block.record.w) ? block.record.w : (block.el.offsetWidth || block.spec.minW || 200);
      if (typeof handle.setPointerCapture === 'function') {
        try { handle.setPointerCapture(event.pointerId); } catch { /* synthetic events */ }
      }
      const onMove = (moveEvent) => {
        if (kind === 'height' || kind === 'corner') {
          // A section inside a scrolling column can already be taller than
          // 85vh. Keep that size as the floor and allow one more viewport
          // of growth, so the first drag does not snap the panel shorter.
          const cap = maxHeight(block.spec);
          const limit = Math.max(cap, Math.min(startH + cap, viewportHeight() * 3));
          applyHeight(block, startH + (moveEvent.clientY - startY), { persistSize: false, max: limit });
        }
        if (kind === 'width' || kind === 'corner') {
          applyWidth(block, startW + (moveEvent.clientX - startX), { persistSize: false });
        }
      };
      const onUp = () => {
        win.removeEventListener('pointermove', onMove);
        win.removeEventListener('pointerup', onUp);
        win.removeEventListener('pointercancel', onUp);
        syncChrome(block);
        persist();
      };
      win.addEventListener('pointermove', onMove);
      win.addEventListener('pointerup', onUp);
      win.addEventListener('pointercancel', onUp);
    });

    on(handle, 'dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      noteManual(block);
      if (kind === 'height' || kind === 'corner') clearHeight(block, { persistSize: false });
      if (kind === 'width' || kind === 'corner') clearWidth(block, { persistSize: false });
      syncChrome(block);
      persist();
    });

    on(handle, 'keydown', (event) => {
      const step = event.shiftKey ? 4 : 1;
      const heightDelta = event.key === 'ArrowDown' ? HEIGHT_STEP * step
        : event.key === 'ArrowUp' ? -HEIGHT_STEP * step : 0;
      const widthDelta = event.key === 'ArrowRight' ? WIDTH_STEP * step
        : event.key === 'ArrowLeft' ? -WIDTH_STEP * step : 0;
      const home = event.key === 'Home';
      const end = event.key === 'End';
      if (!heightDelta && !widthDelta && !home && !end) return;
      event.preventDefault();
      noteManual(block);
      if (hasHeight(block.spec) && kind !== 'width' && (heightDelta || home || end)) {
        if (home) applyHeight(block, block.spec.minH || 88);
        else if (end) applyHeight(block, Infinity);
        else applyHeight(block, (block.record.h || block.el.offsetHeight || block.spec.minH || 88) + heightDelta);
      }
      if (hasWidth(block.spec) && kind !== 'height' && (widthDelta || home || end)) {
        if (home) applyWidth(block, block.spec.minW || 200);
        else if (end) applyWidth(block, Infinity);
        else applyWidth(block, (block.record.w || block.el.offsetWidth || block.spec.minW || 200) + widthDelta);
      }
      syncChrome(block);
    });
  }

  found.forEach(({ spec, el }, index) => {
    const stored = recordOf(spec.id);
    const block = {
      spec,
      el,
      domIndex: index,
      defaultOpen: el.tagName === 'DETAILS' ? el.open !== false : true,
      record: {
        h: Number.isFinite(stored.h) ? stored.h : undefined,
        w: Number.isFinite(stored.w) ? stored.w : undefined,
        collapsed: stored.collapsed === true,
        maximized: stored.maximized === true,
        order: Number.isInteger(stored.order) ? stored.order : undefined,
        pre: stored.pre,
      },
    };
    el.classList.add('vip-block');
    el.dataset.vipBlock = spec.id;
    el.dataset.vipAxes = spec.axes;
    if (spec.overlay) el.classList.add('vip-block--overlay');
    if (spec.fillCanvas) el.classList.add('vip-block--fill');

    const chrome = doc.createElement('div');
    chrome.className = 'vip-block-chrome';
    if (!el.id) el.id = `vip-block-${mode}-${spec.id}`;
    chrome.setAttribute('aria-controls', el.id);
    if (spec.collapse !== false) {
      block.collapseBtn = button(doc, 'collapse', `Collapse ${spec.label}`);
      chrome.appendChild(block.collapseBtn);
    }
    if (spec.maximize !== false) {
      block.maximizeBtn = button(doc, 'maximize', `Maximize ${spec.label}`);
      chrome.appendChild(block.maximizeBtn);
    }
    if (spec.reorder) {
      block.earlierBtn = button(doc, 'earlier', `Move ${spec.label} earlier`);
      block.laterBtn = button(doc, 'later', `Move ${spec.label} later`);
      block.earlierBtn.hidden = true;
      block.laterBtn.hidden = true;
      chrome.append(block.earlierBtn, block.laterBtn);
    }
    el.appendChild(chrome);
    block.chrome = chrome;

    if (hasHeight(spec)) {
      block.heightHandle = makeHandle(doc, 'height', spec.label);
      el.appendChild(block.heightHandle);
      wireDrag(block.heightHandle, 'height', block);
    }
    if (hasWidth(spec)) {
      block.widthHandle = makeHandle(doc, 'width', spec.label);
      el.appendChild(block.widthHandle);
      wireDrag(block.widthHandle, 'width', block);
    }
    if (hasHeight(spec) && hasWidth(spec)) {
      block.cornerHandle = makeHandle(doc, 'corner', spec.label);
      el.appendChild(block.cornerHandle);
      wireDrag(block.cornerHandle, 'corner', block);
    }

    on(chrome, 'click', (event) => {
      const act = event.target && event.target.closest
        ? event.target.closest('[data-act]')
        : null;
      if (!act || !chrome.contains(act)) return;
      event.preventDefault();
      event.stopPropagation();
      if (act.dataset.act === 'collapse') setCollapsed(block, block.record.collapsed !== true);
      else if (act.dataset.act === 'maximize') toggleMaximize(block);
      else if (act.dataset.act === 'earlier') moveBlock(block, -1);
      else if (act.dataset.act === 'later') moveBlock(block, 1);
    });
    on(chrome, 'keydown', (event) => {
      if (!event.altKey) return;
      if (event.key === 'ArrowUp') {
        moveBlock(block, -1);
        event.preventDefault();
      } else if (event.key === 'ArrowDown') {
        moveBlock(block, 1);
        event.preventDefault();
      }
    });

    if (el.tagName === 'DETAILS') {
      on(el, 'toggle', () => {
        const collapsed = el.open === false;
        if (block.record.collapsed === collapsed) return;
        block.record.collapsed = collapsed;
        if (!collapsed) block.el.classList.remove('vip-block--collapsed');
        else block.el.classList.add('vip-block--collapsed');
        syncChrome(block);
        persist();
      });
    }

    mounted.push(block);
  });

  function applyStored() {
    for (const block of mounted) {
      if (block.record.collapsed) {
        block.el.classList.add('vip-block--collapsed');
        if (block.el.tagName === 'DETAILS') block.el.open = false;
      }
      if (Number.isFinite(block.record.h)) applyHeight(block, block.record.h, { persistSize: false });
      if (Number.isFinite(block.record.w)) applyWidth(block, block.record.w, { persistSize: false });
      if (block.record.maximized) block.el.classList.add('vip-block--maximized');
      syncChrome(block);
    }
    syncColumnTracks();
    applyOrders();
  }

  function resetAll() {
    for (const block of mounted) clearBlock(block);
    layouts[mode] = { blocks: {} };
    syncColumnTracks();
    applyOrders();
    persist();
  }

  let resetButton = null;
  const resetAnchor = mode === 'engineer'
    ? doc.querySelector('.ec-rack-nav')
    : doc.querySelector('#stems .v3-section__head') || doc.querySelector('#workspace');
  if (resetAnchor && !doc.getElementById('vipWorkspaceReset')) {
    resetButton = doc.createElement('button');
    resetButton.type = 'button';
    resetButton.id = 'vipWorkspaceReset';
    resetButton.className = 'vip-workspace-reset';
    resetButton.textContent = 'Reset layout';
    resetButton.title = mode === 'engineer'
      ? 'Restore the Engineer workspace layout'
      : 'Restore the Stems workspace layout';
    on(resetButton, 'click', (event) => {
      event.preventDefault();
      resetAll();
    });
    resetAnchor.appendChild(resetButton);
  }

  applyStored();

  const onWideChange = () => {
    for (const block of mounted) {
      if (Number.isFinite(block.record.w)) applyWidth(block, block.record.w, { persistSize: false });
      if (Number.isFinite(block.record.h)) applyHeight(block, block.record.h, { persistSize: false });
    }
    syncColumnTracks();
    applyOrders();
  };
  if (wideMq.addEventListener) wideMq.addEventListener('change', onWideChange);
  else if (wideMq.addListener) wideMq.addListener(onWideChange);

  let resizeRaf = 0;
  const onResize = () => {
    if (resizeRaf) return;
    const schedule = win.requestAnimationFrame || ((cb) => win.setTimeout(cb, 16));
    resizeRaf = schedule(() => {
      resizeRaf = 0;
      onWideChange();
    });
  };
  on(win, 'resize', onResize);

  function destroy() {
    for (const [target, type, fn, opts] of listeners) {
      target.removeEventListener(type, fn, opts);
    }
    listeners.length = 0;
    if (wideMq.removeEventListener) wideMq.removeEventListener('change', onWideChange);
    else if (wideMq.removeListener) wideMq.removeListener(onWideChange);
    for (const block of mounted) {
      block.chrome?.remove();
      block.heightHandle?.remove();
      block.widthHandle?.remove();
      block.cornerHandle?.remove();
      block.el.style.removeProperty('height');
      block.el.style.removeProperty('width');
      block.el.style.removeProperty('max-width');
      block.el.style.removeProperty('order');
      block.el.classList.remove(
        'vip-block', 'vip-block--overlay', 'vip-block--fill',
        'vip-block--sized', 'vip-block--sized-w', 'vip-block--collapsed', 'vip-block--maximized',
      );
      delete block.el.dataset.vipBlock;
      delete block.el.dataset.vipAxes;
      if (block.el.tagName === 'DETAILS') block.el.open = block.defaultOpen;
    }
    resetButton?.remove();
    const grid = doc.querySelector('main.main-grid.ec-grid');
    if (grid) grid.style.removeProperty('grid-template-columns');
    delete doc.documentElement.dataset.vipWorkspaceBlocks;
    mounted.length = 0;
  }

  return {
    mode,
    blocks: mounted,
    resetAll,
    applyHeight,
    applyWidth,
    setCollapsed,
    toggleMaximize,
    moveBlock,
    getLayouts: () => readWorkspaceLayouts(storage),
    destroy,
  };
}
