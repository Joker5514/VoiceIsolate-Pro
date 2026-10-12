/**
 * IndexedDB blob backend — fallback when OPFS is unavailable (Firefox private,
 * older WebViews, restricted iframes).
 */
'use strict';

import { openIdb, idbGet, idbPut, idbDelete, idbTransaction, idbTxDone } from './openIdb.js';

const DB_NAME = 'vip-blob-store';
const DB_VERSION = 1;
const STORE = 'blobs';

function open() {
  return openIdb(DB_NAME, DB_VERSION, (db) => {
    if (!db.objectStoreNames.contains(STORE)) {
      db.createObjectStore(STORE);
    }
  });
}

/**
 * @param {string} key
 * @param {Blob|ArrayBuffer} data
 */
export async function idbBlobWrite(key, data) {
  const db = await open();
  const tx = idbTransaction(db, STORE, 'readwrite');
  const blob = data instanceof Blob ? data : new Blob([data]);
  await idbPut(tx.objectStore(STORE), blob, key);
  // A successful put is not a durable write: quota is enforced at commit.
  await idbTxDone(tx);
}

/**
 * @param {string} key
 * @returns {Promise<Blob|null>}
 */
export async function idbBlobRead(key) {
  try {
    const db = await open();
    const tx = db.transaction(STORE, 'readonly');
    const val = await idbGet(tx.objectStore(STORE), key);
    if (!val) return null;
    if (val instanceof Blob) return val;
    return new Blob([val]);
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 */
export async function idbBlobDelete(key) {
  try {
    const db = await open();
    const tx = idbTransaction(db, STORE, 'readwrite');
    await idbDelete(tx.objectStore(STORE), key);
    await idbTxDone(tx);
  } catch {
    // ignore
  }
}

export default { idbBlobWrite, idbBlobRead, idbBlobDelete };
