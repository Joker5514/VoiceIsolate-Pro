/**
 * VoiceIsolate Pro — MLWorker Model Cache Bridge (Layer 1: Core)
 *
 * Proxies cache read/write from the classic MLWorker (no vipDesktop access)
 * to DesktopModelCache on the main thread.
 */
'use strict';

import { readModelCacheBytes, writeModelCacheBytes } from './DesktopModelCache.js';

/**
 * Attach a message listener that answers MLWorker cache-request messages.
 * @param {Worker} worker
 * @returns {() => void} detach function
 */
export function attachMLWorkerModelCache(worker) {
  if (!worker || typeof worker.addEventListener !== 'function') {
    throw new TypeError('[VIP][ModelCacheBridge] worker is required.');
  }

  const handler = async (event) => {
    const msg = event.data || {};
    if (msg.type !== 'cache-request') return;

    const { requestId, op, key, buffer } = msg;
    try {
      if (op === 'get') {
        const data = await readModelCacheBytes(key);
        if (data) {
          worker.postMessage({ type: 'cache-response', requestId, ok: true, buffer: data }, [data]);
        } else {
          worker.postMessage({ type: 'cache-response', requestId, ok: true, buffer: null });
        }
        return;
      }
      if (op === 'put') {
        const result = await writeModelCacheBytes(key, buffer);
        worker.postMessage({ type: 'cache-response', requestId, ok: result.ok, bytes: result.bytes });
        return;
      }
      worker.postMessage({ type: 'cache-response', requestId, ok: false, error: `Unknown op '${op}'` });
    } catch (err) {
      worker.postMessage({
        type: 'cache-response',
        requestId,
        ok: false,
        error: err?.message || String(err),
      });
    }
  };

  worker.addEventListener('message', handler);
  return () => worker.removeEventListener('message', handler);
}