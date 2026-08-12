/**
 * Clear Local Data unit tests (Node — mocks indexedDB / storage).
 */
'use strict';

describe('ClearLocalData', () => {
  let cld;

  beforeAll(async () => {
    // Minimal browser shims
    global.indexedDB = {
      deleteDatabase(name) {
        const req = {
          onsuccess: null,
          onerror: null,
          onblocked: null,
        };
        setTimeout(() => {
          if (typeof req.onsuccess === 'function') req.onsuccess();
        }, 0);
        return req;
      },
    };
    const store = new Map();
    const makeStorage = () => ({
      get length() { return store.size; },
      key(i) { return [...store.keys()][i] ?? null; },
      getItem(k) { return store.has(k) ? store.get(k) : null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); },
      clear() { store.clear(); },
    });
    global.localStorage = makeStorage();
    global.sessionStorage = makeStorage();
    global.localStorage.setItem('vip-workflow-tier', 'studio');
    global.localStorage.setItem('unrelated-key', 'keep');
    global.localStorage.setItem('VIP_SAM3_ENABLED', '0');

    cld = await import('../src/core/ClearLocalData.js');
  });

  test('exports IDB names including model cache', () => {
    expect(cld.VIP_IDB_NAMES).toContain('vip-file-library');
    expect(cld.VIP_IDB_NAMES).toContain('vip-model-cache');
    expect(cld.VIP_IDB_NAMES).toContain('vip-derived-cache');
  });

  test('clearVipLocalStorage removes vip-prefixed keys only', () => {
    const n = cld.clearVipLocalStorage(global.localStorage);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(global.localStorage.getItem('unrelated-key')).toBe('keep');
    expect(global.localStorage.getItem('vip-workflow-tier')).toBeNull();
  });

  test('deleteIdbDatabase resolves ok', async () => {
    const r = await cld.deleteIdbDatabase('vip-test-db');
    expect(r.ok).toBe(true);
    expect(r.name).toBe('vip-test-db');
  });

  test('clearAllLocalData returns summary shape', async () => {
    const result = await cld.clearAllLocalData({ includeModels: true });
    expect(result).toHaveProperty('filesRemoved');
    expect(result).toHaveProperty('idb');
    expect(Array.isArray(result.idb)).toBe(true);
    expect(result.idb.length).toBeGreaterThan(0);
    expect(result).toHaveProperty('opfs');
    expect(result).toHaveProperty('cacheVersion');
  });
});
