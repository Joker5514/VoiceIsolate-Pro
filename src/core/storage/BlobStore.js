/**
 * Unified blob storage: OPFS preferred, IndexedDB fallback.
 * Reconstruct File/Blob handles for decode without keeping Float32 permanently.
 */
'use strict';

import { isOpfsAvailable, opfsWrite, opfsReadBlob, opfsDelete } from './OpfsBackend.js';
import { idbBlobWrite, idbBlobRead, idbBlobDelete } from './IdbBlobBackend.js';

/** @type {boolean|null} */
let _opfs = null;

export async function resolveBlobBackend() {
  if (_opfs === null) {
    _opfs = await isOpfsAvailable();
  }
  return _opfs ? 'opfs' : 'idb';
}

/**
 * @param {string} id
 * @param {Blob|File} blob
 * @returns {Promise<{ backend: 'opfs'|'idb', path: string }>}
 */
export async function writeSourceBlob(id, blob) {
  if (!id || !blob) throw new TypeError('[VIP][BlobStore] writeSourceBlob requires id + blob');
  const backend = await resolveBlobBackend();
  if (backend === 'opfs') {
    const path = `library/${id}.bin`;
    await opfsWrite(path, blob);
    return { backend: 'opfs', path };
  }
  const path = `source:${id}`;
  await idbBlobWrite(path, blob);
  return { backend: 'idb', path };
}

/**
 * @param {{ backend: string, path: string }} ref
 * @returns {Promise<Blob|null>}
 */
export async function readSourceBlob(ref) {
  if (!ref?.path) return null;
  if (ref.backend === 'opfs') return opfsReadBlob(ref.path);
  return idbBlobRead(ref.path);
}

/**
 * @param {{ backend: string, path: string }} ref
 */
export async function deleteSourceBlob(ref) {
  if (!ref?.path) return;
  if (ref.backend === 'opfs') {
    await opfsDelete(ref.path);
    return;
  }
  await idbBlobDelete(ref.path);
}

/**
 * Build a File-like object for decode/UI from stored blob + metadata.
 * CRITICAL: never use `new File([giantBlob])` for large media — that copies the
 * entire payload in memory and OOM-crashes mobile browsers / Android WebViews.
 *
 * @param {Blob} blob
 * @param {{ originalFilename?: string, mimeType?: string }} meta
 * @returns {File|Blob}
 */
export function blobToFile(blob, meta = {}) {
  const name = meta.originalFilename || 'restored-audio';
  const type = meta.mimeType || blob?.type || 'application/octet-stream';
  if (!blob) {
    throw new TypeError('[VIP][BlobStore] blobToFile requires a Blob');
  }

  // OPFS getFile() already returns a File — reuse without copying.
  if (typeof File !== 'undefined' && blob instanceof File) {
    if (!name || blob.name === name) return blob;
    // Rename without reading bytes when possible (small files only).
    if (blob.size <= 32 * 1024 * 1024) {
      try {
        return new File([blob], name, { type: type || blob.type, lastModified: blob.lastModified || Date.now() });
      } catch { /* fall through to name patch */ }
    }
    try {
      Object.defineProperty(blob, 'name', { value: name, configurable: true });
    } catch { /* read-only name on some engines */ }
    return blob;
  }

  // Large blobs: attach .name in place — File constructor would double RAM.
  if (blob.size > 32 * 1024 * 1024) {
    try {
      Object.defineProperty(blob, 'name', { value: name, configurable: true });
    } catch { /* ignore */ }
    return /** @type {File} */ (blob);
  }

  try {
    return new File([blob], name, { type, lastModified: Date.now() });
  } catch {
    try {
      Object.defineProperty(blob, 'name', { value: name, configurable: true });
    } catch { /* ignore */ }
    return /** @type {File} */ (blob);
  }
}

export default {
  resolveBlobBackend,
  writeSourceBlob,
  readSourceBlob,
  deleteSourceBlob,
  blobToFile,
};
