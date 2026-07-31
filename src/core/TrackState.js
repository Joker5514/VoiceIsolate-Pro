/**
 * Canonical per-track saved state in IndexedDB (NOT localStorage).
 * One row per library fileId — crash-safe resume of params, status, pointers.
 * 100% local.
 */
'use strict';

import { openIdb, idbGet, idbPut, idbDelete, idbGetAll, idbTxDone } from './storage/openIdb.js';
import { APP_CACHE_VERSION } from './storage/CacheManifest.js';

const DB_NAME = 'vip-track-state';
const DB_VERSION = 1;
const STORE = 'tracks';

/**
 * @typedef {object} TrackStateRow
 * @property {string} fileId
 * @property {string} cacheVersion
 * @property {number} updatedAt
 * @property {number} rev
 * @property {string} status  idle|imported|decoded|analyzed|processed
 * @property {Record<string, number>} params
 * @property {string|null} presetName
 * @property {string|null} fingerprint
 * @property {object} meta  lightweight UI meta
 */

function open() {
  return openIdb(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      const s = db.createObjectStore(STORE, { keyPath: 'fileId' });
      s.createIndex('updatedAt', 'updatedAt', { unique: false });
    }
  });
}

/**
 * @param {string} fileId
 * @returns {Promise<TrackStateRow|null>}
 */
export async function getTrackState(fileId) {
  if (!fileId) return null;
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    return (await idbGet(tx.objectStore(STORE), fileId)) || null;
  } catch {
    return null;
  }
}

/**
 * Atomic upsert — one canonical state per fileId.
 * @param {string} fileId
 * @param {Partial<TrackStateRow>} patch
 * @returns {Promise<TrackStateRow|null>}
 */
export async function saveTrackState(fileId, patch) {
  if (!fileId) return null;
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const prev = (await idbGet(store, fileId)) || {
      fileId,
      cacheVersion: APP_CACHE_VERSION,
      rev: 0,
      status: 'imported',
      params: {},
      presetName: null,
      fingerprint: null,
      meta: {},
    };
    /** @type {TrackStateRow} */
    const next = {
      ...prev,
      ...patch,
      fileId,
      cacheVersion: APP_CACHE_VERSION,
      rev: (prev.rev || 0) + 1,
      updatedAt: Date.now(),
      params: patch.params
        ? { ...prev.params, ...patch.params }
        : (prev.params || {}),
      meta: patch.meta
        ? { ...prev.meta, ...patch.meta }
        : (prev.meta || {}),
    };
    // Cap param keys (never store binary)
    const keys = Object.keys(next.params || {});
    if (keys.length > 200) {
      const slim = {};
      for (const k of keys.slice(0, 200)) slim[k] = next.params[k];
      next.params = slim;
    }
    await idbPut(store, next);
    await idbTxDone(tx);
    return next;
  } catch (err) {
    console.warn('[VIP][TrackState] save failed', err?.message || err);
    return null;
  }
}

/**
 * Debounced saver — one in-flight timer per fileId.
 */
const _timers = new Map();
const _pending = new Map();

/**
 * @param {string} fileId
 * @param {Partial<TrackStateRow>} patch
 * @param {number} [ms]
 */
export function scheduleSaveTrackState(fileId, patch, ms = 450) {
  if (!fileId) return;
  const prev = _pending.get(fileId) || {};
  _pending.set(fileId, {
    ...prev,
    ...patch,
    params: { ...(prev.params || {}), ...(patch.params || {}) },
    meta: { ...(prev.meta || {}), ...(patch.meta || {}) },
  });
  if (_timers.has(fileId)) clearTimeout(_timers.get(fileId));
  _timers.set(fileId, setTimeout(() => {
    _timers.delete(fileId);
    const p = _pending.get(fileId);
    _pending.delete(fileId);
    if (p) void saveTrackState(fileId, p);
  }, ms));
}

/** Flush all pending debounced saves (call on pagehide). */
export async function flushTrackStateSaves() {
  const ids = [..._pending.keys()];
  for (const id of ids) {
    if (_timers.has(id)) {
      clearTimeout(_timers.get(id));
      _timers.delete(id);
    }
    const p = _pending.get(id);
    _pending.delete(id);
    if (p) await saveTrackState(id, p);
  }
}

/**
 * @param {string} fileId
 */
export async function deleteTrackState(fileId) {
  if (!fileId) return;
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readwrite');
    await idbDelete(tx.objectStore(STORE), fileId);
    await idbTxDone(tx);
  } catch { /* ignore */ }
  _pending.delete(fileId);
  if (_timers.has(fileId)) {
    clearTimeout(_timers.get(fileId));
    _timers.delete(fileId);
  }
}

/**
 * @returns {Promise<TrackStateRow[]>}
 */
export async function listTrackStates() {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    return await idbGetAll(tx.objectStore(STORE));
  } catch {
    return [];
  }
}

export default {
  getTrackState,
  saveTrackState,
  scheduleSaveTrackState,
  flushTrackStateSaves,
  deleteTrackState,
  listTrackStates,
};
