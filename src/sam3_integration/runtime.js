/**
 * SAM 3 runtime capability probes (browser / worker / Node-safe).
 */
'use strict';

import { assertLocalModelAsset } from './policy.js';
import { isSam3Enabled, isSam31MultiplexEnabled } from './featureFlag.js';

/**
 * @param {typeof globalThis} [g]
 * @returns {{
 *   enabled: boolean,
 *   webgpu: boolean,
 *   wasm: boolean,
 *   workers: boolean,
 *   sab: boolean,
 *   transferable: boolean,
 *   sam31Multiplex: boolean,
 *   modelAsset: { present: boolean, path: string|null, reason?: string },
 *   status: 'disabled'|'unsupported'|'missing-model'|'ready-heuristic'|'ready',
 *   reasons: string[],
 * }}
 */
export function probeSam3Runtime(g = globalThis) {
  const reasons = [];
  const enabled = isSam3Enabled(null, { queryParam: true });
  if (!enabled) reasons.push('feature-flag-off');

  let webgpu = false;
  try {
    webgpu = !!(g.navigator && g.navigator.gpu);
  } catch { /* ignore */ }
  if (!webgpu) reasons.push('webgpu-unavailable');

  let wasm = false;
  try {
    wasm = typeof g.WebAssembly === 'object' && typeof g.WebAssembly.instantiate === 'function';
  } catch { /* ignore */ }
  if (!wasm) reasons.push('wasm-unavailable');

  const workers = typeof g.Worker === 'function';
  if (!workers) reasons.push('workers-unavailable');

  let sab = false;
  try {
    sab = typeof g.SharedArrayBuffer !== 'undefined'
      && (typeof g.crossOriginIsolated !== 'boolean' || g.crossOriginIsolated === true);
  } catch { /* ignore */ }

  const transferable = true; // structured clone of ArrayBuffer is universal enough

  const defaultPath = '/app/models/sam3/model.onnx';
  const pathCheck = assertLocalModelAsset(defaultPath);
  // Presence is probed async elsewhere; sync probe only validates path policy.
  const modelAsset = {
    present: false,
    path: pathCheck.ok ? pathCheck.normalized : null,
    reason: pathCheck.ok ? 'not-probed' : pathCheck.reason,
  };

  let status = 'disabled';
  if (!enabled) {
    status = 'disabled';
  } else if (!workers || (!webgpu && !wasm)) {
    status = 'unsupported';
  } else {
    // Heuristic local segmenter always available without weights (explicit status)
    status = 'ready-heuristic';
  }

  return {
    enabled,
    webgpu,
    wasm,
    workers,
    sab,
    transferable,
    sam31Multiplex: isSam31MultiplexEnabled(),
    modelAsset,
    status,
    reasons,
  };
}

/**
 * Async probe for optional local model file (same-origin only).
 * @param {string} [url]
 * @param {typeof fetch} [fetchImpl]
 */
export async function probeSam3ModelAsset(url = '/app/models/sam3/model.onnx', fetchImpl = null) {
  const policy = assertLocalModelAsset(url);
  if (!policy.ok) {
    return { present: false, url, reason: policy.reason };
  }
  const path = policy.normalized || url;
  const gFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
  const f = fetchImpl || gFetch;
  if (!f) return { present: false, url: path, reason: 'no-fetch' };
  try {
    const head = await f(path, { method: 'HEAD', cache: 'no-store' });
    if (head.ok) return { present: true, url: path };
    const get = await f(path, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      cache: 'no-store',
    });
    if (get.ok || get.status === 206) return { present: true, url: path };
    return { present: false, url: path, reason: `http-${head.status}` };
  } catch (err) {
    return { present: false, url: path, reason: err?.message || 'probe-failed' };
  }
}

export default { probeSam3Runtime, probeSam3ModelAsset };
