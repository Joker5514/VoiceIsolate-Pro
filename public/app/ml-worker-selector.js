/**
 * ml-worker-selector.js — Canonical ML Worker resolver
 * =====================================================
 * AUDIT FIX #7: Two ML worker files exist:
 *   - ml-worker.js              (56 KB) — FULL ONNX inference worker
 *     Runs Demucs v4.1, BSRNN, RNNoise, SepFormer via onnxruntime-web.
 *     Requires models to already be in Cache Storage or available via the
 *     /app/models/ path.  Used after first-run model download completes.
 *
 *   - ml-worker-fetch-cache.js  (40 KB) — FETCH + CACHE orchestration
 *     Handles progressive model download, Cache Storage writes, and
 *     progress reporting. Spawned ONLY on first run (or when the model
 *     cache is stale/missing). After caching, delegates inference to
 *     ml-worker.js (spawns it internally or signals main thread to swap).
 *
 * USAGE in pipeline-orchestrator.js:
 *   import { resolveWorkerUrl } from './ml-worker-selector.js';
 *   const worker = new Worker(resolveWorkerUrl(await modelsAreCached()), { type: 'module' });
 *
 * NEVER hard-code either worker path — always call resolveWorkerUrl().
 */

'use strict';

const MODEL_CACHE_NAME = 'vip-models-v1';

/**
 * Synchronously resolves the worker URL based on a known cache status.
 *
 * @param {boolean} modelsCached  Pass true if all required ONNX models are
 *   confirmed present in Cache Storage (ml-worker.js is safe to use).
 *   Pass false to use ml-worker-fetch-cache.js for download + cache.
 * @returns {string}
 */
export function resolveWorkerUrl(modelsCached) {
  return modelsCached
    ? './ml-worker.js'
    : './ml-worker-fetch-cache.js';
}

/**
 * Async helper: checks Cache Storage to determine if all required models
 * are present. Returns true only when every entry in models-manifest.json
 * has a cached response.
 *
 * @param {string[]} [requiredModels]  Array of model filenames to check.
 *   Defaults to the minimal required set for the free-tier pipeline.
 * @returns {Promise<boolean>}
 */
export async function modelsAreCached(requiredModels = [
  '/app/models/demucs_v4_quantized.onnx',
]) {
  try {
    if (!('caches' in self || 'caches' in window)) return false;
    const cache = await caches.open(MODEL_CACHE_NAME);
    const results = await Promise.all(
      requiredModels.map(async (url) => {
        const match = await cache.match(url, { ignoreSearch: true });
        return !!match;
      })
    );
    return results.every(Boolean);
  } catch (err) {
    console.warn('[ml-worker-selector] Cache check failed, defaulting to fetch-cache worker:', err.message);
    return false;
  }
}
