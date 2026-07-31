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
  const handle = await getFileHandle(relativePath, true);
  const writable = await handle.createWritable();
  try {
    if (data instanceof Blob) {
      await writable.write(data);
    } else if (data instanceof ArrayBuffer) {
      await writable.write(data);
    } else if (ArrayBuffer.isView(data)) {
      await writable.write(data);
    } else {
      throw new TypeError('[VIP][OPFS] unsupported write payload');
    }
  } finally {
    await writable.close();
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
