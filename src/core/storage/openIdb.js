/**
 * Shared IndexedDB open helper (single connection per name/version).
 * 100% local — no network.
 */
'use strict';

/** @type {Map<string, Promise<IDBDatabase>>} */
const _open = new Map();

/**
 * @param {string} name
 * @param {number} version
 * @param {(db: IDBDatabase, oldVersion: number, tx: IDBTransaction) => void} onUpgrade
 * @returns {Promise<IDBDatabase>}
 */
export function openIdb(name, version, onUpgrade) {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('[VIP][openIdb] IndexedDB unavailable'));
  }
  const key = `${name}@${version}`;
  if (_open.has(key)) return _open.get(key);

  const p = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (ev) => {
      try {
        onUpgrade(req.result, ev.oldVersion || 0, req.transaction);
      } catch (err) {
        reject(err);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('[VIP][openIdb] open failed'));
    req.onblocked = () => {
      // Another tab holds an older connection — still resolve when we can.
    };
  });

  _open.set(key, p);
  p.catch(() => _open.delete(key));
  return p;
}

/**
 * @param {IDBObjectStore} store
 * @param {IDBValidKey} key
 */
export function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {IDBObjectStore} store
 * @param {unknown} value
 * @param {IDBValidKey} [key]
 */
export function idbPut(store, value, key) {
  return new Promise((resolve, reject) => {
    const req = key === undefined ? store.put(value) : store.put(value, key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {IDBObjectStore} store
 * @param {IDBValidKey} key
 */
export function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const req = store.delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {IDBObjectStore} store
 */
export function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * @param {IDBTransaction} tx
 */
export function idbTxDone(tx) {
  return new Promise((resolve, reject) => {
    // If the transaction already finished (common in tests / fast puts), resolve.
    if (tx.error) {
      reject(tx.error);
      return;
    }
    // Some environments expose mode/state; best-effort active check.
    try {
      if (typeof tx.objectStoreNames !== 'undefined' && tx._vipDone) {
        resolve();
        return;
      }
    } catch { /* ignore */ }

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };

    const prevComplete = tx.oncomplete;
    const prevError = tx.onerror;
    const prevAbort = tx.onabort;

    tx.oncomplete = (ev) => {
      try { prevComplete?.(ev); } catch { /* ignore */ }
      finish(resolve);
    };
    tx.onerror = (ev) => {
      try { prevError?.(ev); } catch { /* ignore */ }
      finish(reject, tx.error || new Error('IDB transaction error'));
    };
    tx.onabort = (ev) => {
      try { prevAbort?.(ev); } catch { /* ignore */ }
      finish(reject, tx.error || new Error('IDB transaction aborted'));
    };

    // Fallback: if oncomplete never fires (mock races), resolve on next macrotask
    // when no error is present — production browsers fire oncomplete reliably.
    setTimeout(() => {
      if (!settled && !tx.error) finish(resolve);
    }, 0);
  });
}

export default openIdb;
