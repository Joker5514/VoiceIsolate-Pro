/**
 * VoiceIsolate Pro — MLWorker Host (Layer 3: Pipeline)
 *
 * Creates the shared offline MLWorker with desktop model-cache bridging.
 */
'use strict';

import { MODEL_MANIFEST } from '../core/ModelManifest.js';
import { attachMLWorkerModelCache } from '../core/ModelCacheBridge.js';

/**
 * @returns {Worker}
 */
export function createMLWorker() {
  const worker = new Worker('/src/workers/MLWorker.js');
  attachMLWorkerModelCache(worker);
  return worker;
}

/**
 * Send init manifest with desktop cache bridge enabled.
 * @param {Worker} worker
 */
export function initMLWorker(worker) {
  worker.postMessage({
    type: 'init',
    manifest: Object.values(MODEL_MANIFEST),
    useDesktopCache: true,
  });
}