/**
 * UI-only persistence. Never stores audio. Memory profile and research
 * checkboxes survive reload; factory DSP defaults stay in the slider registry.
 */
export const PANEL_SIZES_KEY = 'vip-panel-sizes';

/**
 * Read the persisted resizable-panel sizes.
 * Shape: `{ rackW: number|null, heights: { [sectionId]: number } }`.
 * Anything malformed, non-numeric, or non-positive is dropped; the result is
 * always a valid object so callers never have to null-check.
 */
export function readStoredPanelSizes(storage) {
  const fallback = { rackW: null, heights: {} };
  let raw;
  try {
    raw = storageOf(storage).getItem(PANEL_SIZES_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  const out = { rackW: null, heights: {} };
  if (Number.isFinite(parsed.rackW) && parsed.rackW > 0) out.rackW = parsed.rackW;
  if (parsed.heights && typeof parsed.heights === 'object' && !Array.isArray(parsed.heights)) {
    for (const [id, value] of Object.entries(parsed.heights)) {
      if (typeof id === 'string' && id && Number.isFinite(value) && value > 0) {
        out.heights[id] = value;
      }
    }
  }
  return out;
}

/**
 * Persist resizable-panel sizes. Returns false (never throws) when storage
 * is unavailable, matching the other helpers in this module.
 */
export function writeStoredPanelSizes(sizes, storage) {
  try {
    const clean = { rackW: null, heights: {} };
    if (sizes && typeof sizes === 'object') {
      if (Number.isFinite(sizes.rackW) && sizes.rackW > 0) clean.rackW = sizes.rackW;
      if (sizes.heights && typeof sizes.heights === 'object') {
        for (const [id, value] of Object.entries(sizes.heights)) {
          if (typeof id === 'string' && id && Number.isFinite(value) && value > 0) {
            clean.heights[id] = value;
          }
        }
      }
    }
    storageOf(storage).setItem(PANEL_SIZES_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

export const MEMORY_PROFILE_KEY = 'vip-memory-profile';
export const MEMORY_PROFILES = Object.freeze(['AUTO', 'LOW', 'BALANCED', 'HIGH']);
export const RESEARCH_ENABLE_KEY = 'vip-research-enable';
export const RESEARCH_DETERMINISTIC_KEY = 'vip-research-deterministic';

function storageOf(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

export function readStoredMemoryProfile(storage) {
  const store = storageOf(storage);
  if (!store) return null;
  try {
    const value = store.getItem(MEMORY_PROFILE_KEY);
    return MEMORY_PROFILES.includes(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeStoredMemoryProfile(value, storage) {
  if (!MEMORY_PROFILES.includes(value)) return false;
  const store = storageOf(storage);
  if (!store) return false;
  try {
    store.setItem(MEMORY_PROFILE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore a saved profile onto a <select>, then persist later changes.
 * Calls onChange with the restored value once when a saved profile applies.
 */
export function bindMemoryProfileSelect(select, { storage, onChange } = {}) {
  if (!select) return () => {};
  const stored = readStoredMemoryProfile(storage);
  const allowed = [...(select.options || [])].some((opt) => opt.value === stored);
  if (stored && allowed && select.value !== stored) {
    select.value = stored;
    if (typeof onChange === 'function') onChange(stored);
  }
  const onSelect = () => {
    writeStoredMemoryProfile(select.value, storage);
    if (typeof onChange === 'function') onChange(select.value);
  };
  select.addEventListener('change', onSelect);
  return () => select.removeEventListener('change', onSelect);
}

export function readStoredCheckbox(key, storage) {
  const store = storageOf(storage);
  if (!store) return null;
  try {
    const value = store.getItem(key);
    if (value === '1') return true;
    if (value === '0') return false;
    return null;
  } catch {
    return null;
  }
}

export function bindCheckbox(input, key, storage) {
  if (!input || !key) return () => {};
  const stored = readStoredCheckbox(key, storage);
  if (stored != null) input.checked = stored;
  const onToggle = () => {
    const store = storageOf(storage);
    if (!store) return;
    try { store.setItem(key, input.checked ? '1' : '0'); } catch { /* private mode */ }
  };
  input.addEventListener('change', onToggle);
  return () => input.removeEventListener('change', onToggle);
}

/**
 * Per-mode workspace layout. Audio is never stored.
 * Shape: `{ v: 1, stems: { blocks }, engineer: { blocks } }`.
 * Each block is `{ h?, w?, collapsed?, maximized?, order?, pre?: { h?, w? } }`.
 * A bad version, a non-object, or a junk field is dropped. Callers always
 * receive both modes.
 */
export const WORKSPACE_LAYOUT_KEY = 'vip-workspace-layouts';
export const WORKSPACE_LAYOUT_VERSION = 1;

export function emptyWorkspaceLayouts() {
  return {
    v: WORKSPACE_LAYOUT_VERSION,
    stems: { blocks: {} },
    engineer: { blocks: {} },
  };
}

function cleanLayoutNumber(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

export function cleanWorkspaceBlock(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  const h = cleanLayoutNumber(value.h);
  const w = cleanLayoutNumber(value.w);
  if (h != null) out.h = h;
  if (w != null) out.w = w;
  if (value.collapsed === true) out.collapsed = true;
  if (value.maximized === true) out.maximized = true;
  if (Number.isInteger(value.order)) out.order = value.order;
  if (value.pre && typeof value.pre === 'object' && !Array.isArray(value.pre)) {
    const pre = {};
    const preH = cleanLayoutNumber(value.pre.h);
    const preW = cleanLayoutNumber(value.pre.w);
    if (preH != null) pre.h = preH;
    if (preW != null) pre.w = preW;
    if (pre.h != null || pre.w != null) out.pre = pre;
  }
  return Object.keys(out).length ? out : null;
}

function cleanModeBlocks(mode) {
  const blocks = {};
  if (!mode || typeof mode !== 'object' || Array.isArray(mode)) return blocks;
  const source = mode.blocks;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return blocks;
  for (const [id, value] of Object.entries(source)) {
    if (typeof id !== 'string' || !id) continue;
    const clean = cleanWorkspaceBlock(value);
    if (clean) blocks[id] = clean;
  }
  return blocks;
}

export function readWorkspaceLayouts(storage) {
  const fallback = emptyWorkspaceLayouts();
  let raw;
  try {
    raw = storageOf(storage).getItem(WORKSPACE_LAYOUT_KEY);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
  if (parsed.v !== WORKSPACE_LAYOUT_VERSION) return fallback;
  return {
    v: WORKSPACE_LAYOUT_VERSION,
    stems: { blocks: cleanModeBlocks(parsed.stems) },
    engineer: { blocks: cleanModeBlocks(parsed.engineer) },
  };
}

export function writeWorkspaceLayouts(layouts, storage) {
  try {
    const current = layouts && typeof layouts === 'object' ? layouts : {};
    const clean = {
      v: WORKSPACE_LAYOUT_VERSION,
      stems: { blocks: cleanModeBlocks(current.stems) },
      engineer: { blocks: cleanModeBlocks(current.engineer) },
    };
    storageOf(storage).setItem(WORKSPACE_LAYOUT_KEY, JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}
