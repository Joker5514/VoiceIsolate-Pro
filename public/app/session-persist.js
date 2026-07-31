// session-persist.js — VoiceIsolate Pro
// Persists 52-slider state, preset name, active tab, bypass state,
// and processing mode across reloads via localStorage + sessionStorage.
// ZERO_EXTERNAL_CALLS: this file makes no network requests.
//
// AUDIT-FIX #9 (2026-05-26): All localStorage / sessionStorage calls are now
// wrapped in a sandbox-guard. Sandboxed iframes (e.g. demo embeds, some Vercel
// preview contexts) throw a SecurityError synchronously on ANY storage access —
// even the try/catch in the original code could not catch it because the throw
// happens before the JS try block executes in strict sandbox environments.
// The guard probes storage ONCE at module load and degrades gracefully to an
// in-memory Map when storage is unavailable.

// ── Sandbox guard ─────────────────────────────────────────────────────────────

const _canUseLocal   = _probeStorage('localStorage');
const _canUseSession = _probeStorage('sessionStorage');

// In-memory fallbacks used when storage is unavailable (sandboxed iframe, etc.).
const _memLocal   = new Map();
const _memSession = new Map();

function _probeStorage(type) {
  try {
    const s = window[type];
    const key = '__vip_probe_' + Date.now();
    s.setItem(key, '1');
    s.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function _lsGet(key) {
  if (_canUseLocal) {
    try { return localStorage.getItem(key); } catch { /* fall through */ }
  }
  return _memLocal.get(key) ?? null;
}

function _lsSet(key, value) {
  if (_canUseLocal) {
    try { localStorage.setItem(key, value); return; } catch { /* fall through */ }
  }
  _memLocal.set(key, value);
}

function _lsDel(key) {
  if (_canUseLocal) {
    try { localStorage.removeItem(key); return; } catch { /* fall through */ }
  }
  _memLocal.delete(key);
}

function _ssGet(key) {
  if (_canUseSession) {
    try { return sessionStorage.getItem(key); } catch { /* fall through */ }
  }
  return _memSession.get(key) ?? null;
}

function _ssSet(key, value) {
  if (_canUseSession) {
    try { sessionStorage.setItem(key, value); return; } catch { /* fall through */ }
  }
  _memSession.set(key, value);
}

// ── Keys ──────────────────────────────────────────────────────────────────────

const SESSION_KEY      = 'vip-session-v2';
const SESSION_TEMP_KEY = 'vip-session-temp-v2';

/**
 * Persist full session state to localStorage (with in-memory fallback).
 * @param {Object} params  - All 52 slider keys + values
 * @param {Object} meta    - { activeTab, presetName, bypassState, mode }
 */
export function saveSession(params, meta) {
  try {
    _lsSet(SESSION_KEY, JSON.stringify({
      params:  { ...params },
      meta:    { ...meta   },
      savedAt: Date.now(),
    }));
  } catch (err) {
    console.warn('[session-persist] saveSession failed:', err);
  }
}

/**
 * Load persisted session from localStorage (or in-memory fallback).
 * @returns {{ params: Object, meta: Object } | null}
 */
export function loadSession() {
  try {
    const raw = _lsGet(SESSION_KEY);
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
 * Delete the persisted session.
 */
export function clearSession() {
  try {
    _lsDel(SESSION_KEY);
  } catch (err) {
    console.warn('[session-persist] clearSession failed:', err);
  }
}

/**
 * Write tab-scoped state to sessionStorage (or in-memory fallback).
 * @param {Object} data - Any JSON-serializable object
 */
export function saveSessionTemp(data) {
  try {
    _ssSet(SESSION_TEMP_KEY, JSON.stringify({
      data,
      savedAt: Date.now(),
    }));
  } catch (err) {
    console.warn('[session-persist] saveSessionTemp failed:', err);
  }
}

/**
 * Read tab-scoped state from sessionStorage (or in-memory fallback).
 * @returns {Object | null}
 */
export function loadSessionTemp() {
  try {
    const raw = _ssGet(SESSION_TEMP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.data ?? null;
  } catch (err) {
    console.warn('[session-persist] loadSessionTemp parse error:', err);
    return null;
  }
}

// ── App wiring helpers (used by app.js) ─────────────────────────────────────

/**
 * Snapshot slider params + light meta for durable restore.
 * @param {Record<string, number|string|boolean>} params
 * @param {{ activeTab?: string, presetName?: string, bypassState?: boolean, mode?: string }} [meta]
 */
export function persistAppSession(params, meta = {}) {
  if (!params || typeof params !== 'object') return;
  saveSession(params, {
    activeTab: meta.activeTab ?? null,
    presetName: meta.presetName ?? null,
    bypassState: meta.bypassState ?? false,
    mode: meta.mode ?? 'engineer',
  });
}

/**
 * Apply saved session params onto a flat params object and optional DOM ranges.
 * @param {Record<string, number>} targetParams  mutated in place when provided
 * @param {{ applyDom?: boolean }} [opts]
 * @returns {{ params: object, meta: object }|null}
 */
export function restoreAppSession(targetParams = null, opts = {}) {
  const loaded = loadSession();
  if (!loaded?.params) return null;
  if (targetParams && typeof targetParams === 'object') {
    for (const [k, v] of Object.entries(loaded.params)) {
      if (typeof v === 'number' && Number.isFinite(v)) targetParams[k] = v;
    }
  }
  if (opts.applyDom !== false && typeof document !== 'undefined') {
    for (const [k, v] of Object.entries(loaded.params)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const el = document.getElementById(`sl_${k}`) || document.querySelector(`[data-param="${k}"]`);
      if (el && 'value' in el) {
        try {
          el.value = String(v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } catch { /* ignore */ }
      }
    }
  }
  return loaded;
}

// Expose for classic script consumers / debug
if (typeof window !== 'undefined') {
  window.VIPSessionPersist = {
    saveSession,
    loadSession,
    clearSession,
    saveSessionTemp,
    loadSessionTemp,
    persistAppSession,
    restoreAppSession,
  };
}
