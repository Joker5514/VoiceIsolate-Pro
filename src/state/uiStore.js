/**
 * VoiceIsolate-Pro — Unified UI Store
 * Shared UI state across Browser, Android, Desktop
 */

export const UIEvents = Object.freeze({
  NAVIGATION_CHANGED: 'NAVIGATION_CHANGED',
  VIEW_MODE_CHANGED: 'VIEW_MODE_CHANGED',
  INSPECTOR_TOGGLED: 'INSPECTOR_TOGGLED',
  SELECTION_MODE_CHANGED: 'SELECTION_MODE_CHANGED',
  ZOOM_CHANGED: 'ZOOM_CHANGED',
  THEME_CHANGED: 'THEME_CHANGED',
  BOTTOM_SHEET_CHANGED: 'BOTTOM_SHEET_CHANGED',
  TOAST: 'TOAST',
});

export const NavigationSections = Object.freeze({
  HOME: 'home',
  ANALYZE: 'analyze',
  ENHANCE: 'enhance',
  COMPARE: 'compare',
  EXPORT: 'export',
  SETTINGS: 'settings',
});

export const ViewModes = Object.freeze({
  WAVEFORM: 'waveform',
  SPECTROGRAM: 'spectrogram',
  COMBINED: 'combined',
});

export const SelectionModes = Object.freeze({
  TIME: 'time',
  TIME_FREQ: 'time_freq',
});

function createInitialUI() {
  return {
    navigation: NavigationSections.HOME,
    viewMode: ViewModes.COMBINED,
    selectionMode: SelectionModes.TIME,
    inspector: {
      open: true,
      advancedOpen: false,
      metricsOpen: true,
    },
    zoom: {
      horizontal: 1,
      vertical: 1,
      offset: 0,
    },
    bottomSheet: {
      open: false,
      content: null, // 'actionPalette' | 'metrics' | 'profiles' | null
    },
    toasts: [],
    reducedMotion: false,
    highContrast: false,
    platform: 'browser', // browser | android | desktop
    isMobile: false,
    isTouch: false,
  };
}

export class UIStore {
  constructor(initial = null) {
    this._state = initial || createInitialUI();
    this._listeners = new Map();
    this._global = new Set();
    this._detectPlatform();
  }

  _detectPlatform() {
    try {
      const ua = (typeof navigator !== 'undefined' ? navigator.userAgent : '') || '';
      const touch = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
      const mobile = /Android|iPhone|iPad|iPod/i.test(ua) || (typeof window !== 'undefined' && window.innerWidth < 768);
      let platform = 'browser';
      if (/Android/i.test(ua)) platform = 'android';
      else if (typeof window !== 'undefined' && window.navigator?.userAgent?.includes('Electron')) platform = 'desktop';
      else if (typeof window !== 'undefined' && window.__VIP_DESKTOP__) platform = 'desktop';
      this._state.platform = platform;
      this._state.isTouch = touch;
      this._state.isMobile = mobile;
      if (typeof window !== 'undefined' && window.matchMedia) {
        this._state.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      }
    } catch {}
  }

  getState() { return this._state; }

  subscribe(eventOrFn, fn) {
    if (typeof eventOrFn === 'function') {
      this._global.add(eventOrFn);
      return () => this._global.delete(eventOrFn);
    }
    const ev = eventOrFn;
    if (!this._listeners.has(ev)) this._listeners.set(ev, new Set());
    this._listeners.get(ev).add(fn);
    return () => this._listeners.get(ev)?.delete(fn);
  }

  _emit(event, payload) {
    for (const l of this._global) {
      try { l(event, payload, this._state); } catch {}
    }
    const set = this._listeners.get(event);
    if (set) {
      for (const l of set) {
        try { l(payload, this._state); } catch {}
      }
    }
  }

  _update(patch, event, payload) {
    this._state = { ...this._state, ...patch };
    this._emit(event, payload ?? patch);
    return this._state;
  }

  setNavigation(section) {
    if (!Object.values(NavigationSections).includes(section)) return;
    return this._update({ navigation: section }, UIEvents.NAVIGATION_CHANGED, section);
  }

  setViewMode(mode) {
    if (!Object.values(ViewModes).includes(mode)) return;
    return this._update({ viewMode: mode }, UIEvents.VIEW_MODE_CHANGED, mode);
  }

  setSelectionMode(mode) {
    if (!Object.values(SelectionModes).includes(mode)) return;
    return this._update({ selectionMode: mode }, UIEvents.SELECTION_MODE_CHANGED, mode);
  }

  toggleInspector(open = null) {
    const next = open === null ? !this._state.inspector.open : open;
    return this._update(
      { inspector: { ...this._state.inspector, open: next } },
      UIEvents.INSPECTOR_TOGGLED,
      next,
    );
  }

  toggleAdvanced(open = null) {
    const next = open === null ? !this._state.inspector.advancedOpen : open;
    return this._update(
      { inspector: { ...this._state.inspector, advancedOpen: next } },
      UIEvents.INSPECTOR_TOGGLED,
      { advanced: next },
    );
  }

  setZoom(patch) {
    return this._update(
      { zoom: { ...this._state.zoom, ...patch } },
      UIEvents.ZOOM_CHANGED,
      patch,
    );
  }

  openBottomSheet(content) {
    return this._update(
      { bottomSheet: { open: true, content } },
      UIEvents.BOTTOM_SHEET_CHANGED,
      { open: true, content },
    );
  }

  closeBottomSheet() {
    return this._update(
      { bottomSheet: { open: false, content: null } },
      UIEvents.BOTTOM_SHEET_CHANGED,
      { open: false },
    );
  }

  showToast(message, type = 'info', duration = 3000) {
    const toast = { id: `${Date.now()}-${Math.random()}`, message, type, duration };
    this._state.toasts = [...this._state.toasts, toast];
    this._emit(UIEvents.TOAST, toast);
    if (duration > 0) {
      setTimeout(() => this.dismissToast(toast.id), duration);
    }
    return toast;
  }

  dismissToast(id) {
    this._state.toasts = this._state.toasts.filter((t) => t.id !== id);
    this._emit(UIEvents.TOAST, { dismissed: id });
  }

  isMobileLayout() { return this._state.isMobile; }
  isTouchDevice() { return this._state.isTouch; }
  getPlatform() { return this._state.platform; }
}

let _defaultUI = null;
export function getUIStore() {
  if (!_defaultUI) _defaultUI = new UIStore();
  return _defaultUI;
}

export function resetUIStore() {
  _defaultUI = new UIStore();
  return _defaultUI;
}

export default UIStore;
