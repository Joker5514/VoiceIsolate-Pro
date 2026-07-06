/**
 * DesktopModelCache + ModelCacheBridge tests
 */
'use strict';

let modelCacheKey;
let modelCacheRelativePath;
let readModelCacheBytes;
let writeModelCacheBytes;
let attachMLWorkerModelCache;

beforeAll(async () => {
  const cache = await import('../src/core/DesktopModelCache.js');
  modelCacheKey = cache.modelCacheKey;
  modelCacheRelativePath = cache.modelCacheRelativePath;
  readModelCacheBytes = cache.readModelCacheBytes;
  writeModelCacheBytes = cache.writeModelCacheBytes;

  const bridge = await import('../src/core/ModelCacheBridge.js');
  attachMLWorkerModelCache = bridge.attachMLWorkerModelCache;
});

describe('DesktopModelCache', () => {
  const originalVip = globalThis.vipDesktop;
  const originalIdb = globalThis.indexedDB;

  afterEach(() => {
    if (originalVip === undefined) delete globalThis.vipDesktop;
    else globalThis.vipDesktop = originalVip;
    if (originalIdb === undefined) delete globalThis.indexedDB;
    else globalThis.indexedDB = originalIdb;
  });

  test('modelCacheKey includes id and hash', () => {
    expect(modelCacheKey({ id: 'demucs', sha256: 'abc123' })).toBe('demucs:abc123');
    expect(modelCacheKey({ id: 'vad', sha256: null })).toBe('vad:unpinned');
  });

  test('modelCacheRelativePath sanitizes key', () => {
    expect(modelCacheRelativePath('demucs:abc')).toBe('demucs_abc.onnx');
  });

  test('readModelCacheBytes prefers filesystem on desktop', async () => {
    const buffer = new ArrayBuffer(4);
    const readModelCache = jest.fn(async () => buffer);
    globalThis.vipDesktop = {
      openFile: async () => ({ canceled: true }),
      readModelCache,
      writeModelCache: jest.fn(),
    };
    const result = await readModelCacheBytes('demucs:abc');
    expect(result).toBe(buffer);
    expect(readModelCache).toHaveBeenCalledWith('demucs_abc.onnx');
  });

  test('writeModelCacheBytes writes to desktop filesystem', async () => {
    globalThis.vipDesktop = {
      openFile: async () => ({ canceled: true }),
      readModelCache: async () => null,
      writeModelCache: jest.fn(async () => ({ ok: true, bytes: 8 })),
    };
    delete globalThis.indexedDB;

    const bytes = new ArrayBuffer(8);
    const result = await writeModelCacheBytes('rnnoise:hash', bytes);
    expect(result.ok).toBe(true);
    expect(globalThis.vipDesktop.writeModelCache).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'rnnoise_hash.onnx' }),
    );
  });
});

describe('ModelCacheBridge', () => {
  test('proxies cache-request get to worker', async () => {
    const listeners = [];
    const worker = {
      addEventListener: (type, fn) => listeners.push(fn),
      removeEventListener: () => {},
      postMessage: jest.fn(),
    };

    globalThis.vipDesktop = {
      openFile: async () => ({ canceled: true }),
      readModelCache: async () => new ArrayBuffer(16),
      writeModelCache: async () => ({ ok: true, bytes: 0 }),
    };

    attachMLWorkerModelCache(worker);

    const handler = listeners[0];
    await handler({ data: { type: 'cache-request', requestId: 1, op: 'get', key: 'vad:abc' } });

    expect(worker.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cache-response', requestId: 1, ok: true }),
      expect.any(Array),
    );
  });
});