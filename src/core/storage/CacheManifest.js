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

import { openIdb, idbGet, idbPut, idbGetAll, idbDelete, idbTxDone, idbTransaction } from './openIdb.js';
import { deleteSourceBlob } from './BlobStore.js';
import { deleteDerivedForFile } from './DerivedCache.js';
import { ContentHasher128 } from '../content-hash.js';

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
  const tx = idbTransaction(db, META_STORE, 'readwrite');
  const store = tx.objectStore(META_STORE);
  const prev = (await idbGet(store, 'app')) || { key: 'app' };
  await idbPut(store, { ...prev, ...patch, key: 'app' });
  await idbTxDone(tx);
}

/** Bytes read and hashed per step of {@link contentFingerprint}. */
const FINGERPRINT_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Content identity for a File/Blob: a 128-bit hash of every byte plus the
 * size. The previous fingerprint sampled 4096 bytes of the first and last
 * 64 KiB and mixed in the file name, so two takes with the same name and size
 * that differed anywhere else shared one library row — and that row's blob and
 * derived stems. Name and MIME type are deliberately excluded: identical bytes
 * are the same audio.
 *
 * Reads 4 MiB at a time; each read is an async step, so the main thread is
 * never held for more than one chunk's hash.
 * @param {Blob|File} blob
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<string>}
 */
export async function contentFingerprint(blob, opts = {}) {
  if (!blob) return 'empty';
  const size = blob.size || 0;
  const hasher = new ContentHasher128();
  const checkAbort = () => {
    if (opts.signal?.aborted) {
      throw Object.assign(new Error('Fingerprint cancelled'), { name: 'AbortError' });
    }
  };
  checkAbort();
  for (let off = 0; off < size; off += FINGERPRINT_CHUNK_BYTES) {
    const end = Math.min(size, off + FINGERPRINT_CHUNK_BYTES);
    const bytes = await blob.slice(off, end).arrayBuffer();
    checkAbort();
    hasher.update(new Uint8Array(bytes));
  }
  return `c128_${hasher.digestHex()}_${size.toString(36)}`;
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
