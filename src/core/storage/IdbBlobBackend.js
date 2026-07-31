/**
 * IndexedDB blob backend — fallback when OPFS is unavailable (Firefox private,
 * older WebViews, restricted iframes).
 */
'use strict';

import { openIdb, idbGet, idbPut, idbDelete } from './openIdb.js';

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
  const tx = db.transaction(STORE, 'readwrite');
  const blob = data instanceof Blob ? data : new Blob([data]);
  await idbPut(tx.objectStore(STORE), blob, key);
  // put success is enough; oncomplete is best-effort (see openIdb.idbTxDone).
  await new Promise((resolve, reject) => {
    let done = false;
    const ok = () => { if (!done) { done = true; resolve(); } };
    const fail = () => { if (!done) { done = true; reject(tx.error || new Error('idb write failed')); } };
    tx.oncomplete = ok;
    tx.onerror = fail;
    tx.onabort = fail;
    setTimeout(ok, 0);
  });
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
    const tx = db.transaction(STORE, 'readwrite');
    await idbDelete(tx.objectStore(STORE), key);
    await new Promise((resolve) => {
      let done = false;
      const ok = () => { if (!done) { done = true; resolve(); } };
      tx.oncomplete = ok;
      tx.onerror = ok;
      tx.onabort = ok;
      setTimeout(ok, 0);
    });
  } catch {
    // ignore
  }
}

export default { idbBlobWrite, idbBlobRead, idbBlobDelete };
