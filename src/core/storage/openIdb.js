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
        // Abort so a half-applied schema is never committed at the new version.
        try { req.transaction?.abort(); } catch { /* ignore */ }
        reject(err);
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Let another tab upgrade instead of blocking it forever; the next
      // openIdb() call reopens at the new version.
      db.onversionchange = () => {
        try { db.close(); } catch { /* ignore */ }
        if (_open.get(key) === p) _open.delete(key);
      };
      db.onclose = () => {
        if (_open.get(key) === p) _open.delete(key);
      };
      resolve(db);
    };
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

/** @type {WeakMap<IDBTransaction, Promise<void>>} */
const _txDone = new WeakMap();

function listen(tx, type, fn) {
  if (typeof tx.addEventListener === 'function') {
    tx.addEventListener(type, fn);
    return;
  }
  const prop = `on${type}`;
  const prev = tx[prop];
  tx[prop] = (ev) => {
    try { prev?.(ev); } catch { /* ignore */ }
    fn(ev);
  };
}

function trackTx(tx) {
  let done = _txDone.get(tx);
  if (done) return done;
  done = new Promise((resolve, reject) => {
    listen(tx, 'complete', () => resolve());
    // A failed request also aborts its transaction; `abort` is the final
    // event either way, and carries quota errors raised at commit time.
    listen(tx, 'abort', () => {
      reject(tx.error || Object.assign(new Error('IDB transaction aborted'), { name: 'AbortError' }));
    });
  });
  // Callers that already failed on a request never await completion.
  done.catch(() => {});
  _txDone.set(tx, done);
  return done;
}

/**
 * Open a transaction with completion tracking registered synchronously, before
 * any request is issued. The transaction may commit while the caller awaits its
 * requests, so tracking attached later can miss `complete` entirely.
 * @param {IDBDatabase} db
 * @param {string|string[]} stores
 * @param {IDBTransactionMode} [mode]
 * @returns {IDBTransaction}
 */
export function idbTransaction(db, stores, mode = 'readonly') {
  const tx = db.transaction(stores, mode);
  trackTx(tx);
  return tx;
}

/**
 * Resolves only when the transaction has committed (`complete`); rejects on
 * abort, including errors raised at commit such as QuotaExceededError. The
 * transaction must come from {@link idbTransaction}: one created elsewhere is
 * tracked from this call on, which is safe only while it is still active.
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
export function idbTxDone(tx) {
  return trackTx(tx);
}

export default openIdb;
