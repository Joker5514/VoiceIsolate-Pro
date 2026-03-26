/* ============================================
   VoiceIsolate Pro v20.0 — PipelineState
   Threads from Space v10 · State Management
   52-Param Pub/Sub · Undo/Redo · Wildcard
   ============================================ */

'use strict';

/**
 * Centralized state for all 52 slider parameters.
 * - Pub/sub event system with per-key and wildcard listeners
 * - Undo/redo via Map snapshots
 * - Broadcasts to AudioWorklet via port.postMessage
 */
class PipelineState {
  constructor() {
    this._params = new Map();
    this._listeners = new Map();   // key → Set<fn>
    this._wildcards = new Set();   // fns called on ANY change
    this._history = [];            // undo stack
    this._future = [];             // redo stack
    this._maxHistory = 50;
    this._workletPort = null;
    this._batchMode = false;
    this._batchChanges = new Map();
  }

  /** Register all slider definitions and set defaults */
  registerSliders(sliderDefs) {
    for (const [group, sliders] of Object.entries(sliderDefs)) {
      for (const s of sliders) {
        this._params.set(s.id, {
          value: s.val,
          min: s.min,
          max: s.max,
          step: s.step,
          group,
          rt: s.rt || false,
          label: s.label,
          unit: s.unit || '',
          desc: s.desc || ''
        });
      }
    }
  }

  /** Get current value of a parameter */
  get(key) {
    const p = this._params.get(key);
    return p ? p.value : undefined;
  }

  /** Get full param descriptor */
  getMeta(key) {
    return this._params.get(key) || null;
  }

  /** Set a parameter value, notify listeners, push to worklet */
  set(key, value, { recordHistory = true, source = 'user' } = {}) {
    const p = this._params.get(key);
    if (!p) return;

    const clamped = Math.min(p.max, Math.max(p.min, value));
    const rounded = Math.round(clamped / p.step) * p.step;
    const prev = p.value;
    if (Math.abs(rounded - prev) < p.step * 0.01) return;

    if (recordHistory && !this._batchMode) {
      this._pushUndo();
    }

    p.value = rounded;

    if (this._batchMode) {
      this._batchChanges.set(key, { prev, value: rounded });
    } else {
      this._notify(key, rounded, prev, source);
    }
  }

  /** Begin batch update (defers notifications) */
  beginBatch() {
    this._batchMode = true;
    this._batchChanges.clear();
    this._pushUndo();
  }

  /** Commit batch update, fire all notifications */
  commitBatch(source = 'preset') {
    this._batchMode = false;
    const changes = new Map(this._batchChanges);
    this._batchChanges.clear();

    for (const [key, { prev, value }] of changes) {
      this._notify(key, value, prev, source);
    }

    // Bulk worklet broadcast
    if (this._workletPort) {
      const bulk = {};
      for (const [key, { value }] of changes) {
        const p = this._params.get(key);
        if (p && p.rt) bulk[key] = value;
      }
      if (Object.keys(bulk).length > 0) {
        this._workletPort.postMessage({ type: 'paramBulk', params: bulk });
      }
    }
  }

  /** Subscribe to changes on a specific key */
  on(key, fn) {
    if (!this._listeners.has(key)) this._listeners.set(key, new Set());
    this._listeners.get(key).add(fn);
    return () => this._listeners.get(key)?.delete(fn);
  }

  /** Subscribe to ALL parameter changes */
  onAny(fn) {
    this._wildcards.add(fn);
    return () => this._wildcards.delete(fn);
  }

  /** Undo to previous state */
  undo() {
    if (this._history.length === 0) return false;
    this._future.push(this._snapshot());
    const snap = this._history.pop();
    this._restore(snap);
    return true;
  }

  /** Redo last undone state */
  redo() {
    if (this._future.length === 0) return false;
    this._history.push(this._snapshot());
    const snap = this._future.pop();
    this._restore(snap);
    return true;
  }

  /** Export all params as plain object */
  export() {
    const out = {};
    for (const [key, p] of this._params) {
      out[key] = p.value;
    }
    return out;
  }

  /** Import params from plain object */
  import(obj, source = 'import') {
    this.beginBatch();
    for (const [key, value] of Object.entries(obj)) {
      if (this._params.has(key)) {
        this.set(key, value, { recordHistory: false, source });
      }
    }
    this.commitBatch(source);
  }

  /** Set the AudioWorklet port for real-time param sync */
  setWorkletPort(port) {
    this._workletPort = port;
  }

  /** Get all param keys */
  keys() {
    return [...this._params.keys()];
  }

  /** Get params grouped by tab */
  grouped() {
    const groups = {};
    for (const [key, p] of this._params) {
      if (!groups[p.group]) groups[p.group] = [];
      groups[p.group].push({ id: key, ...p });
    }
    return groups;
  }

  // ---- Internal ----

  _notify(key, value, prev, source) {
    const detail = { key, value, prev, source };

    // Per-key listeners
    const set = this._listeners.get(key);
    if (set) for (const fn of set) fn(detail);

    // Wildcard listeners
    for (const fn of this._wildcards) fn(detail);

    // Real-time params → worklet
    const p = this._params.get(key);
    if (p && p.rt && this._workletPort && source !== 'worklet') {
      this._workletPort.postMessage({ type: 'param', key, value });
    }
  }

  _pushUndo() {
    this._history.push(this._snapshot());
    if (this._history.length > this._maxHistory) this._history.shift();
    this._future.length = 0;
  }

  _snapshot() {
    const snap = new Map();
    for (const [key, p] of this._params) snap.set(key, p.value);
    return snap;
  }

  _restore(snap) {
    for (const [key, value] of snap) {
      const p = this._params.get(key);
      if (p) {
        const prev = p.value;
        p.value = value;
        this._notify(key, value, prev, 'history');
      }
    }
  }
}

// Singleton export
if (typeof window !== 'undefined') {
  window.PipelineState = PipelineState;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PipelineState;
}
