/**
 * UI-only persistence. Never stores audio. Memory profile and research
 * checkboxes survive reload; factory DSP defaults stay in the slider registry.
 */
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
