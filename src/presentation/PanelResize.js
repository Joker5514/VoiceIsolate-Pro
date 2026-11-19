/**
 * Resizable Engineer Console rack panels (Layer 4: Presentation).
 *
 * The presets / slider-group sections inside `#section-presets` behave like
 * windows inside the workstation window:
 *
 *  - a bottom-edge handle resizes that block's height independently
 *    (120px .. 90vh; the body scrolls internally once sized), and
 *  - a right-edge handle resizes the shared rack column width
 *    (300px .. 900px, clamped so >=900px of viewport stays for the
 *    session + stage columns).
 *
 * Sizes persist per block in localStorage (`vip-panel-sizes`, see
 * `src/core/UiPersistence.js`) and survive reloads. Double-click a handle
 * resets that dimension; the "Reset panel sizes" button in the rack nav
 * resets everything.
 *
 * Scope: workstation mode only (`body.ws`, >=1024x560, same query as
 * engineer-console.js). Below that the handles are hidden by CSS and no
 * size is applied, so the stacked mobile layout is untouched. This is
 * layout only: no slider, parameter, DSP, or ML behaviour is touched, and
 * resizing never re-triggers inference.
 *
 * The default rack width is unchanged (the grid still falls back to
 * `clamp(300px, 19vw, 360px)`), and the `@container vip-rack` row
 * adaptation still governs slider rows at any width the user picks — a
 * wider rack simply shows the canonical five-column rows the container
 * queries already describe.
 */
import { readStoredPanelSizes, writeStoredPanelSizes } from '../core/UiPersistence.js';

export const WS_QUERY = '(min-width: 1024px) and (min-height: 560px)';

export const PANEL_HEIGHT_MIN = 120;
export const PANEL_HEIGHT_STEP = 16;
export const PANEL_HEIGHT_SHIFT_STEP = 64;

export const RACK_WIDTH_MIN = 300;
export const RACK_WIDTH_MAX = 900;
export const RACK_WIDTH_STEP = 16;
export const RACK_WIDTH_SHIFT_STEP = 64;
/** Viewport pixels always left for the session + stage columns. */
export const RACK_VIEWPORT_RESERVE_PX = 900;

const HEIGHT_VAR = '--vip-panel-h';
const RACK_WIDTH_VAR = '--vip-rack-w';

/** Clamp a panel height: 120px floor, 90% of the viewport height ceiling. */
export function clampPanelHeight(px, viewportHeight) {
  const max = Math.max(PANEL_HEIGHT_MIN, Math.floor((viewportHeight || 0) * 0.9));
  if (px === Infinity) return max;
  if (!Number.isFinite(px)) return PANEL_HEIGHT_MIN;
  return Math.min(max, Math.max(PANEL_HEIGHT_MIN, Math.round(px)));
}

/** Clamp a rack width: 300px floor, 900px ceiling, viewport-aware. */
export function clampRackWidth(px, viewportWidth) {
  const max = Math.max(
    RACK_WIDTH_MIN,
    Math.min(RACK_WIDTH_MAX, (viewportWidth || 0) - RACK_VIEWPORT_RESERVE_PX),
  );
  if (px === Infinity) return max;
  if (!Number.isFinite(px)) return RACK_WIDTH_MIN;
  return Math.min(max, Math.max(RACK_WIDTH_MIN, Math.round(px)));
}

function sectionLabel(section) {
  const summary = section.querySelector(':scope > summary');
  const text = summary ? summary.textContent.trim().replace(/\s+/g, ' ') : '';
  return text || section.id || 'panel';
}

function makeHandle(doc, kind, label, min, max, now) {
  const handle = doc.createElement('div');
  handle.className = `vip-panel-resize-handle vip-panel-resize-handle--${kind}`;
  handle.setAttribute('role', 'slider');
  handle.setAttribute('tabindex', '0');
  handle.setAttribute('aria-label', label);
  handle.setAttribute('aria-orientation', kind === 'height' ? 'vertical' : 'horizontal');
  handle.setAttribute('aria-valuemin', String(min));
  handle.setAttribute('aria-valuemax', String(max));
  handle.setAttribute('aria-valuenow', String(now));
  handle.setAttribute('aria-valuetext', `${now} pixels`);
  handle.dataset.vipResizeKind = kind;
  return handle;
}

function syncHandle(handle, value, min, max) {
  handle.setAttribute('aria-valuemin', String(min));
  handle.setAttribute('aria-valuemax', String(max));
  handle.setAttribute('aria-valuenow', String(value));
  handle.setAttribute('aria-valuetext', `${value} pixels`);
}

/**
 * Wire resizable panels. Options are injectable for tests; production calls
 * with no arguments (real document/window/localStorage).
 * Returns a controller, or null when the rack is absent / matchMedia is
 * unavailable.
 */
export function initPanelResize(options = {}) {
  const doc = options.document || globalThis.document;
  const win = options.window || globalThis.window;
  const storage = options.storage;
  if (!doc || !win || !win.matchMedia) return null;

  const presets = doc.getElementById('section-presets');
  if (!presets) return null;
  if (presets.dataset.vipPanelResize === '1') return null;

  const sections = [...presets.querySelectorAll('details.vip-section')]
    .filter((section) => section !== presets && section.id);
  if (sections.length === 0) return null;

  const mq = win.matchMedia(WS_QUERY);
  let active = mq.matches;
  let sizes = readStoredPanelSizes(storage);
  const listeners = [];
  const on = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    listeners.push([target, type, fn, opts]);
  };

  const viewportWidth = () => win.innerWidth || 0;
  const viewportHeight = () => win.innerHeight || 0;

  function currentPanelHeight(section) {
    const body = section.querySelector(':scope > .vip-section-body');
    const measured = body ? body.offsetHeight : 0;
    if (measured > 0) return measured;
    const stored = sizes.heights[section.id];
    return Number.isFinite(stored) ? stored : 320;
  }

  function currentRackWidth() {
    const rack = doc.querySelector('.ec-col-rack');
    const measured = rack ? rack.offsetWidth : 0;
    if (measured > 0) return measured;
    return Number.isFinite(sizes.rackW) ? sizes.rackW : 340;
  }

  function persist() {
    writeStoredPanelSizes(sizes, storage);
  }

  function applyPanelHeight(section, px, { persistSize = true } = {}) {
    const value = clampPanelHeight(px, viewportHeight());
    section.style.setProperty(HEIGHT_VAR, `${value}px`);
    section.dataset.vipSized = '1';
    sizes.heights[section.id] = value;
    const handle = section.querySelector(':scope > .vip-panel-resize-handle--height');
    if (handle) syncHandle(handle, value, PANEL_HEIGHT_MIN, clampPanelHeight(Infinity, viewportHeight()));
    if (persistSize) persist();
    return value;
  }

  function clearPanelHeight(section, { persistSize = true } = {}) {
    section.style.removeProperty(HEIGHT_VAR);
    delete section.dataset.vipSized;
    delete sizes.heights[section.id];
    const handle = section.querySelector(':scope > .vip-panel-resize-handle--height');
    if (handle) {
      const now = currentPanelHeight(section);
      syncHandle(handle, now, PANEL_HEIGHT_MIN, clampPanelHeight(Infinity, viewportHeight()));
    }
    if (persistSize) persist();
  }

  function applyRackWidth(px, { persistSize = true } = {}) {
    const value = clampRackWidth(px, viewportWidth());
    doc.documentElement.style.setProperty(RACK_WIDTH_VAR, `${value}px`);
    sizes.rackW = value;
    for (const section of sections) {
      const handle = section.querySelector(':scope > .vip-panel-resize-handle--width');
      if (handle) syncHandle(handle, value, RACK_WIDTH_MIN, clampRackWidth(Infinity, viewportWidth()));
    }
    if (persistSize) persist();
    return value;
  }

  function clearRackWidth({ persistSize = true } = {}) {
    doc.documentElement.style.removeProperty(RACK_WIDTH_VAR);
    sizes.rackW = null;
    for (const section of sections) {
      const handle = section.querySelector(':scope > .vip-panel-resize-handle--width');
      if (handle) {
        const now = currentRackWidth();
        syncHandle(handle, now, RACK_WIDTH_MIN, clampRackWidth(Infinity, viewportWidth()));
      }
    }
    if (persistSize) persist();
  }

  function applyStored() {
    if (!active) return;
    if (Number.isFinite(sizes.rackW)) applyRackWidth(sizes.rackW, { persistSize: false });
    for (const section of sections) {
      const stored = sizes.heights[section.id];
      if (Number.isFinite(stored)) applyPanelHeight(section, stored, { persistSize: false });
    }
  }

  function clearApplied() {
    for (const section of sections) {
      section.style.removeProperty(HEIGHT_VAR);
      delete section.dataset.vipSized;
    }
    doc.documentElement.style.removeProperty(RACK_WIDTH_VAR);
  }

  function resetAll() {
    for (const section of sections) clearPanelHeight(section, { persistSize: false });
    clearRackWidth({ persistSize: false });
    sizes = { rackW: null, heights: {} };
    persist();
  }

  function wireDrag(handle, kind, section) {
    const onPointerDown = (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const startValue = kind === 'height'
        ? currentPanelHeight(section)
        : currentRackWidth();
      if (typeof handle.setPointerCapture === 'function') {
        try { handle.setPointerCapture(event.pointerId); } catch { /* pointer may be synthetic */ }
      }
      const onMove = (moveEvent) => {
        if (kind === 'height') {
          applyPanelHeight(section, startValue + (moveEvent.clientY - startY), { persistSize: false });
        } else {
          applyRackWidth(startValue + (moveEvent.clientX - startX), { persistSize: false });
        }
      };
      const onUp = () => {
        win.removeEventListener('pointermove', onMove);
        win.removeEventListener('pointerup', onUp);
        win.removeEventListener('pointercancel', onUp);
        persist();
      };
      win.addEventListener('pointermove', onMove);
      win.addEventListener('pointerup', onUp);
      win.addEventListener('pointercancel', onUp);
    };
    on(handle, 'pointerdown', onPointerDown);

    on(handle, 'dblclick', () => {
      if (kind === 'height') clearPanelHeight(section);
      else clearRackWidth();
    });

    on(handle, 'keydown', (event) => {
      const shift = event.shiftKey ? 4 : 1;
      let delta = 0;
      if (kind === 'height') {
        if (event.key === 'ArrowDown') delta = PANEL_HEIGHT_STEP * shift;
        else if (event.key === 'ArrowUp') delta = -PANEL_HEIGHT_STEP * shift;
        else if (event.key === 'Home') {
          applyPanelHeight(section, PANEL_HEIGHT_MIN);
          event.preventDefault();
          return;
        } else if (event.key === 'End') {
          applyPanelHeight(section, clampPanelHeight(Infinity, viewportHeight()));
          event.preventDefault();
          return;
        } else return;
        applyPanelHeight(section, currentPanelHeight(section) + delta);
      } else {
        if (event.key === 'ArrowRight') delta = RACK_WIDTH_STEP * shift;
        else if (event.key === 'ArrowLeft') delta = -RACK_WIDTH_STEP * shift;
        else if (event.key === 'Home') {
          applyRackWidth(RACK_WIDTH_MIN);
          event.preventDefault();
          return;
        } else if (event.key === 'End') {
          applyRackWidth(clampRackWidth(Infinity, viewportWidth()));
          event.preventDefault();
          return;
        } else return;
        applyRackWidth(currentRackWidth() + delta);
      }
      event.preventDefault();
    });
  }

  // Install handles.
  for (const section of sections) {
    section.dataset.vipResizable = '1';
    const label = sectionLabel(section);
    const heightHandle = makeHandle(
      doc, 'height', `Resize ${label} height`,
      PANEL_HEIGHT_MIN, clampPanelHeight(Infinity, viewportHeight()),
      currentPanelHeight(section),
    );
    const widthHandle = makeHandle(
      doc, 'width', 'Resize rack width (shared by all panels)',
      RACK_WIDTH_MIN, clampRackWidth(Infinity, viewportWidth()),
      currentRackWidth(),
    );
    section.appendChild(heightHandle);
    section.appendChild(widthHandle);
    wireDrag(heightHandle, 'height', section);
    wireDrag(widthHandle, 'width', section);
  }

  // Reset-all control in the sticky rack nav (when the shell built one).
  let resetButton = null;
  const nav = doc.querySelector('.ec-rack-nav');
  if (nav) {
    resetButton = doc.createElement('button');
    resetButton.type = 'button';
    resetButton.id = 'vipPanelReset';
    resetButton.className = 'vip-panel-reset';
    resetButton.textContent = 'Reset panel sizes';
    resetButton.title = 'Restore the default presets and slider panel sizes';
    on(resetButton, 'click', resetAll);
    nav.appendChild(resetButton);
  }

  // Workstation-mode gating: sizes apply only while body.ws is live.
  const onMqChange = (event) => {
    active = event.matches;
    if (active) applyStored();
    else clearApplied();
  };
  if (mq.addEventListener) mq.addEventListener('change', onMqChange);
  else if (mq.addListener) mq.addListener(onMqChange);

  // A narrower viewport lowers the rack-width ceiling; re-clamp the applied
  // width (the stored preference is kept, so widening restores it).
  let resizeRaf = 0;
  const onResize = () => {
    if (resizeRaf) return;
    const schedule = win.requestAnimationFrame || ((cb) => win.setTimeout(cb, 0));
    resizeRaf = schedule(() => {
      resizeRaf = 0;
      if (!active) return;
      if (Number.isFinite(sizes.rackW)) applyRackWidth(sizes.rackW, { persistSize: false });
      for (const section of sections) {
        const stored = sizes.heights[section.id];
        if (Number.isFinite(stored)) applyPanelHeight(section, stored, { persistSize: false });
      }
    });
  };
  on(win, 'resize', onResize);

  presets.dataset.vipPanelResize = '1';
  applyStored();

  function destroy() {
    for (const [target, type, fn, opts] of listeners) {
      target.removeEventListener(type, fn, opts);
    }
    listeners.length = 0;
    if (mq.removeEventListener) mq.removeEventListener('change', onMqChange);
    else if (mq.removeListener) mq.removeListener(onMqChange);
    for (const section of sections) {
      section.querySelectorAll(':scope > .vip-panel-resize-handle').forEach((h) => h.remove());
      delete section.dataset.vipResizable;
      section.style.removeProperty(HEIGHT_VAR);
      delete section.dataset.vipSized;
    }
    if (resetButton) resetButton.remove();
    doc.documentElement.style.removeProperty(RACK_WIDTH_VAR);
    delete presets.dataset.vipPanelResize;
  }

  return {
    sections,
    applyStored,
    applyPanelHeight,
    clearPanelHeight,
    applyRackWidth,
    clearRackWidth,
    resetAll,
    getSizes: () => readStoredPanelSizes(storage),
    destroy,
  };
}
