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
 * @param {Blob} blob
 * @param {{ originalFilename?: string, mimeType?: string }} meta
 * @returns {File}
 */
export function blobToFile(blob, meta = {}) {
  const name = meta.originalFilename || 'restored-audio';
  const type = meta.mimeType || blob.type || 'application/octet-stream';
  try {
    return new File([blob], name, { type, lastModified: Date.now() });
  } catch {
    // Older WebViews: Blob with name property
    const b = blob.slice(0, blob.size, type);
    Object.defineProperty(b, 'name', { value: name });
    return /** @type {File} */ (b);
  }
}

export default {
  resolveBlobBackend,
  writeSourceBlob,
  readSourceBlob,
  deleteSourceBlob,
  blobToFile,
};
