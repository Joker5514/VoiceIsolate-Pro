'use strict';
// session-persist.js — VoiceIsolate Pro
// Persists DSP parameter state across page refreshes using sessionStorage.
// Also exposes window.VIP_PARAMS as a live store backed by sessionStorage.

const SESSION_KEY = 'vip_params_v1';

const SessionPersist = {
  set(key, value) {
    try {
      const store = this._load();
      store[key] = value;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(store));
    } catch (e) {
      console.warn('[session-persist] set failed:', e.message);
    }
  },

  get(key, defaultValue = null) {
    try {
      const store = this._load();
      return key in store ? store[key] : defaultValue;
    } catch {
      return defaultValue;
    }
  },

  saveAll(params) {
    try {
      const current = this._load();
      const merged = { ...current, ...params };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(merged));
    } catch (e) {
      console.warn('[session-persist] saveAll failed:', e.message);
    }
  },

  loadAll() {
    return this._load();
  },

  clear() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch (e) {
      console.warn('[session-persist] clear failed:', e.message);
    }
  },

  _load() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }
};

// Initialize window.VIP_PARAMS as the loaded store.
// Existing code that reads window.VIP_PARAMS[key] keeps working.
if (typeof window !== 'undefined') {
  if (!window.VIP_PARAMS) window.VIP_PARAMS = SessionPersist.loadAll();
  window.SessionPersist = SessionPersist;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SessionPersist;
}
