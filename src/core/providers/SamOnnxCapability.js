/**
 * Probe optional on-device SAM-Audio ONNX (Android WebView / browser ORT).
 * Does not load weights until isolate() — only HEAD/GET existence check.
 */
'use strict';

/**
 * @param {object} [opts]
 * @param {string} [opts.url='/app/models/sam_audio.onnx']
 * @param {typeof fetch} [opts.fetchImpl]
 * @returns {Promise<{ present: boolean, url: string, reason?: string }>}
 */
export async function probeSamOnnxModel(opts = {}) {
  const url = opts.url || '/app/models/sam_audio.onnx';
  const fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (!fetchImpl) return { present: false, url, reason: 'no-fetch' };
  try {
    const res = await fetchImpl(url, { method: 'HEAD', cache: 'no-store' });
    if (res.ok) return { present: true, url };
    // Some static hosts disallow HEAD — try range GET
    const get = await fetchImpl(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
    });
    if (get.ok || get.status === 206) return { present: true, url };
    return { present: false, url, reason: `http-${res.status}` };
  } catch (err) {
    return { present: false, url, reason: err?.message || 'probe-failed' };
  }
}

/**
 * Platform capability summary for UI / diagnostics.
 */
export async function getSamPlatformCapabilities(opts = {}) {
  const isDesktop = !!(opts.isDesktop
    || (typeof globalThis !== 'undefined' && globalThis.vipDesktop?.samWorkerStatus));
  const isAndroid = !!(opts.isAndroid
    || (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '')));

  let worker = { available: false, mock: null, baseUrl: null };
  if (isDesktop && globalThis.vipDesktop?.samWorkerStatus) {
    try {
      const st = await globalThis.vipDesktop.samWorkerStatus();
      worker = {
        available: !!(st && (st.healthy || st.running)),
        mock: null,
        baseUrl: st?.baseUrl || 'http://127.0.0.1:8765',
        running: !!st?.running,
        healthy: !!st?.healthy,
      };
    } catch { /* ignore */ }
  }

  const onnx = await probeSamOnnxModel(opts);

  // No code loads sam_audio.onnx: BrowserSamAudioProvider is unavailable,
  // MLWorker has no 'sam-audio-onnx' strategy and the manifest entry has no
  // pinned hash or prompt-input contract. A present file is reported, never
  // claimed as a usable on-device SAM.
  return {
    desktopRealSam: isDesktop, // Desktop can run Meta SAM via local worker
    androidOnnxSam: false,
    webOnnxSam: false,
    worker,
    onnx: { ...onnx, supported: false, status: onnx.present ? 'present-but-unsupported' : 'absent' },
    browserNativeSam: false,
    recommended: isDesktop ? 'local-worker-real-or-mock' : 'usm-query-onnx-fallback',
  };
}
