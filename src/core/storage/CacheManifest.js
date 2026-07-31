/**
 * Central versioned cache manifest + orphan cleanup (100% local IDB/OPFS).
 *
 * Cache layers covered:
 *  - vip-file-library (source catalog)
 *  - vip-derived-cache (stems / analysis)
 *  - vip-blob-store (IDB blob fallback)
 *  - vip-track-state (params + resume)
 *  - vip-model-cache (ONNX bytes — separate; not wiped here)
 *
 * Invalidation when APP_CACHE_VERSION changes.
 */
'use strict';

import { openIdb, idbGet, idbPut, idbGetAll, idbDelete, idbTxDone } from './openIdb.js';
import { deleteSourceBlob } from './BlobStore.js';
import { deleteDerivedForFile } from './DerivedCache.js';

/** Bump when cache layouts or semantics change. */
export const APP_CACHE_VERSION = 'vip-cache-v4-perf';

const MANIFEST_DB = 'vip-cache-manifest';
const MANIFEST_VER = 1;
const META_STORE = 'meta';

function openManifest() {
  return openIdb(MANIFEST_DB, MANIFEST_VER, (db) => {
    if (!db.objectStoreNames.contains(META_STORE)) {
      db.createObjectStore(META_STORE, { keyPath: 'key' });
    }
  });
}

/**
 * @returns {Promise<{ version: string, cleanedAt: number|null }>}
 */
export async function getCacheMeta() {
  try {
    const db = await openManifest();
    const tx = db.transaction(META_STORE, 'readonly');
    const row = await idbGet(tx.objectStore(META_STORE), 'app');
    return {
      version: row?.version || null,
      cleanedAt: row?.cleanedAt || null,
    };
  } catch {
    return { version: null, cleanedAt: null };
  }
}

async function setCacheMeta(patch) {
  const db = await openManifest();
  const tx = db.transaction(META_STORE, 'readwrite');
  const store = tx.objectStore(META_STORE);
  const prev = (await idbGet(store, 'app')) || { key: 'app' };
  await idbPut(store, { ...prev, ...patch, key: 'app' });
  await idbTxDone(tx);
}

/**
 * Stable content fingerprint for a File/Blob (fast sample hash, not full SHA of multi-GB).
 * @param {Blob|File} blob
 * @returns {Promise<string>}
 */
export async function contentFingerprint(blob) {
  if (!blob) return 'empty';
  const size = blob.size || 0;
  const type = blob.type || '';
  const name = /** @type {File} */ (blob).name || '';
  const head = Math.min(65536, size);
  const tail = Math.min(65536, Math.max(0, size - 65536));
  const parts = [];
  if (head > 0) parts.push(new Uint8Array(await blob.slice(0, head).arrayBuffer()));
  if (tail > 0 && size > head) {
    parts.push(new Uint8Array(await blob.slice(size - tail, size).arrayBuffer()));
  }
  let h = 2166136261 >>> 0;
  const mix = (u8) => {
    for (let i = 0; i < u8.length; i += Math.max(1, (u8.length / 4096) | 0)) {
      h ^= u8[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
  };
  for (const p of parts) mix(p);
  // Include size/name/type so same bytes different containers don't collide silently
  const tag = `${size}|${type}|${name}`;
  for (let i = 0; i < tag.length; i++) {
    h ^= tag.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `fp_${h.toString(16)}_${size.toString(36)}`;
}

/**
 * Versioned cache key helper.
 * @param {string} namespace
 * @param {string} id
 * @param {string} [extra]
 */
export function cacheKey(namespace, id, extra = '') {
  return extra
    ? `${APP_CACHE_VERSION}:${namespace}:${id}:${extra}`
    : `${APP_CACHE_VERSION}:${namespace}:${id}`;
}

/**
 * Startup: if app cache version changed, mark cleaned and optionally prune orphans.
 * Does NOT wipe model weights (those use sha-pinned keys).
 * @param {{ fileIds?: string[], pruneOrphans?: boolean }} [opts]
 */
export async function ensureCacheFresh(opts = {}) {
  const meta = await getCacheMeta();
  const needsBump = meta.version !== APP_CACHE_VERSION;
  if (needsBump) {
    await setCacheMeta({
      version: APP_CACHE_VERSION,
      cleanedAt: Date.now(),
      previousVersion: meta.version,
    });
  }
  if (opts.pruneOrphans && Array.isArray(opts.fileIds)) {
    await pruneOrphanDerived(opts.fileIds);
  }
  return { bumped: needsBump, version: APP_CACHE_VERSION };
}

/**
 * Delete derived artifacts whose fileId is not in the live catalog.
 * @param {string[]} liveFileIds
 */
export async function pruneOrphanDerived(liveFileIds) {
  const live = new Set(liveFileIds || []);
  try {
    const db = await openIdb('vip-derived-cache', 1, (d) => {
      if (!d.objectStoreNames.contains('entries')) {
        d.createObjectStore('entries', { keyPath: 'key' });
      }
    });
    const tx = db.transaction('entries', 'readonly');
    const all = await idbGetAll(tx.objectStore('entries'));
    for (const row of all) {
      if (row?.fileId && !live.has(row.fileId)) {
        await deleteDerivedForFile(row.fileId);
      }
    }
  } catch {
    // derived DB may not exist yet
  }
}

/**
 * Evict a single track's derived + optional blob (caller handles catalog delete).
 * @param {string} fileId
 * @param {{ blobRef?: {backend:string,path:string}|null }} [opts]
 */
export async function purgeTrackCaches(fileId, opts = {}) {
  if (!fileId) return;
  try {
    await deleteDerivedForFile(fileId);
  } catch { /* ignore */ }
  if (opts.blobRef) {
    try {
      await deleteSourceBlob(opts.blobRef);
    } catch { /* ignore */ }
  }
  try {
    const { deleteTrackState } = await import('../TrackState.js');
    await deleteTrackState(fileId);
  } catch { /* ignore */ }
}

export default {
  APP_CACHE_VERSION,
  getCacheMeta,
  ensureCacheFresh,
  contentFingerprint,
  cacheKey,
  pruneOrphanDerived,
  purgeTrackCaches,
};
