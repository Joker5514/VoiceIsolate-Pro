/*!
 * VoiceIsolate Pro runtime capability gate.
 * Local-only. No telemetry. No remote inference.
 */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.VoiceIsolateRuntime = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = '1.0.0';
  function detectRuntime(env = {}) {
    const win = env.window || (typeof window !== 'undefined' ? window : undefined);
    const nav = env.navigator || (typeof navigator !== 'undefined' ? navigator : undefined);
    const sabCtor = env.SharedArrayBuffer || win?.SharedArrayBuffer;
    const capacitor = win?.Capacitor;
    let isCapacitor = false, platform = 'web';
    if (capacitor) {
      if (typeof capacitor.isNativePlatform === 'function') isCapacitor = capacitor.isNativePlatform();
      else isCapacitor = capacitor.Platform !== 'web' && capacitor.Platform != null;
      if (typeof capacitor.getPlatform === 'function') platform = capacitor.getPlatform();
      else if (isCapacitor) platform = capacitor.Platform || 'native';
    }
    const userAgent = nav?.userAgent || '';
    const androidWebView = platform === 'android' || (isCapacitor && /Android/i.test(userAgent)) || /; wv\)/i.test(userAgent);
    if (androidWebView && platform === 'web') platform = 'android';
    const isolated = typeof win?.crossOriginIsolated === 'boolean' ? win.crossOriginIsolated : false;
    const hasSharedArrayBuffer = typeof sabCtor === 'function';
    const sabSafe = isolated && hasSharedArrayBuffer;
    const AudioContextRef = win?.AudioContext || win?.webkitAudioContext;
    const hasAudioContext = typeof AudioContextRef === 'function';
    const hasAudioWorklet = !!(hasAudioContext && AudioContextRef.prototype && 'audioWorklet' in AudioContextRef.prototype && win?.AudioWorkletNode);
    const hasOfflineAudioContext = !!(win?.OfflineAudioContext || win?.webkitOfflineAudioContext);
    const hasMediaDevices = !!(nav?.mediaDevices && typeof nav.mediaDevices.getUserMedia === 'function');
    const hasWebGPU = !!(nav?.gpu);
    const secureContext = win?.isSecureContext !== false;
    return { version: VERSION, platform, isCapacitor, androidWebView, secureContext, isolated, hasSharedArrayBuffer, sabSafe, hasAudioContext, hasAudioWorklet, hasOfflineAudioContext, hasMediaDevices, hasWebGPU, userAgent };
  }
  function selectExecutionMode(capabilities) {
    if (!capabilities || !capabilities.secureContext) return 'unsupported';
    if (capabilities.sabSafe && capabilities.hasAudioWorklet) return 'full-live';
    if (capabilities.hasAudioWorklet && capabilities.hasOfflineAudioContext) return 'limited-live';
    if (capabilities.hasOfflineAudioContext) return 'offline-only';
    return 'unsupported';
  }
  function planBootSequence(capabilities, mode) {
    const steps = ['capability-detect', 'apply-ui-mode'];
    if (mode === 'unsupported') return steps.concat(['halt-unsupported']);
    steps.push('ml-init');
    if (mode === 'full-live') steps.push('worklet-module-add', 'live-arm');
    if (mode === 'limited-live') steps.push('live-guard', 'offline-arm');
    if (mode === 'offline-only') steps.push('offline-arm');
    return steps;
  }
  function statusMessages(state) {
    const caps = state?.capabilities || {}, mode = state?.mode || 'unsupported', backend = state?.backend || 'pending', out = [];
    if (mode === 'full-live') out.push({ level: 'ok', text: caps.platform === 'android' ? 'Full live mode enabled (isolated Android WebView)' : 'Live mode ready' });
    else if (mode === 'limited-live') { out.push({ level: 'warn', text: 'Live Mode unavailable: SharedArrayBuffer not supported in this environment' }); out.push({ level: 'info', text: 'Offline / Creator mode is available on this device' }); }
    else if (mode === 'offline-only') out.push({ level: 'warn', text: 'Offline mode recommended on this device' });
    else out.push({ level: 'error', text: 'This environment lacks required audio APIs for VoiceIsolate Pro' });
    if (backend === 'webgpu') out.push({ level: 'ok', text: 'WebGPU inference active' });
    if (backend === 'wasm') out.push({ level: 'info', text: 'Using WASM inference fallback' });
    if (backend === 'failed') out.push({ level: 'error', text: 'Local model initialization failed' });
    if (caps.androidWebView && !caps.isolated) out.push({ level: 'info', text: 'Android WebView is not cross-origin isolated; live ML is disabled by design' });
    return out;
  }
  function resolveAssetUrl(path, base) {
    if (typeof path !== 'string' || path.length === 0) throw new Error('Asset path must be a non-empty string');
    if (path.startsWith('data:') || path.startsWith('blob:')) throw new Error('Opaque model URLs are not allowed');
    const baseUrl = new URL(base || (typeof document !== 'undefined' ? document.baseURI : self.location.href));
    const resolved = new URL(path, baseUrl);
    if (resolved.origin !== baseUrl.origin) throw new Error('Model and runtime assets must be same-origin local files');
    return resolved.href;
  }
  function isLiveModeAllowed(capabilities, mode) { return mode === 'full-live' && !!capabilities?.sabSafe && !!capabilities?.hasAudioWorklet; }
  return { VERSION, detectRuntime, selectExecutionMode, planBootSequence, statusMessages, resolveAssetUrl, isLiveModeAllowed };
});
