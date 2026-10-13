'use strict';

/**
 * Minimal in-memory IndexedDB for storage unit tests: databases, object
 * stores, get/put/delete/getAll, deferred success callbacks and
 * transaction completion. No indexes, cursors or abort semantics.
 */
function installMemoryIdb() {
  /** @type {Map<string, object>} */
  const dbs = new Map();

  class MemReq {
    constructor() {
      this.result = null;
      this.error = null;
      this.onsuccess = null;
      this.onerror = null;
      this.onupgradeneeded = null;
      this.onblocked = null;
      this.transaction = null;
    }
    _ok(val) {
      this.result = val;
      // Defer so callers can attach onsuccess after open()/get()/put().
      queueMicrotask(() => {
        queueMicrotask(() => this.onsuccess?.({ target: this }));
      });
    }
  }

  class MemStore {
    constructor(data) {
      this._data = data;
    }
    get(key) {
      const req = new MemReq();
      req._ok(this._data.get(key));
      return req;
    }
    put(value, key) {
      const req = new MemReq();
      const k = key !== undefined ? key : value?.id ?? value?.key ?? value?.projectId;
      this._data.set(k, value);
      req._ok(k);
      return req;
    }
    delete(key) {
      const req = new MemReq();
      this._data.delete(key);
      req._ok(undefined);
      return req;
    }
    getAll() {
      const req = new MemReq();
      req._ok([...this._data.values()]);
      return req;
    }
    createIndex() { /* no-op */ }
    get indexNames() {
      return { contains: () => false };
    }
  }

  class MemTx {
    constructor(db) {
      this.db = db;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
      this.error = null;
      // Double microtask: openIdb/idbTxDone assign handlers after transaction().
      queueMicrotask(() => {
        queueMicrotask(() => this.oncomplete?.());
      });
    }
    objectStore(name) {
      if (!this.db._stores.has(name)) this.db._stores.set(name, new Map());
      return new MemStore(this.db._stores.get(name));
    }
  }

  class MemDb {
    constructor(name) {
      this.name = name;
      this.objectStoreNames = {
        _names: new Set(),
        contains(n) { return this._names.has(n); },
      };
      this._stores = new Map();
    }
    createObjectStore(name) {
      this.objectStoreNames._names.add(name);
      this._stores.set(name, new Map());
      return new MemStore(this._stores.get(name));
    }
    transaction() {
      return new MemTx(this);
    }
  }

  globalThis.indexedDB = {
    open(name, version = 1) {
      const req = new MemReq();
      const cacheKey = `${name}@${version}`;
      const existing = dbs.get(cacheKey);
      const db = existing || new MemDb(name);
      if (!existing) dbs.set(cacheKey, db);
      req.transaction = {
        objectStore: (n) => {
          if (!db._stores.has(n)) db._stores.set(n, new Map());
          const s = new MemStore(db._stores.get(n));
          s.indexNames = { contains: () => false };
          s.createIndex = () => {};
          return s;
        },
      };
      queueMicrotask(() => {
        if (!existing) {
          req.result = db;
          req.onupgradeneeded?.({ target: req, oldVersion: 0 });
        }
        queueMicrotask(() => {
          req.result = db;
          req.onsuccess?.({ target: req });
        });
      });
      return req;
    },
  };

  globalThis.navigator = { storage: undefined };
}


module.exports = { installMemoryIdb };
