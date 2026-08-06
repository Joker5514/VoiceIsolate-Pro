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
    // Android: still allow private worker if user configured loopback via reverse
    // tunnel — but default health will fail and we keep onnx.
    if (opts.isAndroid && samMode === 'auto' && !opts.preferSam) {
      return {
        provider: onnx,
        reason: 'android-default-onnx',
        candidates: { onnx, browserSam, worker },
      };
    }
    const caps = await worker.getCapabilities();
    if (caps.available || opts.preferSam) {
      if (caps.available) {
        return { provider: worker, reason: 'local-worker', caps, candidates: { onnx, browserSam, worker } };
      }
    }
    return {
      provider: onnx,
      reason: 'local-worker-unavailable',
      fallback: true,
      caps,
      candidates: { onnx, browserSam, worker },
    };
  }

  return { provider: onnx, reason: 'unknown-mode', candidates: { onnx, browserSam, worker } };
}

function readEnvMode() {
  if (typeof process !== 'undefined' && process.env && process.env.SAM_AUDIO_MODE) {
    return process.env.SAM_AUDIO_MODE;
  }
  if (typeof globalThis !== 'undefined' && globalThis.__VIP_SAM_AUDIO_MODE) {
    return globalThis.__VIP_SAM_AUDIO_MODE;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      return localStorage.getItem('vip-sam-audio-mode') || undefined;
    }
  } catch { /* ignore */ }
  return undefined;
}

function readEnvWorkerUrl() {
  if (typeof process !== 'undefined' && process.env && process.env.SAM_AUDIO_BASE_URL) {
    return process.env.SAM_AUDIO_BASE_URL;
  }
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
