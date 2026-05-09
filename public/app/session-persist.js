// session-persist.js — VoiceIsolate Pro
// Persists 52-slider state, preset name, active tab, bypass state,
// and processing mode across reloads via localStorage + sessionStorage.
// ZERO_EXTERNAL_CALLS: this file makes no network requests.

const SESSION_KEY      = 'vip-session-v2';
const SESSION_TEMP_KEY = 'vip-session-temp-v2';

/**
 * Persist full session state to localStorage.
 * @param {Object} params  - All 52 slider keys + values
 * @param {Object} meta    - { activeTab, presetName, bypassState, mode }
 */
export function saveSession(params, meta) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      params:  { ...params },
      meta:    { ...meta   },
      savedAt: Date.now(),
    }));
  } catch (err) {
    console.warn('[session-persist] saveSession failed:', err);
  }
}

/**
 * Load persisted session from localStorage.
 * @returns {{ params: Object, meta: Object } | null}
 */
export function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.params !== 'object') return null;
    return { params: parsed.params, meta: parsed.meta ?? {} };
  } catch (err) {
    console.warn('[session-persist] loadSession parse error:', err);
    return null;
  }
}

/**
 * Delete the persisted session from localStorage.
 */
export function clearSession() {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch (err) {
    console.warn('[session-persist] clearSession failed:', err);
  }
}

/**
 * Write tab-scoped state to sessionStorage.
 * Automatically cleared when the browser tab closes.
 * @param {Object} data - Any JSON-serializable object
 */
export function saveSessionTemp(data) {
  try {
    sessionStorage.setItem(SESSION_TEMP_KEY, JSON.stringify({
      data,
      savedAt: Date.now(),
    }));
  } catch (err) {
    console.warn('[session-persist] saveSessionTemp failed:', err);
  }
}

/**
 * Read tab-scoped state from sessionStorage.
 * @returns {Object | null}
 */
export function loadSessionTemp() {
  try {
    const raw = sessionStorage.getItem(SESSION_TEMP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.data ?? null;
  } catch (err) {
    console.warn('[session-persist] loadSessionTemp parse error:', err);
    return null;
  }
}
