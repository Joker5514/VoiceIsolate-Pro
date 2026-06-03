/**
 * VoiceIsolate Pro — state-manager.js
 * =====================================
 * Lightweight observable state store for the main-thread UI layer.
 * Provides a single source of truth for UI-visible state, separate from
 * the AudioWorklet parameter lane (managed by pipeline-state.js).
 *
 * Deduplicates the scatter of global mutable variables (isPlaying, mode,
 * inputBuffer, etc.) that previously lived directly on VoiceIsolatePro instance
 * without change notification.
 *
 * Usage:
 *   import { appState } from './state-manager.js';
 *   appState.set('isPlaying', true);
 *   appState.subscribe('isPlaying', (val) => updatePlayButton(val));
 */

class StateManager {
  constructor(initial = {}) {
    this._state = { ...initial };
    this._listeners = new Map();  // key → Set<fn>
    this._anyListeners = new Set();
  }

  /**
   * Get the current value for a key.
   * @template T
   * @param {string} key
   * @returns {T}
   */
  get(key) {
    return this._state[key];
  }

  /**
   * Get a snapshot of the full state object (shallow copy).
   * @returns {Object}
   */
  getState() {
    return { ...this._state };
  }

  /**
   * Update a single key and notify subscribers.
   * No-op if the value is strictly equal to the current value.
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    if (this._state[key] === value) return;
    const prev = this._state[key];
    this._state[key] = value;
    this._notify(key, value, prev);
  }

  /**
   * Update multiple keys atomically.
   * Subscribers are notified once per changed key after all updates.
   * @param {Object} patch
   */
  patch(patch) {
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      if (this._state[key] !== value) {
        const prev = this._state[key];
        this._state[key] = value;
        changed.push({ key, value, prev });
      }
    }
    for (const { key, value, prev } of changed) {
      this._notify(key, value, prev);
    }
  }

  /**
   * Subscribe to changes for a specific key.
   * @param {string} key
   * @param {function(value: *, prev: *): void} fn
   * @returns {function(): void} unsubscribe
   */
  subscribe(key, fn) {
    if (!this._listeners.has(key)) {
      this._listeners.set(key, new Set());
    }
    this._listeners.get(key).add(fn);
    return () => this.unsubscribe(key, fn);
  }

  /**
   * Subscribe to ALL state changes.
   * @param {function(key: string, value: *, prev: *): void} fn
   * @returns {function(): void} unsubscribe
   */
  subscribeAll(fn) {
    this._anyListeners.add(fn);
    return () => this._anyListeners.delete(fn);
  }

  /**
   * Remove a subscriber for a specific key.
   * @param {string} key
   * @param {function} fn
   */
  unsubscribe(key, fn) {
    const set = this._listeners.get(key);
    if (set) {
      set.delete(fn);
      if (set.size === 0) this._listeners.delete(key);
    }
  }

  /**
   * Dispatch a named event (fire-and-forget, not stored in state).
   * Useful for transient events like 'processingComplete', 'errorOccurred'.
   * @param {string} eventName
   * @param {*} payload
   */
  dispatch(eventName, payload) {
    this._notify(eventName, payload, undefined);
  }

  _notify(key, value, prev) {
    const listeners = this._listeners.get(key);
    if (listeners) {
      for (const fn of listeners) {
        try { fn(value, prev); } catch (e) { console.error('[StateManager] listener error', e); }
      }
    }
    for (const fn of this._anyListeners) {
      try { fn(key, value, prev); } catch (e) { console.error('[StateManager] subscribeAll error', e); }
    }
  }

  /**
   * Reset state to initial values, clearing all listeners.
   */
  reset() {
    this._state = {};
    this._listeners.clear();
    this._anyListeners.clear();
  }
}

/**
 * Application-level singleton state.
 * Keys and their initial values:
 */
export const appState = new StateManager({
  mode: 'idle',           // 'idle' | 'processing' | 'playing' | 'recording'
  isPlaying: false,
  isProcessing: false,
  isRecording: false,
  ctxReady: false,
  workletReady: false,
  mlReady: false,
  onnxReady: false,
  dspOnlyMode: false,
  abMode: 'original',     // 'original' | 'processed'
  currentFFTSize: 4096,
  currentNumBins: 2049,
  sampleRate: 48000,
  inputDuration: 0,
  playOffset: 0,
  playSpeed: 1,
  peakDb: -60,
  rmsDb: -60,
  allowedModels: [],
  allowedStages: [],
  hasInputFile: false,
  hasOutputFile: false,
  processingProgress: 0,
  processingStage: '',
  errorMessage: null,
  warnMessage: null,
});

export default StateManager;

// CJS compat for tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { StateManager, appState };
}
