/**
 * FileLibrary unit tests — pure logic + IDB-mocked import path.
 */
'use strict';

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

installMemoryIdb();

/** @type {typeof import('../src/core/FileLibrary.js')} */
let FileLibrary;
/** @type {typeof import('../src/core/ProjectStore.js')} */
let ProjectStore;

beforeAll(async () => {
  FileLibrary = await import('../src/core/FileLibrary.js');
  ProjectStore = await import('../src/core/ProjectStore.js');
});

function makeFile(bytes, name, type) {
  const blob = new Blob([new Uint8Array(bytes)], { type });
  if (typeof File !== 'undefined') {
    return new File([blob], name, { type });
  }
  return Object.assign(blob, { name });
}

describe('FileLibrary', () => {
  test('importFile library mode writes metadata and blob (idb fallback)', async () => {
    const file = makeFile([1, 2, 3, 4], 'clip.wav', 'audio/wav');
    const meta = await FileLibrary.importFile(file, { mode: 'library' });
    expect(meta.id).toBeTruthy();
    expect(meta.originalFilename).toBe('clip.wav');
    expect(meta.inLibrary).toBe(true);
    expect(meta.blobRef).toBeTruthy();
    expect(meta.blobRef.backend).toBe('idb');

    const listed = await FileLibrary.listLibraryFiles();
    expect(listed.some((f) => f.id === meta.id)).toBe(true);

    const opened = await FileLibrary.openSourceFile(meta.id);
    expect(opened).toBeTruthy();
    expect(opened.meta.id).toBe(meta.id);
    expect(opened.file.size).toBe(4);
  }, 15000);

  test('temporary mode is not listed in library catalog', async () => {
    const file = makeFile([9], 'tmp.wav', 'audio/wav');
    const meta = await FileLibrary.importFile(file, { mode: 'temporary' });
    expect(meta.inLibrary).toBe(false);
    const listed = await FileLibrary.listLibraryFiles();
    expect(listed.some((f) => f.id === meta.id)).toBe(false);

    const opened = await FileLibrary.openSourceFile(meta.id);
    expect(opened?.meta.id).toBe(meta.id);
  }, 15000);

  test('deleteFilePermanently removes catalog entry', async () => {
    const file = makeFile([7, 7], 'gone.mp3', 'audio/mpeg');
    const meta = await FileLibrary.importFile(file, { mode: 'library' });
    await FileLibrary.deleteFilePermanently(meta.id);
    const listed = await FileLibrary.listLibraryFiles();
    expect(listed.some((f) => f.id === meta.id)).toBe(false);
    const opened = await FileLibrary.openSourceFile(meta.id);
    expect(opened).toBeNull();
  }, 15000);

  test('ProjectStore create + link', async () => {
    const p = await ProjectStore.createProject({ name: 'Test Proj' });
    expect(p.projectId).toBeTruthy();
    await ProjectStore.linkSourceFile(p.projectId, 'file-1');
    const got = await ProjectStore.getProject(p.projectId);
    expect(got.sourceFileIds).toContain('file-1');
    expect(got.name).toBe('Test Proj');
  }, 15000);

  test('restoreSessionBootstrap does not hydrate by default', async () => {
    const file = makeFile([1, 2, 3], 'soft.wav', 'audio/wav');
    const meta = await FileLibrary.importFile(file, { mode: 'library' });
    const boot = await FileLibrary.restoreSessionBootstrap({ hydrateActive: false });
    expect(boot.activeMeta?.id || boot.files.some((f) => f.id === meta.id)).toBeTruthy();
    expect(boot.hydrated).toBe(false);
    expect(boot.active).toBeNull();
  }, 15000);

  test('blobToFile does not throw on large-ish blobs', async () => {
    const { blobToFile } = await import('../src/core/storage/BlobStore.js');
    const big = new Blob([new Uint8Array(1024)]);
    const f = blobToFile(big, { originalFilename: 'x.wav', mimeType: 'audio/wav' });
    expect(f).toBeTruthy();
    expect(f.name === 'x.wav' || f.size === 1024).toBe(true);
  });

  test('same content re-import upserts canonical track (no duplicate)', async () => {
    const bytes = [9, 8, 7, 6, 5, 4];
    const a = makeFile(bytes, 'dup.wav', 'audio/wav');
    const b = makeFile(bytes, 'dup.wav', 'audio/wav');
    const m1 = await FileLibrary.importFile(a, { mode: 'library' });
    const m2 = await FileLibrary.importFile(b, { mode: 'library' });
    expect(m2.id).toBe(m1.id);
    const listed = await FileLibrary.listLibraryFiles();
    expect(listed.filter((f) => f.id === m1.id)).toHaveLength(1);
  }, 15000);

  test('MAX_LIBRARY_TRACKS is 5', () => {
    expect(FileLibrary.MAX_LIBRARY_TRACKS).toBe(5);
  });
});

describe('StemSeparation reset keeps cache', () => {
  test('resetStemSeparation source does not call clearStemCache', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/pipeline/StemSeparation.js'),
      'utf8',
    );
    const m = src.match(/export function resetStemSeparation\(\) \{[\s\S]*?\n\}/);
    expect(m).toBeTruthy();
    expect(m[0]).not.toMatch(/clearStemCache\s*\(/);
  });
});

describe('session-persist helpers exist', () => {
  test('exports persistAppSession and restoreAppSession', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'public/app/session-persist.js'),
      'utf8',
    );
    expect(src).toMatch(/export function persistAppSession/);
    expect(src).toMatch(/export function restoreAppSession/);
    expect(src).toMatch(/VIPSessionPersist/);
  });
});

describe('app.js library wiring', () => {
  test('imports FileLibrary and restores session', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(process.cwd(), 'public/app/app.js'),
      'utf8',
    );
    expect(src).toMatch(/from '\/src\/core\/FileLibrary\.js'/);
    expect(src).toMatch(/_restoreLibrarySession/);
    expect(src).toMatch(/openLibraryFile/);
    expect(src).toMatch(/persistAppSession/);
    expect(src).toMatch(/_stemFileSeq/);
  });
});
