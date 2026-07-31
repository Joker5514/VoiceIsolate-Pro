/**
 * VoiceIsolate Pro — Desktop Model Cache Adapter (Layer 1: Core)
 *
 * Filesystem-first model byte cache for the Electron renderer. Falls back to
 * IndexedDB when vipDesktop is unavailable (web) or the on-disk entry is missing.
 *
 * Used by ModelCacheBridge to serve MLWorker cache requests on the main thread.
 */
'use strict';

import { isDesktopShell } from './DesktopBridge.js';
import {
  MODEL_IDB_NAME,
  MODEL_IDB_STORE,
  MODEL_IDB_VERSION,
  upgradeModelIdb,
} from './storage/ModelIdbSchema.js';

const IDB_NAME = MODEL_IDB_NAME;
const IDB_STORE = MODEL_IDB_STORE;
const IDB_VERSION = MODEL_IDB_VERSION;

let _idb = null;
let _idbPromise = null;

function openDb() {
  if (_idb) return Promise.resolve(_idb);
  if (_idbPromise) return _idbPromise;
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('[VIP][DesktopModelCache] IndexedDB unavailable.'));
  }
  _idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (ev) => {
      upgradeModelIdb(req.result, ev.oldVersion || 0);
    };
    req.onsuccess = () => { _idb = req.result; resolve(_idb); };
    req.onerror = () => reject(req.error);
  });
  return _idbPromise;
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Build a stable cache key for a manifest entry.
 * @param {{ id: string, sha256?: string|null }} entry
 * @returns {string}
 */
export function modelCacheKey(entry) {
  return `${entry.id}:${entry.sha256 || 'unpinned'}`;
}

/**
 * Relative filesystem path under {userData}/models/.
 * @param {string} cacheKey
 * @returns {string}
 */
export function modelCacheRelativePath(cacheKey) {
  const safe = cacheKey.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${safe}.onnx`;
}

/**
 * Read cached model bytes — filesystem first on desktop, IndexedDB fallback.
 * @param {string} cacheKey
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function readModelCacheBytes(cacheKey) {
  if (!cacheKey || typeof cacheKey !== 'string') return null;

  if (isDesktopShell() && typeof globalThis.vipDesktop.readModelCache === 'function') {
    const rel = modelCacheRelativePath(cacheKey);
    const fromDisk = await globalThis.vipDesktop.readModelCache(rel);
    if (fromDisk && fromDisk.byteLength > 0) return fromDisk;
  }

  try {
    const fromIdb = await idbGet(cacheKey);
    return fromIdb || null;
  } catch {
    return null;
  }
}

/**
 * Write model bytes — desktop filesystem when available, always mirror to IDB.
 * @param {string} cacheKey
 * @param {ArrayBuffer} bytes
 * @returns {Promise<{ ok: boolean, bytes: number, provider: 'filesystem'|'idb'|'both' }>}
 */
export async function writeModelCacheBytes(cacheKey, bytes) {
  if (!cacheKey || !bytes || bytes.byteLength === 0) {
    return { ok: false, bytes: 0, provider: 'idb' };
  }

  let provider = 'idb';
  let fsOk = false;

  if (isDesktopShell() && typeof globalThis.vipDesktop.writeModelCache === 'function') {
    const rel = modelCacheRelativePath(cacheKey);
    const result = await globalThis.vipDesktop.writeModelCache({ relativePath: rel, buffer: bytes });
    fsOk = Boolean(result?.ok);
    if (fsOk) provider = 'filesystem';
  }

  try {
    await idbPut(cacheKey, bytes);
    provider = fsOk ? 'both' : 'idb';
  } catch (err) {
    console.warn('[VIP][DesktopModelCache] IndexedDB cache write failed (non-fatal):', err);
    if (!fsOk) return { ok: false, bytes: 0, provider: 'idb' };
  }

  return { ok: true, bytes: bytes.byteLength, provider };
}