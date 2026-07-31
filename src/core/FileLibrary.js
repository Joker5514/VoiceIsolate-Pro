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
} from './storage/openIdb.js';
import {
  writeSourceBlob,
  readSourceBlob,
  deleteSourceBlob,
  blobToFile,
  resolveBlobBackend,
} from './storage/BlobStore.js';

const DB_NAME = 'vip-file-library';
const DB_VERSION = 1;
const META_STORE = 'files';
const SESSION_STORE = 'session';

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
  return openIdb(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(META_STORE)) {
      const store = db.createObjectStore(META_STORE, { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt', { unique: false });
      store.createIndex('projectId', 'projectId', { unique: false });
      store.createIndex('inLibrary', 'inLibrary', { unique: false });
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
 * @param {File|Blob} file
 * @param {object} [opts]
 * @param {ImportMode} [opts.mode]
 * @param {string|null} [opts.projectId]
 * @param {string[]} [opts.tags]
 * @returns {Promise<LibraryFileMeta>}
 */
export async function importFile(file, opts = {}) {
  if (!file) throw new TypeError('[VIP][FileLibrary] importFile requires a File/Blob');
  const mode = /** @type {ImportMode} */ (opts.mode || 'library');
  const projectId = opts.projectId || null;
  const tags = Array.isArray(opts.tags) ? opts.tags.slice() : [];
  const id = newId();
  const now = Date.now();
  const originalFilename = /** @type {File} */ (file).name || 'import';
  const mimeType = file.type || 'application/octet-stream';
  const size = file.size || 0;

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
    inLibrary: mode !== 'temporary',
  };

  if (mode !== 'temporary') {
    const blobRef = await writeSourceBlob(id, file);
    meta.blobRef = blobRef;
  }

  if (meta.inLibrary) {
    const db = await openLibraryDb();
    const tx = db.transaction(META_STORE, 'readwrite');
    await idbPut(tx.objectStore(META_STORE), meta);
    await idbTxDone(tx);
  }

  // Session always tracks last active (including temporary id for tab recovery mid-session only)
  await setSessionState({
    activeFileId: id,
    importMode: mode,
    lastFilename: originalFilename,
    updatedAt: now,
  });

  // Attach ephemeral handle for current tab when temporary
  if (mode === 'temporary') {
    _ephemeral.set(id, { file, meta });
  }

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
  const tx = db.transaction(META_STORE, 'readwrite');
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
  return updateFileMeta(id, { inLibrary: false, processingStatus: 'idle' });
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
  if (meta?.blobRef) {
    await deleteSourceBlob(meta.blobRef);
  }
  try {
    const { deleteDerivedForFile } = await import('./storage/DerivedCache.js');
    await deleteDerivedForFile(id);
  } catch {
    // ignore derived cleanup failures
  }
  try {
    const db = await openLibraryDb();
    const tx = db.transaction(META_STORE, 'readwrite');
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
    const tx = db.transaction(SESSION_STORE, 'readwrite');
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
 * @returns {Promise<{ session: object|null, files: LibraryFileMeta[], active: { file: File, meta: LibraryFileMeta }|null, backend: string }>}
 */
export async function restoreSessionBootstrap() {
  const backend = await resolveBlobBackend().catch(() => 'idb');
  const session = await getSessionState();
  const files = await listLibraryFiles();
  let active = null;
  const activeId = session?.activeFileId;
  if (activeId) {
    active = await openSourceFile(activeId);
    // If session pointed at temporary / missing, fall back to newest library file
    if (!active && files[0]) {
      active = await openSourceFile(files[0].id);
    }
  } else if (files[0]) {
    active = await openSourceFile(files[0].id);
  }
  return { session, files, active, backend };
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
