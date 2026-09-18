/**
 * VoiceIsolate-Pro — Unified Audio Session Store
 * Canonical session model shared across Browser, Android, Desktop
 *
 * sessionId
 * source
 * transport
 * analysis
 * regions
 * selection
 * activeProfile
 * processing
 * metrics
 * comparisonMode
 * exportState
 * deviceCapabilities
 *
 * Events: SESSION_IMPORTED, ANALYSIS_STARTED, REGIONS_UPDATED, etc.
 */

import { Profiles, ComparisonModes } from '../ui/tokens/design-tokens.js';

export const SessionEvents = Object.freeze({
  SESSION_IMPORTED: 'SESSION_IMPORTED',
  ANALYSIS_STARTED: 'ANALYSIS_STARTED',
  REGIONS_UPDATED: 'REGIONS_UPDATED',
  REGION_SELECTED: 'REGION_SELECTED',
  REGION_RESIZED: 'REGION_RESIZED',
  ACTION_PREVIEWED: 'ACTION_PREVIEWED',
  PROCESSING_APPLIED: 'PROCESSING_APPLIED',
  COMPARE_MODE_CHANGED: 'COMPARE_MODE_CHANGED',
  EXPORT_REQUESTED: 'EXPORT_REQUESTED',
  TRANSPORT_CHANGED: 'TRANSPORT_CHANGED',
  PROFILE_CHANGED: 'PROFILE_CHANGED',
  SOURCE_CLEARED: 'SOURCE_CLEARED',
});

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function createEmptyTransport() {
  return {
    playing: false,
    currentTime: 0,
    duration: 0,
    loop: false,
    crop: { in: 0, out: 0 },
    playbackRate: 1,
  };
}

function createEmptyAnalysis() {
  return {
    state: 'idle', // idle | analyzing | ready | error
    progress: 0,
    noiseFloorDb: null,
    snrDb: null,
    speechRatio: 0,
    vadSegments: [],
    whisperCandidates: [],
    speakers: [],
    confidence: 0,
    backend: 'wasm',
    error: null,
    timestamp: null,
  };
}

function createEmptyMetrics() {
  return {
    voiceClarity: null,
    noiseReduction: null,
    whisperRetention: null,
    outputLevelDb: null,
    snrDb: null,
    rms: null,
    peak: null,
    lufs: null,
    vadConfidence: null,
    noiseFloorHistory: [],
    advanced: {},
  };
}

function createEmptyProcessing() {
  return {
    state: 'idle', // idle | processing | ready | error
    progress: 0,
    stage: null,
    rawBuffer: null, // immutable original
    processedBuffer: null,
    removedBuffer: null, // delta: what was removed
    sampleRate: 48000,
    channels: 1,
    error: null,
  };
}

export function createInitialSession(overrides = {}) {
  const now = new Date().toISOString();
  return {
    sessionId: overrides.sessionId || uid(),
    source: overrides.source || null, // { file, name, type, duration, sampleRate, channels, fingerprint }
    transport: overrides.transport || createEmptyTransport(),
    analysis: overrides.analysis || createEmptyAnalysis(),
    regions: overrides.regions || [], // detected regions: { id, type, start, end, freqLow, freqHigh, confidence, label }
    selection: overrides.selection || null, // { id, start, end, freqLow, freqHigh, type }
    activeProfile: overrides.activeProfile || Profiles.STUDIO,
    processing: overrides.processing || createEmptyProcessing(),
    metrics: overrides.metrics || createEmptyMetrics(),
    comparisonMode: overrides.comparisonMode || ComparisonModes.PROCESSED,
    exportState: overrides.exportState || { state: 'idle', progress: 0, lastExport: null },
    deviceCapabilities: overrides.deviceCapabilities || {
      webgpu: false,
      wasm: true,
      threads: false,
      sampleRate: 48000,
      platform: 'browser',
    },
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Simple pub/sub store — framework agnostic, works in browser/android/desktop
 */
export class AudioSessionStore {
  constructor(initial = null) {
    this._session = initial || createInitialSession();
    this._listeners = new Map(); // event -> Set<fn>
    this._globalListeners = new Set();
    this._history = [];
    this._maxHistory = 50;
  }

  getState() {
    return this._session;
  }

  getSession() {
    return this._session;
  }

  /**
   * Subscribe to specific event or all events if event is null
   */
  subscribe(eventOrFn, fn) {
    if (typeof eventOrFn === 'function') {
      this._globalListeners.add(eventOrFn);
      return () => this._globalListeners.delete(eventOrFn);
    }
    const event = eventOrFn;
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this._listeners.get(event)?.delete(fn);
  }

  _emit(event, payload) {
    const state = this._session;
    // global
    for (const listener of this._globalListeners) {
      try { listener(event, payload, state); } catch (e) { console.warn('[AudioSessionStore] listener error', e); }
    }
    // specific
    const set = this._listeners.get(event);
    if (set) {
      for (const listener of set) {
        try { listener(payload, state); } catch (e) { console.warn('[AudioSessionStore] listener error', e); }
      }
    }
  }

  _update(updater, event, payload) {
    const prev = this._session;
    const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
    next.updatedAt = new Date().toISOString();
    this._session = next;
    // keep history
    this._history.push({ event, payload, prev, next, ts: Date.now() });
    if (this._history.length > this._maxHistory) this._history.shift();
    this._emit(event, payload);
    return next;
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  importSource(sourceInfo) {
    return this._update((s) => ({
      ...s,
      source: {
        id: uid(),
        ...sourceInfo,
        importedAt: new Date().toISOString(),
      },
      processing: {
        ...createEmptyProcessing(),
        rawBuffer: sourceInfo.rawBuffer || null,
        sampleRate: sourceInfo.sampleRate || 48000,
        channels: sourceInfo.channels || 1,
      },
      transport: {
        ...createEmptyTransport(),
        duration: sourceInfo.duration || 0,
        crop: { in: 0, out: sourceInfo.duration || 0 },
      },
      analysis: createEmptyAnalysis(),
      regions: [],
      selection: null,
      metrics: createEmptyMetrics(),
    }), SessionEvents.SESSION_IMPORTED, sourceInfo);
  }

  startAnalysis() {
    return this._update((s) => ({
      ...s,
      analysis: { ...s.analysis, state: 'analyzing', progress: 0, error: null, timestamp: new Date().toISOString() },
    }), SessionEvents.ANALYSIS_STARTED, null);
  }

  updateAnalysisProgress(progress, extra = {}) {
    return this._update((s) => ({
      ...s,
      analysis: { ...s.analysis, progress, ...extra },
    }), SessionEvents.ANALYSIS_STARTED, { progress, ...extra });
  }

  setAnalysisResult(result) {
    // Regions live at the TOP level of the session (state.regions) — the
    // canonical contract read by SignalCanvas, AnalysisOverlay and the
    // overlay list. They must NOT also be duplicated under analysis.regions.
    const { regions, ...analysisPatch } = result;
    return this._update((s) => ({
      ...s,
      analysis: {
        ...s.analysis,
        state: 'ready',
        progress: 100,
        ...result,
        timestamp: new Date().toISOString(),
      },
      regions: result.regions || s.regions,
        ...analysisPatch,
        timestamp: new Date().toISOString(),
      },
      regions: regions || s.regions,
      metrics: {
        ...s.metrics,
        snrDb: result.snrDb ?? s.metrics.snrDb,
        speechRatio: result.speechRatio ?? s.metrics.speechRatio,
      },
    }), SessionEvents.REGIONS_UPDATED, result);
  }

  setRegions(regions) {
    return this._update((s) => ({ ...s, regions }), SessionEvents.REGIONS_UPDATED, regions);
  }

  selectRegion(selection) {
    return this._update((s) => ({ ...s, selection }), SessionEvents.REGION_SELECTED, selection);
  }

  resizeRegion(selectionPatch) {
    return this._update((s) => ({
      ...s,
      selection: s.selection ? { ...s.selection, ...selectionPatch } : null,
    }), SessionEvents.REGION_RESIZED, selectionPatch);
  }

  clearSelection() {
    return this._update((s) => ({ ...s, selection: null }), SessionEvents.REGION_SELECTED, null);
  }

  previewAction(action, previewData) {
    return this._update((s) => ({
      ...s,
      processing: { ...s.processing, preview: { action, data: previewData } },
    }), SessionEvents.ACTION_PREVIEWED, { action, previewData });
  }

  applyProcessing(processingUpdate) {
    return this._update((s) => ({
      ...s,
      processing: { ...s.processing, ...processingUpdate, state: 'ready' },
      comparisonMode: ComparisonModes.PROCESSED,
    }), SessionEvents.PROCESSING_APPLIED, processingUpdate);
  }

  setProcessingState(state, progress = 0, stage = null) {
    return this._update((s) => ({
      ...s,
      processing: { ...s.processing, state, progress, stage },
    }), SessionEvents.PROCESSING_APPLIED, { state, progress, stage });
  }

  setComparisonMode(mode) {
    if (!Object.values(ComparisonModes).includes(mode)) return this._session;
    // Equality guard: re-emitting an unchanged mode ping-pongs through
    // subscribers that sync UI widgets which re-dispatch the same mode
    // (ComparisonToggle ↔ store) and overflows the stack.
    if (this._session.comparisonMode === mode) return this._session;
    return this._update((s) => ({ ...s, comparisonMode: mode }), SessionEvents.COMPARE_MODE_CHANGED, mode);
  }

  setProfile(profile) {
    if (!Object.values(Profiles).includes(profile)) return this._session;
    if (this._session.activeProfile === profile) return this._session;
    return this._update((s) => ({ ...s, activeProfile: profile }), SessionEvents.PROFILE_CHANGED, profile);
  }

  updateTransport(patch) {
    return this._update((s) => ({
      ...s,
      transport: { ...s.transport, ...patch },
    }), SessionEvents.TRANSPORT_CHANGED, patch);
  }

  updateMetrics(metricsPatch) {
    return this._update((s) => ({
      ...s,
      metrics: { ...s.metrics, ...metricsPatch },
    }), SessionEvents.REGIONS_UPDATED, metricsPatch);
  }

  requestExport(exportInfo = {}) {
    return this._update((s) => ({
      ...s,
      exportState: { ...s.exportState, state: 'exporting', ...exportInfo },
    }), SessionEvents.EXPORT_REQUESTED, exportInfo);
  }

  setExportState(statePatch) {
    return this._update((s) => ({
      ...s,
      exportState: { ...s.exportState, ...statePatch },
    }), SessionEvents.EXPORT_REQUESTED, statePatch);
  }

  clearSource() {
    return this._update(() => createInitialSession({ sessionId: this._session.sessionId }), SessionEvents.SOURCE_CLEARED, null);
  }

  setDeviceCapabilities(caps) {
    return this._update((s) => ({
      ...s,
      deviceCapabilities: { ...s.deviceCapabilities, ...caps },
    }), SessionEvents.ANALYSIS_STARTED, caps);
  }

  // ── Selectors ─────────────────────────────────────────────────────────────
  getRawBuffer() { return this._session.processing.rawBuffer; }
  getProcessedBuffer() { return this._session.processing.processedBuffer; }
  getRemovedBuffer() { return this._session.processing.removedBuffer; }
  getSelection() { return this._session.selection; }
  getRegions() { return this._session.regions; }
  getComparisonMode() { return this._session.comparisonMode; }
  getActiveProfile() { return this._session.activeProfile; }
  isAnalyzing() { return this._session.analysis.state === 'analyzing'; }
  isProcessing() { return this._session.processing.state === 'processing'; }
  hasSource() { return Boolean(this._session.source); }
}

// Singleton for app-wide use
let _defaultStore = null;
export function getAudioSessionStore() {
  if (!_defaultStore) _defaultStore = new AudioSessionStore();
  return _defaultStore;
}

export function resetAudioSessionStore() {
  _defaultStore = new AudioSessionStore();
  return _defaultStore;
}

export default AudioSessionStore;
