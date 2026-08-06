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

  return {
    desktopRealSam: isDesktop, // Desktop can run Meta SAM via local worker
    androidOnnxSam: isAndroid && onnx.present,
    webOnnxSam: !isDesktop && !isAndroid && onnx.present,
    worker,
    onnx,
    // Honest: browser/WebView SAM only if optional ONNX present
    browserNativeSam: false,
    recommended:
      isDesktop ? 'local-worker-real-or-mock'
        : onnx.present ? 'sam-onnx-on-device'
          : 'usm-query-onnx-fallback',
  };
}
