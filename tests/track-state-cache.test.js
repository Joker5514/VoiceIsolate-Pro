/**
 * TrackState + CacheManifest unit tests.
 */
'use strict';

function installMemoryIdb() {
  const dbs = new Map();
  class MemReq {
    constructor() {
      this.result = null;
      this.onsuccess = null;
      this.onerror = null;
      this.onupgradeneeded = null;
      this.transaction = null;
    }
    _ok(val) {
      this.result = val;
      queueMicrotask(() => queueMicrotask(() => this.onsuccess?.({ target: this })));
    }
  }
  class MemStore {
    constructor(data) { this._data = data; this.indexNames = { contains: () => false }; }
    createIndex() {}
    get(key) { const r = new MemReq(); r._ok(this._data.get(key)); return r; }
    put(value, key) {
      const r = new MemReq();
      const k = key !== undefined ? key : value?.fileId ?? value?.key ?? value?.id;
      this._data.set(k, value);
      r._ok(k);
      return r;
    }
    delete(key) { const r = new MemReq(); this._data.delete(key); r._ok(); return r; }
    getAll() { const r = new MemReq(); r._ok([...this._data.values()]); return r; }
  }
  class MemTx {
    constructor(db) {
      this.db = db;
      this.oncomplete = null;
      queueMicrotask(() => queueMicrotask(() => this.oncomplete?.()));
    }
    objectStore(name) {
      if (!this.db._stores.has(name)) this.db._stores.set(name, new Map());
      return new MemStore(this.db._stores.get(name));
    }
  }
  class MemDb {
    constructor(name) {
      this.name = name;
      this.objectStoreNames = { _names: new Set(), contains(n) { return this._names.has(n); } };
      this._stores = new Map();
    }
    createObjectStore(name) {
      this.objectStoreNames._names.add(name);
      this._stores.set(name, new Map());
      return new MemStore(this._stores.get(name));
    }
    transaction() { return new MemTx(this); }
  }
  globalThis.indexedDB = {
    open(name, version = 1) {
      const req = new MemReq();
      const k = `${name}@${version}`;
      const existing = dbs.get(k);
      const db = existing || new MemDb(name);
      if (!existing) dbs.set(k, db);
      req.transaction = { objectStore: (n) => db.createObjectStore(n) };
      queueMicrotask(() => {
        if (!existing) {
          req.result = db;
          req.onupgradeneeded?.({ target: req, oldVersion: 0 });
        }
        queueMicrotask(() => { req.result = db; req.onsuccess?.({ target: req }); });
      });
      return req;
    },
  };
  globalThis.navigator = { storage: undefined };
}

installMemoryIdb();

describe('TrackState', () => {
  /** @type {typeof import('../src/core/TrackState.js')} */
  let TrackState;

  beforeAll(async () => {
    TrackState = await import('../src/core/TrackState.js');
  });

  test('save and get track state', async () => {
    const row = await TrackState.saveTrackState('track-1', {
      params: { voiceIso: 0.8, gateThresh: -40 },
      presetName: 'Voice Clarity',
      status: 'processed',
    });
    expect(row.fileId).toBe('track-1');
    expect(row.rev).toBe(1);
    const got = await TrackState.getTrackState('track-1');
    expect(got.params.voiceIso).toBe(0.8);
    expect(got.presetName).toBe('Voice Clarity');
  }, 10000);

  test('upsert increments rev', async () => {
    await TrackState.saveTrackState('track-2', { params: { a: 1 } });
    const r2 = await TrackState.saveTrackState('track-2', { params: { a: 2 } });
    expect(r2.rev).toBeGreaterThanOrEqual(2);
    expect(r2.params.a).toBe(2);
  }, 10000);
});

describe('CacheManifest', () => {
  test('contentFingerprint is stable for same bytes', async () => {
    const { contentFingerprint, APP_CACHE_VERSION, cacheKey } = await import('../src/core/storage/CacheManifest.js');
    const b = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'audio/wav' });
    Object.defineProperty(b, 'name', { value: 'a.wav' });
    const a = await contentFingerprint(b);
    const c = await contentFingerprint(b);
    expect(a).toBe(c);
    expect(a.startsWith('fp_')).toBe(true);
    expect(cacheKey('stems', 'x')).toContain(APP_CACHE_VERSION);
  });

  test('ensureCacheFresh sets version', async () => {
    const { ensureCacheFresh, getCacheMeta, APP_CACHE_VERSION } = await import('../src/core/storage/CacheManifest.js');
    await ensureCacheFresh();
    const meta = await getCacheMeta();
    expect(meta.version).toBe(APP_CACHE_VERSION);
  }, 10000);
});
