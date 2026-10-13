/**
 * Origin Private File System blob backend.
 * Prefer for large source assets on Chromium desktop + many Android WebViews.
 */
'use strict';

/**
 * @returns {Promise<boolean>}
 */
export async function isOpfsAvailable() {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return false;
    // Safari 15.2-18 exposes getDirectory() but not createWritable() on the
    // main thread; writes would then always fail, so treat OPFS as absent.
    if (typeof FileSystemFileHandle === 'undefined'
      || typeof FileSystemFileHandle.prototype.createWritable !== 'function') return false;
    const root = await navigator.storage.getDirectory();
    return Boolean(root);
  } catch {
    return false;
  }
}

/**
 * @param {string} relativePath e.g. "library/abc123.bin"
 * @returns {Promise<FileSystemFileHandle>}
 */
async function getFileHandle(relativePath, create = false) {
  const root = await navigator.storage.getDirectory();
  const parts = relativePath.split('/').filter(Boolean);
  let dir = root;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create });
  }
  return dir.getFileHandle(parts[parts.length - 1], { create });
}

/**
 * @param {string} relativePath
 * @param {Blob|ArrayBuffer|Uint8Array} data
 */
export async function opfsWrite(relativePath, data) {
  if (!(data instanceof Blob || data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
    throw new TypeError('[VIP][OPFS] unsupported write payload');
  }
  let existed = true;
  try {
    await getFileHandle(relativePath, false);
  } catch {
    existed = false;
  }
  const handle = await getFileHandle(relativePath, true);
  let writable = null;
  try {
    writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  } catch (err) {
    // abort() discards the swap file, so an existing file keeps its old
    // contents; only an entry this attempt created is removed.
    try { await writable?.abort?.(); } catch { /* ignore */ }
    if (!existed) await opfsDelete(relativePath);
    throw err;
  }
}

/**
 * @param {string} relativePath
 * @returns {Promise<Blob|null>}
 */
export async function opfsReadBlob(relativePath) {
  try {
    const handle = await getFileHandle(relativePath, false);
    const file = await handle.getFile();
    return file;
  } catch {
    return null;
  }
}

/**
 * @param {string} relativePath
 */
export async function opfsDelete(relativePath) {
  try {
    const root = await navigator.storage.getDirectory();
    const parts = relativePath.split('/').filter(Boolean);
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: false });
    }
    await dir.removeEntry(parts[parts.length - 1]);
  } catch {
    // Missing is fine
  }
}

export default { isOpfsAvailable, opfsWrite, opfsReadBlob, opfsDelete };
