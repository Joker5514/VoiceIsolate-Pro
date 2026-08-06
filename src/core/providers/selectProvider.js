/**
 * Cross-platform provider selection.
 * Default: onnx-local. SAM only via explicit local worker when enabled + healthy.
 */
'use strict';

import { ExistingOnnxProvider } from './ExistingOnnxProvider.js';
import { BrowserSamAudioProvider } from './BrowserSamAudioProvider.js';
import { LocalSamAudioWorkerProvider } from './LocalSamAudioWorkerProvider.js';

/**
 * @typedef {'disabled'|'browser'|'local-worker'|'auto'} SamAudioMode
 *
 * @param {object} [opts]
 * @param {SamAudioMode} [opts.samMode='disabled']
 * @param {string} [opts.workerBaseUrl]
 * @param {boolean} [opts.isAndroid]
 * @param {boolean} [opts.isDesktop]
 * @param {boolean} [opts.preferSam]
 * @param {(req: object) => Promise<object>} [opts.separateFn]
 * @param {(pcm: Float32Array, sr: number, cfg: object) => object} [opts.usmFn]
 * @param {typeof fetch} [opts.fetchImpl]
 */
export async function selectIsolationProvider(opts = {}) {
  const samMode = opts.samMode || readEnvMode() || 'disabled';
  const onnx = new ExistingOnnxProvider({
    separateFn: opts.separateFn,
    usmFn: opts.usmFn,
  });
  const browserSam = new BrowserSamAudioProvider();
  const worker = new LocalSamAudioWorkerProvider({
    baseUrl: opts.workerBaseUrl || readEnvWorkerUrl() || 'http://127.0.0.1:8765',
    fetchImpl: opts.fetchImpl,
  });

  // Live always stays on existing path — callers must not pick SAM for live.
  if (samMode === 'disabled') {
    return { provider: onnx, reason: 'sam-disabled', candidates: { onnx, browserSam, worker } };
  }

  if (samMode === 'browser') {
    const caps = await browserSam.getCapabilities();
    if (caps.available) {
      return { provider: browserSam, reason: 'browser-sam', candidates: { onnx, browserSam, worker } };
    }
    // Fall back to onnx; never invent cloud.
    return {
      provider: onnx,
      reason: 'browser-sam-unavailable',
      fallback: true,
      caps,
      candidates: { onnx, browserSam, worker },
    };
  }

  if (samMode === 'local-worker' || samMode === 'auto') {
    // Desktop / explicit local-worker: prefer real SAM worker when healthy.
    // Android WebView: try worker first (ADB reverse / LAN loopback rare), then ONNX/USM.
    const caps = await worker.getCapabilities();
    if (caps.available) {
      return {
        provider: worker,
        reason: caps.mock ? 'local-worker-mock' : 'local-worker-real',
        caps,
        candidates: { onnx, browserSam, worker },
      };
    }
    // Real SAM worker not reachable — classical USM/ONNX still works on all platforms.
    return {
      provider: onnx,
      reason: opts.isAndroid ? 'android-usm-onnx-fallback' : 'local-worker-unavailable',
      fallback: true,
      caps,
      candidates: { onnx, browserSam, worker },
    };
  }

  return { provider: onnx, reason: 'unknown-mode', candidates: { onnx, browserSam, worker } };
}

function envLookup(key) {
  try {
    const proc = typeof globalThis !== 'undefined' ? globalThis.process : undefined;
    if (proc && proc.env && proc.env[key]) return proc.env[key];
  } catch { /* browser / sandbox */ }
  return undefined;
}

function readEnvMode() {
  const fromEnv = envLookup('SAM_AUDIO_MODE');
  if (fromEnv) return fromEnv;
  if (typeof globalThis !== 'undefined' && globalThis.__VIP_SAM_AUDIO_MODE) {
    return globalThis.__VIP_SAM_AUDIO_MODE;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('vip-sam-audio-mode') || undefined;
    }
  } catch { /* ignore */ }
  // Desktop: prefer local worker when Electron preload is present.
  try {
    if (typeof globalThis !== 'undefined' && globalThis.vipDesktop?.samWorkerStatus) {
      return 'local-worker';
    }
  } catch { /* ignore */ }
  return undefined;
}

function readEnvWorkerUrl() {
  const fromEnv = envLookup('SAM_AUDIO_BASE_URL');
  if (fromEnv) return fromEnv;
  if (typeof globalThis !== 'undefined' && globalThis.__VIP_SAM_AUDIO_BASE_URL) {
    return globalThis.__VIP_SAM_AUDIO_BASE_URL;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('vip-sam-audio-base-url') || undefined;
    }
  } catch { /* ignore */ }
  return undefined;
}

export {
  ExistingOnnxProvider,
  BrowserSamAudioProvider,
  LocalSamAudioWorkerProvider,
};
