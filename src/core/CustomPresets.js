/**
 * User custom Engineer presets — pure storage logic, no DOM.
 *
 * A custom preset is a flat map of slider id → numeric value, saved by the
 * "Save Custom" modal in the Engineer UI. Built-in presets come from
 * PresetCalibration; custom presets live in localStorage under
 * CUSTOM_PRESETS_KEY and are merged into the runtime PRESETS map at boot.
 * They never overwrite a built-in preset name (the modal refuses the
 * collision); a custom preset may overwrite an earlier custom preset of
 * the same name.
 */

/** localStorage key for the custom preset map. */
export const CUSTOM_PRESETS_KEY = 'vip.customPresets.v1';

/** Hard cap so a corrupted or abused store cannot grow without bound. */
export const MAX_CUSTOM_PRESETS = 50;

/** Maximum preset name length (characters). */
export const MAX_PRESET_NAME = 80;

/**
 * Validate a raw parsed store value into a clean name → values map.
 * Drops non-object stores, non-object presets, non-finite values, and
 * over-long names; keeps only the first MAX_CUSTOM_PRESETS entries.
 * Never throws.
 */
export function sanitizeCustomPresets(raw) {
  const out = Object.create(null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, values] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_CUSTOM_PRESETS) break;
    if (typeof name !== 'string' || !name.trim() || name.length > MAX_PRESET_NAME) continue;
    if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
    const clean = Object.create(null);
    for (const [id, value] of Object.entries(values)) {
      const num = Number(value);
      if (Number.isFinite(num)) clean[id] = num;
    }
    out[name] = clean;
  }
  return out;
}

/** Read the custom preset map from a storage-like object (localStorage). Never throws. */
export function loadCustomPresets(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return Object.create(null);
    const raw = storage.getItem(CUSTOM_PRESETS_KEY);
    if (!raw) return Object.create(null);
    return sanitizeCustomPresets(JSON.parse(raw));
  } catch {
    return Object.create(null);
  }
}

/** Persist the custom preset map. Returns false when storage is unavailable or the write fails. */
export function persistCustomPresets(storage, map) {
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    storage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a complete preset value map from current slider values.
 * Every spec id is present (missing values fall back to the spec default)
 * and every value is clamped to [min, max] — the same contract the
 * built-in PRESETS map enforces at boot, so applyPreset can consume the
 * result without further validation.
 */
export function buildCustomPresetValues(current, specs) {
  const out = Object.create(null);
  for (const spec of specs) {
    if (!spec || !spec.id) continue;
    const raw = current ? current[spec.id] : undefined;
    const fallback = Number.isFinite(Number(spec.val)) ? Number(spec.val) : 0;
    const candidate = Number.isFinite(Number(raw)) ? Number(raw) : fallback;
    if (Number.isFinite(Number(spec.min)) && Number.isFinite(Number(spec.max))) {
      out[spec.id] = Math.min(Number(spec.max), Math.max(Number(spec.min), candidate));
    } else {
      out[spec.id] = candidate;
    }
  }
  return out;
}

/** True when a name is already taken by a built-in preset or redirect alias. */
export function isBuiltInPresetName(name, builtInNames) {
  return Boolean(builtInNames && builtInNames.has(name));
}

/**
 * Ensure a preset <option> exists in a select element and, by default,
 * select it. `doc` is injectable so tests can pass a stub document.
 * Returns true when an option was added, false when it already existed.
 */
export function upsertPresetOption(selectEl, name, { select = true, doc = undefined } = {}) {
  if (!selectEl) return false;
  const options = selectEl.options ? [...selectEl.options] : [];
  const exists = options.some((o) => o && o.value === name);
  if (!exists) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!documentRef || typeof documentRef.createElement !== 'function') return false;
    const option = documentRef.createElement('option');
    option.value = name;
    option.textContent = name;
    if (typeof selectEl.appendChild === 'function') selectEl.appendChild(option);
    else if (Array.isArray(selectEl.options)) selectEl.options.push(option);
    else return false;
  }
  if (select) {
    try {
      selectEl.value = name;
    } catch {
      /* ignore */
    }
  }
  return !exists;
}
