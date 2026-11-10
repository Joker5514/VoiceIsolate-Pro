/**
 * Shared premium transport chrome for the Stems dock and Engineer mode.
 * Visual state and disclosure only. Callers keep their own playback nodes.
 */
'use strict';

const READY_LIMIT = 48;

function fmtClock(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/** Crop label. No crop reads as the whole file. */
export function formatTransportSelection(region, hasCrop) {
  if (!hasCrop || !region) return 'Full file';
  const span = Math.max(0, Number(region.out) - Number(region.in));
  return `${fmtClock(region.in)} – ${fmtClock(region.out)} · ${fmtClock(span)}`;
}

/** Engineer badge + pipeline detail, truncated for the collapsed bar. */
export function readBadgeStatus(badge, detail) {
  const text = (detail?.textContent || badge?.querySelector?.('.vip-pb-label')?.textContent || 'Ready')
    .replace(/\s+/g, ' ')
    .trim();
  return { text, state: badge?.dataset?.state || 'idle' };
}

/** Landing Quick Clean stage, mapped onto the same ready/processing/error dots. */
export function readQuickCleanStatus(statusEl, fallbackEl) {
  const text = (statusEl?.textContent || fallbackEl?.textContent || 'Ready')
    .replace(/\s+/g, ' ')
    .trim();
  const raw = statusEl?.dataset?.state || 'idle';
  let state = 'idle';
  if (raw === 'error') state = 'error';
  else if (raw === 'processing' || raw === 'importing' || raw === 'downloading' || raw === 'cancelling' || raw === 'exporting') {
    state = 'processing';
  } else if (raw === 'processed' || raw === 'ready' || raw === 'comparing' || raw === 'exported') {
    state = 'ready';
  }
  return { text, state };
}

export function paintTransportStatus(ready, status, info) {
  const text = String(info?.text || 'Ready').replace(/\s+/g, ' ').trim() || 'Ready';
  const state = info?.state || 'idle';
  if (ready) {
    ready.dataset.state = state;
    ready.textContent = text.length > READY_LIMIT ? `${text.slice(0, READY_LIMIT - 2)}…` : text;
  }
  if (status && status.textContent !== text) status.textContent = text;
  return { text, state };
}

/**
 * Clicks on the bar's own controls must not open or close the disclosure.
 * The summary's default action is the toggle; preventDefault leaves the
 * control's click listeners intact.
 */
export function guardTransportSummary(card) {
  if (!card || card.dataset.pacGuard === '1') return;
  card.dataset.pacGuard = '1';
  card.addEventListener('click', (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest('.pac-bar')) return;
    if (target.closest('button, input, select, textarea, a, label')) event.preventDefault();
  });
}

/**
 * Collapsed until the user opens it. The stored flag is per surface so
 * Stems and Engineer remember their own disclosure.
 */
export function bindTransportOpen(card, storage, key) {
  if (!card || card.dataset.pacOpenWired === '1') return;
  card.dataset.pacOpenWired = '1';
  let stored = null;
  try { stored = storage ? storage.getItem(key) : null; } catch { stored = null; }
  card.open = stored == null ? false : stored === '1';
  const summary = typeof card.querySelector === 'function' ? card.querySelector('summary') : null;
  const paint = () => {
    if (summary) summary.setAttribute('aria-expanded', card.open ? 'true' : 'false');
  };
  paint();
  card.addEventListener('toggle', () => {
    paint();
    try { storage?.setItem(key, card.open ? '1' : '0'); } catch { /* private mode */ }
  });
}

/** Mirror a status source into the collapsed chip and the expanded line. */
export function watchTransportStatus({ ready, status, sources = [], read } = {}) {
  const paint = () => {
    let info = { text: 'Ready', state: 'idle' };
    try {
      const next = read?.();
      if (next) info = next;
    } catch { /* keep the last safe label */ }
    paintTransportStatus(ready, status, info);
  };
  paint();
  const nodes = (sources || []).filter(Boolean);
  if (nodes.length && typeof MutationObserver === 'function') {
    const obs = new MutationObserver(paint);
    nodes.forEach((node) => obs.observe(node, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-state'],
    }));
  }
  return paint;
}

/**
 * Keep Isolate on the collapsed bar. The expanded Processing group receives
 * the same button only while the dock is open. append() reparents; never clone.
 */
export function placeProcessButton({ open, bar, slot, button } = {}) {
  const target = open && slot ? slot : (bar || slot || null);
  if (!target || !button || (typeof target.contains === 'function' && target.contains(button))) return target;
  target.append(button);
  return target;
}

/** Move a <select> by one option and emit change. Stops at the ends. */
export function stepSelect(select, direction) {
  if (!select?.options?.length) return null;
  const values = Array.from(select.options, (option) => option.value);
  const index = values.indexOf(String(select.value));
  const next = index + direction;
  if (index < 0 || next < 0 || next >= values.length) return select.value;
  select.value = values[next];
  if (typeof select.dispatchEvent === 'function') {
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return select.value;
}
