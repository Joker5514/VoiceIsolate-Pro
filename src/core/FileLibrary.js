/**
 * VoiceIsolate Pro — FileLibrary
 *
 * Persistent catalog of user-imported media (source assets only by default).
 * Metadata: IndexedDB. Bytes: OPFS (preferred) or IndexedDB blobs.
 * Does NOT permanently store giant Float32 PCM — re-decode from source.
 *
 * 100% local. No telemetry. No cloud.
 */
'use strict';

import {
  openIdb,
  idbGet,
  idbPut,
  idbDelete,
  idbGetAll,
  idbTxDone,
  idbTransaction,
} from './storage/openIdb.js';
import {
  writeSourceBlob,
  readSourceBlob,
  deleteSourceBlob,
  blobToFile,
  resolveBlobBackend,
} from './storage/BlobStore.js';
import { contentFingerprint, purgeTrackCaches } from './storage/CacheManifest.js';

const DB_NAME = 'vip-file-library';
const DB_VERSION = 2;
const META_STORE = 'files';
const SESSION_STORE = 'session';

/** Hard cap: one user, five tracks total (canonical state each). */
export const MAX_LIBRARY_TRACKS = 5;

/** @typedef {'temporary'|'library'|'project'} ImportMode */
/** @typedef {'idle'|'imported'|'decoded'|'analyzed'|'processed'|'error'} ProcessingStatus */

/**
 * @typedef {object} LibraryFileMeta
 * @property {string} id
 * @property {string} originalFilename
 * @property {string} mimeType
 * @property {number} size
 * @property {number|null} duration
 * @property {number|null} sampleRate
 * @property {number|null} channels
 * @property {string|null} waveformCacheKey
 * @property {string|null} analysisCacheKey
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {ProcessingStatus} processingStatus
 * @property {string|null} projectId
 * @property {string[]} tags
 * @property {ImportMode} importMode
 * @property {{ backend: string, path: string }|null} blobRef
 * @property {boolean} inLibrary  false for temporary (not listed after session)
 */

function openLibraryDb() {
  return openIdb(DB_NAME, DB_VERSION, (db, oldVersion, tx) => {
    let store;
    if (!db.objectStoreNames.contains(META_STORE)) {
      store = db.createObjectStore(META_STORE, { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt', { unique: false });
      store.createIndex('projectId', 'projectId', { unique: false });
      store.createIndex('inLibrary', 'inLibrary', { unique: false });
      store.createIndex('fingerprint', 'fingerprint', { unique: false });
    } else if (oldVersion < 2 && tx) {
      try {
        store = tx.objectStore(META_STORE);
        if (!store.indexNames.contains('fingerprint')) {
          store.createIndex('fingerprint', 'fingerprint', { unique: false });
        }
      } catch { /* index may exist */ }
    }
    if (!db.objectStoreNames.contains(SESSION_STORE)) {
      db.createObjectStore(SESSION_STORE, { keyPath: 'key' });
    }
  });
}

function newId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Find existing library row by content fingerprint (canonical track).
 * @param {string} fingerprint
 * @returns {Promise<LibraryFileMeta|null>}
 */
async function findByFingerprint(fingerprint, opts = {}) {
  if (!fingerprint) return null;
  // Removed rows are searched too: re-importing a removed take revives its
  // row and blob instead of storing a second copy.
  const files = await listAllRows();
  const hit = files.find((f) => f.fingerprint === fingerprint);
  if (hit) return hit;
  // Rows written before full-content hashing carry a sampled `fp_` id that
  // never equals a `c128_` one. Re-hash the stored bytes of same-size legacy
  // rows so re-importing that file adopts its row instead of duplicating it.
  const sizeTag = fingerprint.slice(fingerprint.lastIndexOf('_'));
  for (const f of files) {
    if (!f.blobRef || !f.fingerprint?.startsWith('fp_') || !f.fingerprint.endsWith(sizeTag)) continue;
    let blob = null;
    try {
      blob = await readSourceBlob(f.blobRef);
    } catch { /* missing blob: not a match */ }
    if (blob && await contentFingerprint(blob, opts) === fingerprint) return f;
  }
  return null;
}

/**
 * Every catalog row, including ones removed from the library list.
 * @returns {Promise<LibraryFileMeta[]>}
 */
async function listAllRows() {
  try {
    const db = await openLibraryDb();
    const tx = db.transaction(META_STORE, 'readonly');
    return (await idbGetAll(tx.objectStore(META_STORE))).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Evict until at most MAX_LIBRARY_TRACKS rows hold stored audio. Removed rows
 * still hold their blob, so they count and go first; then the oldest library
 * rows. Project sources (rows with a projectId) and keepId are never evicted:
 * deleting them would silently drop files from a project and its exports.
 * @param {string} [keepId]
 */
export async function enforceTrackCap(keepId = null) {
  const rows = await listAllRows();
  if (rows.length <= MAX_LIBRARY_TRACKS) return;
  const victims = rows
    .filter((f) => f.id !== keepId && !f.projectId)
    .sort((a, b) => ((a.inLibrary === false ? 0 : 1) - (b.inLibrary === false ? 0 : 1))
      || ((a.updatedAt || 0) - (b.updatedAt || 0)));
  let count = rows.length;
  for (const victim of victims) {
    if (count <= MAX_LIBRARY_TRACKS) break;
    await deleteFilePermanently(victim.id);
    count--;
  }
  if (count > MAX_LIBRARY_TRACKS) {
    console.warn(`[VIP][FileLibrary] ${count} stored tracks exceed the cap of ${MAX_LIBRARY_TRACKS}; the rest belong to projects`);
  }
}

/**
 * Import or upsert a track. Same content → same canonical id (no duplicates).
 * Library capped at MAX_LIBRARY_TRACKS.
 *
 * @param {File|Blob} file
 * @param {object} [opts]
 * @param {ImportMode} [opts.mode]
 * @param {string|null} [opts.projectId]
 * @param {string[]} [opts.tags]
 * @param {boolean} [opts.forceNew]  skip fingerprint upsert
 * @param {AbortSignal} [opts.signal]  stops the content hash (AbortError)
 * @returns {Promise<LibraryFileMeta>}
 */
export async function importFile(file, opts = {}) {
  if (!file) throw new TypeError('[VIP][FileLibrary] importFile requires a File/Blob');
  const mode = /** @type {ImportMode} */ (opts.mode || 'library');
  const projectId = opts.projectId || null;
  const tags = Array.isArray(opts.tags) ? opts.tags.slice() : [];
  const now = Date.now();
  const originalFilename = /** @type {File} */ (file).name || 'import';
  const mimeType = file.type || 'application/octet-stream';
  const size = file.size || 0;

  // Without a content identity there is no safe de-duplication: a
  // name/size stand-in merged different takes into one row (and one blob).
  let fingerprint = null;
  try {
    fingerprint = await contentFingerprint(file, { signal: opts.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    fingerprint = null;
  }

  // Temporary: no catalog, no blob write
  if (mode === 'temporary') {
    const id = newId();
    /** @type {LibraryFileMeta} */
    const meta = {
      id,
      originalFilename,
      mimeType,
      size,
      duration: null,
      sampleRate: null,
      channels: null,
      waveformCacheKey: null,
      analysisCacheKey: null,
      createdAt: now,
      updatedAt: now,
      processingStatus: 'imported',
      projectId: null,
      tags,
      importMode: 'temporary',
      blobRef: null,
      inLibrary: false,
      fingerprint,
    };
    _ephemeral.set(id, { file, meta });
    await setSessionState({
      activeFileId: id,
      importMode: mode,
      lastFilename: originalFilename,
      updatedAt: now,
    });
    return meta;
  }

  // Canonical upsert by fingerprint
  if (!opts.forceNew && fingerprint) {
    const existing = await findByFingerprint(fingerprint, { signal: opts.signal });
    if (existing) {
      const updated = {
        ...existing,
        originalFilename,
        mimeType,
        size,
        updatedAt: now,
        projectId: projectId || existing.projectId,
        tags: tags.length ? tags : existing.tags,
        importMode: mode,
        inLibrary: true,
        fingerprint,
        processingStatus: existing.processingStatus || 'imported',
      };
      // Same fingerprint means identical bytes, so the stored blob is this
      // file. Rewrite it only when the row has none or its blob is gone
      // (a removed row can outlive its blob).
      let stored = null;
      if (updated.blobRef) {
        try { stored = await readSourceBlob(updated.blobRef); } catch { stored = null; }
      }
      if (!stored) {
        updated.blobRef = await writeSourceBlob(updated.id, file);
      }
      const db = await openLibraryDb();
      const tx = idbTransaction(db, META_STORE, 'readwrite');
      await idbPut(tx.objectStore(META_STORE), updated);
      await idbTxDone(tx);
      await setSessionState({
        activeFileId: updated.id,
        importMode: mode,
        lastFilename: originalFilename,
        updatedAt: now,
      });
      await enforceTrackCap(updated.id);
      return updated;
    }
  }

  const id = newId();
  /** @type {LibraryFileMeta} */
  let meta = {
    id,
    originalFilename,
    mimeType,
    size,
    duration: null,
    sampleRate: null,
    channels: null,
    waveformCacheKey: null,
    analysisCacheKey: null,
    createdAt: now,
    updatedAt: now,
    processingStatus: 'imported',
    projectId: mode === 'project' ? projectId : projectId,
    tags,
    importMode: mode,
    blobRef: null,
    inLibrary: true,
    fingerprint,
  };

  meta.blobRef = await writeSourceBlob(id, file);

  const db = await openLibraryDb();
  const tx = idbTransaction(db, META_STORE, 'readwrite');
  await idbPut(tx.objectStore(META_STORE), meta);
  await idbTxDone(tx);

  await setSessionState({
    activeFileId: id,
    importMode: mode,
    lastFilename: originalFilename,
    updatedAt: now,
  });

  await enforceTrackCap(id);
  return meta;
}

/** @type {Map<string, { file: File|Blob, meta: LibraryFileMeta }>} */
const _ephemeral = new Map();

/**
 * @returns {Promise<LibraryFileMeta[]>}
 */
export async function listLibraryFiles() {
  try {
    const db = await openLibraryDb();
    const tx = db.transaction(META_STORE, 'readonly');
    const all = await idbGetAll(tx.objectStore(META_STORE));
    return all
      .filter((m) => m && m.inLibrary !== false)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  } catch {
    return [];
  }
}

/**
 * @param {string} id
 * @returns {Promise<LibraryFileMeta|null>}
 */
export async function getFileMeta(id) {
  if (!id) return null;
  if (_ephemeral.has(id)) return _ephemeral.get(id).meta;
  try {
    const db = await openLibraryDb();
    const tx = db.transaction(META_STORE, 'readonly');
    return (await idbGet(tx.objectStore(META_STORE), id)) || null;
  } catch {
    return null;
  }
}

/**
 * Load source as a File for decode / export.
 * @param {string} id
 * @returns {Promise<{ file: File, meta: LibraryFileMeta }|null>}
 */
export async function openSourceFile(id) {
  if (!id) return null;
  if (_ephemeral.has(id)) {
    const e = _ephemeral.get(id);
    return { file: /** @type {File} */ (e.file), meta: e.meta };
  }
  const meta = await getFileMeta(id);
  if (!meta?.blobRef) return null;
  const blob = await readSourceBlob(meta.blobRef);
  if (!blob) return null;
  const file = blobToFile(blob, meta);
  return { file, meta };
}

/**
 * @param {string} id
 * @param {Partial<LibraryFileMeta>} patch
 */
export async function updateFileMeta(id, patch) {
  if (!id || !patch) return null;
  if (_ephemeral.has(id)) {
    const e = _ephemeral.get(id);
    e.meta = { ...e.meta, ...patch, id, updatedAt: Date.now() };
    return e.meta;
  }
  const db = await openLibraryDb();
  const tx = idbTransaction(db, META_STORE, 'readwrite');
  const store = tx.objectStore(META_STORE);
  const existing = await idbGet(store, id);
  if (!existing) return null;
  const next = {
    ...existing,
    ...patch,
    id,
    updatedAt: Date.now(),
  };
  await idbPut(store, next);
  await idbTxDone(tx);
  return next;
}

/**
 * Remove from library catalog (keeps blob until permanent delete).
 * @param {string} id
 */
export async function removeFromLibrary(id) {
  const meta = await updateFileMeta(id, { inLibrary: false, processingStatus: 'idle' });
  // A removed track must not come back as the active file on the next boot.
  const session = await getSessionState();
  if (session?.activeFileId === id) {
    await setSessionState({ activeFileId: null, updatedAt: Date.now() });
  }
  return meta;
}

/**
 * Permanently delete metadata + blob.
 * @param {string} id
 */
export async function deleteFilePermanently(id) {
  if (!id) return;
  if (_ephemeral.has(id)) {
    _ephemeral.delete(id);
  }
  const meta = await getFileMeta(id);
  try {
    await purgeTrackCaches(id, { blobRef: meta?.blobRef || null });
  } catch {
    if (meta?.blobRef) {
      try { await deleteSourceBlob(meta.blobRef); } catch { /* ignore */ }
    }
  }
  try {
    const db = await openLibraryDb();
    const tx = idbTransaction(db, META_STORE, 'readwrite');
    await idbDelete(tx.objectStore(META_STORE), id);
    await idbTxDone(tx);
  } catch {
    // ignore
  }
  const session = await getSessionState();
  if (session?.activeFileId === id) {
    await setSessionState({ activeFileId: null, updatedAt: Date.now() });
  }
}

/**
 * @param {object} state
 */
export async function setSessionState(state) {
  try {
    const db = await openLibraryDb();
    const tx = idbTransaction(db, SESSION_STORE, 'readwrite');
    const prev = (await idbGet(tx.objectStore(SESSION_STORE), 'current')) || { key: 'current' };
    const next = { ...prev, ...state, key: 'current' };
    await idbPut(tx.objectStore(SESSION_STORE), next);
    await idbTxDone(tx);
    return next;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<object|null>}
 */
export async function getSessionState() {
  try {
    const db = await openLibraryDb();
    const tx = db.transaction(SESSION_STORE, 'readonly');
    return (await idbGet(tx.objectStore(SESSION_STORE), 'current')) || null;
  } catch {
    return null;
  }
}

/**
 * Restore bootstrap: session + preferred active library file.
 *
 * By default does NOT hydrate giant blobs into RAM (that OOM-crashed browsers).
 * Pass `{ hydrateActive: true }` only for small files or explicit user open.
 *
 * @param {{ hydrateActive?: boolean, maxHydrateBytes?: number }} [opts]
 * @returns {Promise<{ session: object|null, files: LibraryFileMeta[], active: { file: File|Blob, meta: LibraryFileMeta }|null, activeMeta: LibraryFileMeta|null, backend: string, hydrated: boolean }>}
 */
export async function restoreSessionBootstrap(opts = {}) {
  const {
    hydrateActive = false,
    maxHydrateBytes = 64 * 1024 * 1024,
  } = opts;
  const backend = await resolveBlobBackend().catch(() => 'idb');
  const session = await getSessionState();
  const files = await listLibraryFiles();
  let activeMeta = null;
  const activeId = session?.activeFileId;
  if (activeId) {
    activeMeta = await getFileMeta(activeId);
    if (activeMeta?.inLibrary === false) activeMeta = null;
    if (!activeMeta && files[0]) activeMeta = files[0];
  } else if (files[0]) {
    activeMeta = files[0];
  }

  let active = null;
  let hydrated = false;
  if (activeMeta && hydrateActive) {
    const size = Number(activeMeta.size) || 0;
    if (size > 0 && size <= maxHydrateBytes) {
      active = await openSourceFile(activeMeta.id);
      hydrated = Boolean(active?.file);
    }
  }
  return { session, files, active, activeMeta, backend, hydrated };
}

export async function getStorageBackendName() {
  return resolveBlobBackend();
}

export default {
  importFile,
  listLibraryFiles,
  getFileMeta,
  openSourceFile,
  updateFileMeta,
  removeFromLibrary,
  deleteFilePermanently,
  setSessionState,
  getSessionState,
  restoreSessionBootstrap,
  getStorageBackendName,
};
