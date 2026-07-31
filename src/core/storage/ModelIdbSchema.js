/**
 * Canonical ONNX model byte-cache schema for VoiceIsolate Pro.
 *
 * Single database name + version used by MLWorker, DesktopModelCache, and
 * ml-worker-fetch-cache (legacy). Values are raw ArrayBuffer keyed by string
 * (no keyPath object store) so put(value, key) works everywhere.
 *
 * DB: vip-model-cache @ v3
 * Store: models (out-of-line keys)
 */
'use strict';

export const MODEL_IDB_NAME = 'vip-model-cache';
/** Bump when store shape changes. v3 unifies v1 (no keyPath) and v2 (keyPath). */
export const MODEL_IDB_VERSION = 3;
export const MODEL_IDB_STORE = 'models';

/**
 * Upgrade path for vip-model-cache.
 * @param {IDBDatabase} db
 * @param {number} oldVersion
 */
export function upgradeModelIdb(db, oldVersion) {
  // Always ensure a key-value store without keyPath.
  if (db.objectStoreNames.contains(MODEL_IDB_STORE)) {
    // Cannot change keyPath in place — delete and recreate when upgrading from v2.
    if (oldVersion > 0 && oldVersion < 3) {
      try {
        db.deleteObjectStore(MODEL_IDB_STORE);
      } catch {
        // ignore
      }
    }
  }
  if (!db.objectStoreNames.contains(MODEL_IDB_STORE)) {
    db.createObjectStore(MODEL_IDB_STORE);
  }
}

export default {
  MODEL_IDB_NAME,
  MODEL_IDB_VERSION,
  MODEL_IDB_STORE,
  upgradeModelIdb,
};
