/**
 * runtime.js — VoiceIsolate Pro
 * Canonical runtime capability detection and execution-mode resolution.
 *
 * Responsibilities:
 *  - Detect crossOriginIsolated, SharedArrayBuffer, AudioContext/AudioWorklet/
 *    OfflineAudioContext, WebGPU (navigator.gpu), getUserMedia, Capacitor/Android.
 *  - Resolve execution mode: full-live | limited-live | offline-only | unsupported.
 *  - Resolve same-origin local model/runtime asset URLs (reject remote hosts).
 *  - Provide human-readable status messages for the UI.
 *
 * Non-goals (see voiceisolate-intended-changes.md):
 *  - No second STFT/iSTFT pass, no cloud inference, no telemetry.
 */

(function (global) {
  'use strict';

  const EXECUTION_MODES = Object.freeze({
    FULL_LIVE: 'full-live',
    LIMITED_LIVE: 'limited-live',
    OFFLINE_ONLY: 'offline-only',
    UNSUPPORTED: 'unsupported',
  });

  /**
   * Detect runtime capabilities of the current environment.
   * @param {Window} [env] - defaults to global window
   * @returns {object} capabilities
   */
  function detectRuntime(env) {
    const win = env || global;
    const nav = (win && win.navigator) || {};
    const doc = win && win.document;

    let hasAudioContext = false;
    let hasOfflineAudioContext = false;
    let hasAudioWorklet = false;

    try {
      const AC = win.AudioContext || win.webkitAudioContext;
      hasAudioContext = typeof AC === 'function';
      if (hasAudioContext && AC.prototype && 'audioWorklet' in AC.prototype) {
        hasAudioWorklet = true;
      } else if (hasAudioContext) {
        // Fallback probe: audioWorklet may exist on instances only in some engines.
        hasAudioWorklet = 'AudioWorkletNode' in win;
      }
    } catch (e) {
      hasAudioContext = false;
    }

    try {
      hasOfflineAudioContext =
        typeof (win.OfflineAudioContext || win.webkitOfflineAudioContext) === 'function';
    } catch (e) {
      hasOfflineAudioContext = false;
    }

    const hasSharedArrayBuffer = typeof win.SharedArrayBuffer === 'function';
    const isCrossOriginIsolated = Boolean(win.crossOriginIsolated);
    const hasWebGPU = Boolean(nav.gpu);
    const hasGetUserMedia = Boolean(
      nav.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function'
    );

    const userAgent = String(nav.userAgent || '');
    const isAndroid = /Android/i.test(userAgent);
    const isCapacitor = Boolean(
      win.Capacitor || (doc && doc.documentElement && doc.documentElement.hasAttribute('data-capacitor'))
    );
    const isAndroidWebView = isAndroid && (isCapacitor || /wv\)/i.test(userAgent));

    const isSecureContext = Boolean(win.isSecureContext);

    return Object.freeze({
      isCrossOriginIsolated,
      hasSharedArrayBuffer,
      hasAudioContext,
      hasAudioWorklet,
      hasOfflineAudioContext,
      hasWebGPU,
      hasGetUserMedia,
      isAndroid,
      isCapacitor,
      isAndroidWebView,
      isSecureContext,
      userAgent,
    });
  }

  /**
   * Decide the execution mode from detected capabilities.
   * Selection policy:
   *  - full-live: SharedArrayBuffer present AND crossOriginIsolated AND AudioWorklet supported.
   *  - limited-live: some live audio APIs exist but safe SAB-backed live mode unavailable.
   *  - offline-only: OfflineAudioContext works but live mode is not safe/available.
   *  - unsupported: required audio primitives are missing entirely.
   * @param {object} capabilities
   * @returns {string} one of EXECUTION_MODES
   */
  function selectExecutionMode(capabilities) {
    const caps = capabilities || {};

    if (!caps.hasAudioContext && !caps.hasOfflineAudioContext) {
      return EXECUTION_MODES.UNSUPPORTED;
    }

    if (caps.hasSharedArrayBuffer && caps.isCrossOriginIsolated && caps.hasAudioWorklet) {
      return EXECUTION_MODES.FULL_LIVE;
    }

    if (caps.hasAudioContext && caps.hasAudioWorklet) {
      // Live audio primitives exist, but SAB-backed safety is not guaranteed
      // (e.g. Android WebView without isolation headers). Never claim full-live.
      return EXECUTION_MODES.LIMITED_LIVE;
    }

    if (caps.hasOfflineAudioContext) {
      return EXECUTION_MODES.OFFLINE_ONLY;
    }

    return EXECUTION_MODES.UNSUPPORTED;
  }

  /**
   * Determine whether live mode may be safely enabled for a given mode.
   * @param {object} capabilities
   * @param {string} mode
   * @returns {boolean}
   */
  function isLiveModeAllowed(capabilities, mode) {
    if (mode === EXECUTION_MODES.FULL_LIVE) return true;
    if (mode === EXECUTION_MODES.LIMITED_LIVE) {
      // Allowed, but callers must treat this as best-effort / no SAB guarantees.
      return Boolean(capabilities && capabilities.hasAudioWorklet);
    }
    return false;
  }

  /**
   * Build an ordered boot sequence description for the given mode.
   * Does not execute anything — returns a plan the caller can follow.
   * @param {object} capabilities
   * @param {string} mode
   * @returns {{steps: string[], addWorkletModule: boolean, initMlBeforeWorklet: boolean}}
   */
  function planBootSequence(capabilities, mode) {
    const steps = ['resolve-assets', 'init-ml-worker'];
    const addWorkletModule = mode === EXECUTION_MODES.FULL_LIVE || mode === EXECUTION_MODES.LIMITED_LIVE;

    if (addWorkletModule) {
      steps.push('add-worklet-module');
      steps.push('connect-playback-mixer');
    } else {
      steps.push('skip-worklet-module');
    }

    steps.push('render-status');

    return Object.freeze({
      steps,
      addWorkletModule,
      // ML init must always precede worklet module addition when both occur.
      initMlBeforeWorklet: true,
    });
  }

  /**
   * Human-readable status messages keyed by state, for UI badges.
   * @param {object} state - { mode, capabilities, backend }
   * @returns {{level: string, text: string}[]}
   */
  function statusMessages(state) {
    const s = state || {};
    const mode = s.mode;
    const caps = s.capabilities || {};
    const messages = [];

    if (mode === EXECUTION_MODES.FULL_LIVE) {
      messages.push({ level: 'ok', text: 'Live mode ready' });
    } else if (mode === EXECUTION_MODES.LIMITED_LIVE) {
      messages.push({
        level: 'warn',
        text: 'Live Mode unavailable: SharedArrayBuffer not supported in this environment',
      });
      if (caps.isAndroidWebView) {
        messages.push({
          level: 'info',
          text: 'Android WebView is not cross-origin isolated; live ML is disabled by design',
        });
      }
    } else if (mode === EXECUTION_MODES.OFFLINE_ONLY) {
      messages.push({ level: 'info', text: 'Offline Creator mode is available on this device' });
      messages.push({ level: 'info', text: 'Offline mode recommended on this device' });
    } else {
      messages.push({ level: 'error', text: 'Local model initialization failed' });
    }

    if (s.backend === 'webgpu') {
      messages.push({ level: 'ok', text: 'WebGPU inference active' });
    } else if (s.backend === 'wasm') {
      messages.push({ level: 'info', text: 'Using WASM inference fallback' });
    } else if (s.backend === 'failed') {
      messages.push({ level: 'error', text: 'Local model initialization failed' });
    }

    return messages;
  }

  /**
   * Resolve a same-origin asset URL from a path and base. Rejects remote hosts.
   * @param {string} path
   * @param {string} [base] - defaults to current document location origin
   * @returns {string|null} resolved same-origin URL, or null if rejected
   */
  function resolveAssetUrl(path, base) {
    if (typeof path !== 'string' || path.length === 0) return null;

    // Reject obviously remote/absolute URLs to external hosts up front.
    if (/^[a-z]+:\/\//i.test(path) || path.startsWith('//')) {
      try {
        const parsed = new URL(path);
        const baseOrigin = base ? new URL(base).origin : (global.location && global.location.origin);
        if (parsed.origin !== baseOrigin) {
          return null;
        }
        return parsed.href;
      } catch (e) {
        return null;
      }
    }

    try {
      const baseUrl = base || (global.location && global.location.href) || 'http://localhost/';
      const resolved = new URL(path, baseUrl);
      const baseOrigin = new URL(baseUrl).origin;
      if (resolved.origin !== baseOrigin) {
        return null;
      }
      return resolved.href;
    } catch (e) {
      return null;
    }
  }

  const RuntimeModule = {
    EXECUTION_MODES,
    detectRuntime,
    selectExecutionMode,
    planBootSequence,
    statusMessages,
    resolveAssetUrl,
    isLiveModeAllowed,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = RuntimeModule;
  }
  global.VoiceIsolateRuntime = RuntimeModule;
})(typeof window !== 'undefined' ? window : globalThis);
