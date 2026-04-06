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

  /** Get all parameter keys */
  keys() {
    return Array.from(this._params.keys());
  }

  /** Get full param descriptor */
  getMeta(key) {
    const p = this._params.get(key);
    if (!p) return null;
    return { value: p.value, rt: p.rt, min: p.min, max: p.max, default: p.default || p.value, group: p.group };
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

/* ============================================
   DSPConfig — Feature Flags & Runtime State
   Adaptive Wiener · DNS v2 · Multi-Speaker
   Harmonic v2 · Noise Classifier
   ============================================ */

/**
 * Runtime configuration and state for the advanced DSP features added in v21.
 * Holds feature-enable flags, the current noise classification result, the
 * multi-speaker separation mode, and adaptive noise floor state for display.
 *
 * Designed to be read by dsp-worker.js (via params export) and written to
 * by pipeline-orchestrator.js when ML results arrive.
 */
class DSPConfig {
  constructor() {
    // ---- Feature flags (all individually toggleable) ----
    /** Enable per-bin adaptive Wiener filter (replaces fixed noise profile path) */
    this.adaptiveWienerEnabled = true;

    /** Enable DNS v2 ONNX gain mask after Wiener filter */
    this.dns2Enabled = true;

    /** Enable multi-speaker source separation (Pass 4.5) */
    this.multiSpeakerEnabled = false; // opt-in (resource intensive)

    /** Enable Harmonic Enhancer v2 (SBR + formant + breathiness) */
    this.harmonicV2Enabled = true;

    /** Enable lightweight spectral noise classifier */
    this.noiseClassifierEnabled = true;

    // ---- Multi-speaker separation config ----
    /**
     * Source separation routing mode.
     * 'target-only' — route target speaker to Pass 5; attenuate others
     * 'all-speakers' — mix all separated streams back before Pass 5
     * 'off'          — bypass separation entirely
     * @type {'target-only'|'all-speakers'|'off'}
     */
    this.separationMode = 'target-only';

    /** 0-based index of the target speaker to route to Pass 5 */
    this.targetSpeaker = 0;

    /** Attenuation in dB applied to non-target speaker streams for monitoring */
    this.separationAttenuationDb = -24;

    // ---- Adaptive Wiener config ----
    /** Smoothing time constant for the noise floor tracker (ms) */
    this.adaptiveWienerSmoothingMs = 200;

    /** Over-subtraction factor α for the adaptive Wiener filter */
    this.adaptiveWienerOverSubtraction = 1.2;

    // ---- Harmonic v2 config ----
    /** Enable Spectral Band Replication above 8 kHz */
    this.harmonicV2SBR = true;

    /** Enable formant (F1/F2) preservation in harmonic enhancer */
    this.harmonicV2FormantProtection = true;

    /** Breathiness gain applied to aperiodic component (0–2) */
    this.harmonicV2BreathinessGain = 0.8;

    // ---- Runtime results (updated by ML worker callbacks) ----
    /**
     * Most recently classified noise type.
     * @type {'music'|'white_noise'|'crowd'|'HVAC'|'keyboard'|'traffic'|'silence'|'unknown'}
     */
    this.noiseClass = 'unknown';

    /** Confidence of the current noise class prediction (0..1) */
    this.noiseClassConfidence = 0;

    /** Whether the adaptive noise floor tracker has been initialized */
    this.adaptiveNoiseFloorReady = false;

    // ---- Change listeners ----
    this._listeners = new Set();
  }

  /** Apply a strategy update based on noise class (adjusts params for best suppression) */
  applyNoiseStrategy(noiseClass, extraConfig = {}) {
    switch (noiseClass) {
      case 'music':
        // Increase over-subtraction; enable Demucs vocal stem
        this.adaptiveWienerOverSubtraction = extraConfig.overSubtraction ?? 1.6;
        break;
      case 'white_noise':
        // Standard Wiener — reset to defaults
        this.adaptiveWienerOverSubtraction = 1.2;
        break;
      case 'crowd':
        // Enable multi-speaker separation for crowd noise
        this.multiSpeakerEnabled = true;
        this.separationMode = extraConfig.separationMode ?? 'target-only';
        break;
      case 'HVAC':
      case 'traffic':
        // Fast noise floor tracking
        this.adaptiveWienerSmoothingMs = extraConfig.smoothingMs ?? 80;
        break;
      default:
        break;
    }
    this._emit('noiseStrategy', { noiseClass, ...extraConfig });
  }

  /** Update noise class from ML classifier result */
  setNoiseClass(noiseClass, confidence) {
    const changed = this.noiseClass !== noiseClass;
    this.noiseClass = noiseClass;
    this.noiseClassConfidence = confidence;
    if (changed) this.applyNoiseStrategy(noiseClass);
    this._emit('noiseClass', { noiseClass, confidence });
  }

  /** Subscribe to DSPConfig changes */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Export config as a plain object (for passing to dsp-worker as params) */
  export() {
    const obj = {};
    for (const [key, p] of this._params.entries()) {
      obj[key] = p.value;
    }
    // Also include noise properties manually just in case
    obj.adaptiveWienerEnabled = this.adaptiveWienerEnabled;
    obj.dns2Enabled = this.dns2Enabled;
    obj.multiSpeakerEnabled = this.multiSpeakerEnabled;
    obj.noiseClassifierEnabled = this.noiseClassifierEnabled;
    obj.separationMode = this.separationMode;
    obj.targetSpeaker = this.targetSpeaker;
    obj.separationAttenuationDb = this.separationAttenuationDb;
    obj.adaptiveWienerSmoothingMs = this.adaptiveWienerSmoothingMs;
    obj.adaptiveWienerOverSubtraction = this.adaptiveWienerOverSubtraction;
    obj.noiseClass = this.noiseClass;
    obj.noiseClassConfidence = this.noiseClassConfidence;
    return obj;
  }

  _emit(event, detail) {
    for (const fn of this._listeners) {
      try { fn(event, detail); } catch (_) {}
    }
  }
}

/* ============================================
   SpeakerRegistry — Biometric Voice Profiles
   IndexedDB persistence · Cosine similarity
   Color-coded identities · Diarization support
   ============================================ */

/**
 * Manages biometric speaker profiles extracted via ECAPA-TDNN embeddings.
 * - Assigns each unique voice a persistent color-coded identity label
 * - Persists profiles to IndexedDB across page reloads
 * - Uses cosine similarity to match incoming embeddings against known profiles
 */
class SpeakerRegistry {
  constructor() {
    this._profiles = [];       // Array of { id, label, color, embedding: Float32Array, createdAt, lastSeen }
    this._nextId = 1;
    this._threshold = 0.65;   // Cosine similarity threshold for speaker match
    this._dbName = 'VoiceIsolateProDB';
    this._storeName = 'speakerProfiles';
    this._listeners = new Set();
    // Perceptually distinct colors for speaker identities
    this._colors = [
      '#ef4444', // Red
      '#3b82f6', // Blue
      '#22c55e', // Green
      '#eab308', // Yellow
      '#a855f7', // Purple
      '#f97316', // Orange
      '#06b6d4', // Cyan
      '#ec4899', // Pink
    ];
  }

  /**
   * Compute cosine similarity between two Float32Array embeddings.
   * @param {Float32Array} a
   * @param {Float32Array} b
   * @returns {number} Similarity in [-1, 1]; returns 0 if either vector is zero.
   */
  static cosineSimilarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      na  += a[i] * a[i];
      nb  += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  /**
   * Match an embedding against existing profiles, or create a new speaker profile.
   * @param {Float32Array} embedding - Speaker embedding from ECAPA-TDNN.
   * @returns {{ speaker: Object, similarity: number, isNew: boolean }}
   */
  identify(embedding) {
    let bestMatch = null;
    let bestSim = -1;

    for (const profile of this._profiles) {
      const sim = SpeakerRegistry.cosineSimilarity(embedding, profile.embedding);
      if (sim > bestSim) { bestSim = sim; bestMatch = profile; }
    }

    if (bestMatch && bestSim >= this._threshold) {
      bestMatch.lastSeen = Date.now();
      return { speaker: bestMatch, similarity: bestSim, isNew: false };
    }

    // No match — create a new profile
    const speaker = this._createProfile(embedding);
    this._emit();
    return { speaker, similarity: bestSim, isNew: true };
  }

  /**
   * Explicitly enroll a speaker with an optional custom label.
   * @param {Float32Array} embedding
   * @param {string} [label]
   * @returns {Object} The created speaker profile.
   */
  enroll(embedding, label) {
    const speaker = this._createProfile(embedding, label);
    this._emit();
    return speaker;
  }

  /**
   * Get all registered profiles (embedding data excluded).
   * @returns {Array<{ id: number, label: string, color: string, createdAt: number, lastSeen: number }>}
   */
  getProfiles() {
    return this._profiles.map(({ id, label, color, createdAt, lastSeen }) =>
      ({ id, label, color, createdAt, lastSeen })
    );
  }

  /** Remove a profile by its numeric ID. */
  removeProfile(id) {
    const before = this._profiles.length;
    this._profiles = this._profiles.filter(p => p.id !== id);
    if (this._profiles.length !== before) this._emit();
  }

  /** Remove all speaker profiles and reset the ID counter. */
  clearAll() {
    if (this._profiles.length > 0) {
      this._profiles = [];
      this._nextId = 1;
      this._emit();
    }
  }

  /**
   * Subscribe to profile list changes.
   * @param {Function} fn - Called with the current profile list on every change.
   * @returns {Function} Unsubscribe function.
   */
  onChange(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** Persist all profiles to IndexedDB. Silently fails in non-browser environments. */
  async save() {
    try {
      const db = await this._openDB();
      const tx = db.transaction(this._storeName, 'readwrite');
      const store = tx.objectStore(this._storeName);
      await this._idbClear(store);
      for (const p of this._profiles) {
        await this._idbPut(store, {
          id: p.id,
          label: p.label,
          color: p.color,
          embedding: Array.from(p.embedding),
          createdAt: p.createdAt,
          lastSeen: p.lastSeen
        });
      }
      await this._idbCommit(tx);
      db.close();
    } catch (_) { /* IndexedDB unavailable (e.g., test environment) */ }
  }

  /** Load profiles from IndexedDB. Silently fails in non-browser environments. */
  async load() {
    try {
      const db = await this._openDB();
      const tx = db.transaction(this._storeName, 'readonly');
      const rows = await this._idbGetAll(tx.objectStore(this._storeName));
      db.close();
      this._profiles = rows.map(r => ({
        ...r,
        embedding: new Float32Array(r.embedding)
      }));
      if (this._profiles.length > 0) {
        this._nextId = Math.max(...this._profiles.map(p => p.id)) + 1;
      }
      if (this._profiles.length > 0) this._emit();
    } catch (_) { /* IndexedDB unavailable — start fresh */ }
  }

  // ---- Private helpers ----

  _createProfile(embedding, label) {
    const id = this._nextId++;
    const color = this._colors[(id - 1) % this._colors.length];
    const speaker = {
      id,
      label: label || `Speaker ${id}`,
      color,
      embedding: Float32Array.from(embedding),
      createdAt: Date.now(),
      lastSeen: Date.now()
    };
    this._profiles.push(speaker);
    return speaker;
  }

  _emit() {
    const profiles = this.getProfiles();
    for (const fn of this._listeners) fn(profiles);
  }

  _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName, SpeakerRegistry.DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(this._storeName)) {
          db.createObjectStore(this._storeName, { keyPath: 'id' });
        }
      };
      req.onsuccess  = (e) => resolve(e.target.result);
      req.onerror    = (e) => reject(e.target.error);
    });
  }

  _idbPut(store, record) {
    return new Promise((resolve, reject) => {
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  _idbClear(store) {
    return new Promise((resolve, reject) => {
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  _idbGetAll(store) {
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  _idbCommit(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror    = (e) => reject(e.target.error);
    });
  }
}

// Export SpeakerRegistry alongside PipelineState
SpeakerRegistry.DB_VERSION = 2; // Increment when IndexedDB schema changes
if (typeof window !== 'undefined') {
  window.SpeakerRegistry = SpeakerRegistry;
  window.DSPConfig = DSPConfig;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PipelineState, SpeakerRegistry, DSPConfig };
}
