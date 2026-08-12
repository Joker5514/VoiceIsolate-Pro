/**
 * VoiceIsolate Pro — Clear Local Data (Layer 1: Core)
 *
 * Empties user-local storage used by the product:
 *   • File library catalog + OPFS/IDB source blobs
 *   • Derived stem / analysis caches
 *   • Track state (params / resume)
 *   • Cache manifest
 *   • Optional ONNX model weight cache (vip-model-cache)
 *   • VIP localStorage keys (tier, UI chrome — not secrets)
 *
 * 100% local. No network. Never touches cloud.
 */
'use strict';

import { listLibraryFiles, deleteFilePermanently, setSessionState } from './FileLibrary.js';
import { APP_CACHE_VERSION } from './storage/CacheManifest.js';

/** IndexedDB database names owned by VoiceIsolate Pro. */
export const VIP_IDB_NAMES = Object.freeze([
  'vip-file-library',
  'vip-derived-cache',
  'vip-blob-store',
  'vip-track-state',
  'vip-cache-manifest',
  'vip-model-cache',
  'vip-project-store',
  'vip-research-session',
]);

/** localStorage key prefixes / exact keys that are safe to wipe. */
export const VIP_LS_PREFIXES = Object.freeze([
  'vip-',
  'vip_',
  'voiceisolate',
  'workflow-tier',
  'VIP_',
]);

/**
 * Delete an IndexedDB database by name (promise-wrapped).
 * @param {string} name
 * @returns {Promise<{ name: string, ok: boolean, error?: string }>}
 */
export function deleteIdbDatabase(name) {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined' || !indexedDB.deleteDatabase) {
      resolve({ name, ok: false, error: 'indexedDB unavailable' });
      return;
    }
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      resolve({ name, ok, error });
    };
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => done(true);
      req.onerror = () => done(false, req.error?.message || 'delete failed');
      req.onblocked = () => done(false, 'blocked (close other tabs)');
    } catch (err) {
      done(false, err?.message || String(err));
    }
  });
}

/**
 * Remove OPFS directory tree used by BlobStore (best-effort).
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function clearOpfsTree() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
      return { ok: true }; // no OPFS — treat as cleared
    }
    const root = await navigator.storage.getDirectory();
    // Known VIP roots under OPFS
    const dirs = ['vip', 'vip-blobs', 'vip-stems', 'vip-models', 'voiceisolate'];
    for (const name of dirs) {
      try {
        await root.removeEntry(name, { recursive: true });
      } catch {
        // missing is fine
      }
    }
    // Also wipe flat keys with vip- prefix if supported
    try {
      // eslint-disable-next-line no-restricted-syntax
      for await (const [key, handle] of root.entries()) {
        if (/^vip/i.test(key) || /voiceisolate/i.test(key)) {
          try {
            await root.removeEntry(key, { recursive: handle.kind === 'directory' });
          } catch { /* ignore */ }
        }
      }
    } catch {
      // entries() may be unsupported
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Clear VIP-owned localStorage keys.
 * @param {Storage} [store]
 * @returns {number} count removed
 */
export function clearVipLocalStorage(store) {
  const ls = store || (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!ls) return 0;
  const keys = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k) keys.push(k);
  }
  let n = 0;
  for (const k of keys) {
    if (VIP_LS_PREFIXES.some((p) => k.startsWith(p) || k.toLowerCase().includes('vip'))) {
      try {
        ls.removeItem(k);
        n++;
      } catch { /* ignore */ }
    }
  }
  return n;
}

/**
 * Clear VIP-owned sessionStorage keys (same prefixes).
 * @param {Storage} [store]
 * @returns {number}
 */
export function clearVipSessionStorage(store) {
  const ss = store || (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
  if (!ss) return 0;
  return clearVipLocalStorage(ss);
}

/**
 * Full clear: library files → IDB dbs → OPFS → local/session storage.
 *
 * @param {{ includeModels?: boolean, document?: Document }} [opts]
 *   includeModels — also wipe vip-model-cache ONNX bytes (default true)
 * @returns {Promise<{
 *   filesRemoved: number,
 *   idb: Array<{name:string,ok:boolean,error?:string}>,
 *   opfs: {ok:boolean,error?:string},
 *   localStorageKeys: number,
 *   sessionStorageKeys: number,
 *   cacheVersion: string,
 * }>}
 */
export async function clearAllLocalData(opts = {}) {
  const includeModels = opts.includeModels !== false;
  let filesRemoved = 0;

  // 1. Catalog-aware delete (purges derived + blobs per track)
  try {
    const files = await listLibraryFiles();
    for (const f of files) {
      try {
        await deleteFilePermanently(f.id);
        filesRemoved++;
      } catch { /* continue */ }
    }
  } catch { /* library may be empty / unavailable */ }

  try {
    await setSessionState({ activeFileId: null, updatedAt: Date.now() });
  } catch { /* ignore */ }

  // 2. Hard-drop IDB databases (covers leftovers + model cache)
  const idbNames = includeModels
    ? VIP_IDB_NAMES
    : VIP_IDB_NAMES.filter((n) => n !== 'vip-model-cache');
  const idb = [];
  for (const name of idbNames) {
    idb.push(await deleteIdbDatabase(name));
  }

  // 3. OPFS
  const opfs = await clearOpfsTree();

  // 4. Web Storage
  const localStorageKeys = clearVipLocalStorage();
  const sessionStorageKeys = clearVipSessionStorage();

  // 5. Optional caches API
  try {
    if (typeof caches !== 'undefined' && caches.keys) {
      const keys = await caches.keys();
      for (const k of keys) {
        if (/vip|voiceisolate|workbox/i.test(k)) {
          try { await caches.delete(k); } catch { /* ignore */ }
        }
      }
    }
  } catch { /* ignore */ }

  return {
    filesRemoved,
    idb,
    opfs,
    localStorageKeys,
    sessionStorageKeys,
    cacheVersion: APP_CACHE_VERSION,
  };
}

export default {
  VIP_IDB_NAMES,
  VIP_LS_PREFIXES,
  deleteIdbDatabase,
  clearOpfsTree,
  clearVipLocalStorage,
  clearVipSessionStorage,
  clearAllLocalData,
};
