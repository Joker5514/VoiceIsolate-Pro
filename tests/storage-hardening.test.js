/**
 * Phase 3 storage findings (audit 2026-10-12): Clear Local Data coverage (S1),
 * Remove-from-library lifecycle (S2), .vippack validation (S3), track-cap
 * eviction vs projects (S4) and the OPFS write fallback (S5). Runs the real
 * modules over an in-memory IndexedDB and a fake OPFS.
 */
'use strict';

const { installMemoryIdb } = require('./helpers/memory-idb.js');

installMemoryIdb();

// ── Fake OPFS: nested directories; writes to names matching `failWrites` throw.
let failWrites = null;
class FakeFileHandle {
  constructor(name) { this.kind = 'file'; this.name = name; this.blob = new Blob([]); }
  async createWritable() {
    const chunks = [];
    const self = this;
    return {
      async write(d) {
        if (failWrites && failWrites.test(self.name)) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
        chunks.push(d);
      },
      async close() { self.blob = new Blob(chunks); },
      async abort() {},
    };
  }
  async getFile() { return new File([this.blob], this.name); }
}
class FakeDir {
  constructor() { this.kind = 'directory'; this.map = new Map(); }
  async getDirectoryHandle(name, { create } = {}) {
    if (!this.map.has(name)) {
      if (!create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      this.map.set(name, new FakeDir());
    }
    return this.map.get(name);
  }
  async getFileHandle(name, { create } = {}) {
    if (!this.map.has(name)) {
      if (!create) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      this.map.set(name, new FakeFileHandle(name));
    }
    return this.map.get(name);
  }
  async removeEntry(name) {
    if (!this.map.delete(name)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
  }
  async *entries() { yield* this.map.entries(); }
}
const opfsRoot = new FakeDir();
globalThis.FileSystemFileHandle = FakeFileHandle;
globalThis.navigator.storage = { getDirectory: async () => opfsRoot };

let FileLibrary;
let ProjectStore;
let ProjectPack;
let BlobStore;
let Opfs;
let Clear;

beforeAll(async () => {
  FileLibrary = await import('../src/core/FileLibrary.js');
  ProjectStore = await import('../src/core/ProjectStore.js');
  ProjectPack = await import('../src/core/ProjectPack.js');
  BlobStore = await import('../src/core/storage/BlobStore.js');
  Opfs = await import('../src/core/storage/OpfsBackend.js');
  Clear = await import('../src/core/ClearLocalData.js');
});

const wav = (seed, n = 2048) => new File([Uint8Array.from({ length: n }, (_, i) => (i * seed) & 255)], `t${seed}.wav`, { type: 'audio/wav' });
const libDir = () => opfsRoot.map.get('library');

describe('S5 — OPFS is used only when it can write, and a failed write falls back to IndexedDB', () => {
  test('getDirectory without createWritable (Safari 15.2-18) is not OPFS', async () => {
    const saved = FakeFileHandle.prototype.createWritable;
    delete FakeFileHandle.prototype.createWritable;
    try {
      expect(await Opfs.isOpfsAvailable()).toBe(false);
    } finally {
      FakeFileHandle.prototype.createWritable = saved;
    }
    expect(await Opfs.isOpfsAvailable()).toBe(true);
  });

  test('a failed OPFS write leaves no empty file and the blob lands in IndexedDB', async () => {
    expect(await BlobStore.resolveBlobBackend()).toBe('opfs');
    failWrites = /^fallback-1\.bin$/;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ref = await BlobStore.writeSourceBlob('fallback-1', new Blob([new Uint8Array([1, 2, 3])]));
      expect(ref.backend).toBe('idb');
      expect(libDir().map.has('fallback-1.bin')).toBe(false);
      const back = new Uint8Array(await (await BlobStore.readSourceBlob(ref)).arrayBuffer());
      expect([...back]).toEqual([1, 2, 3]);
    } finally {
      failWrites = null;
      warn.mockRestore();
    }
    const ok = await BlobStore.writeSourceBlob('fine-1', new Blob([new Uint8Array([9])]));
    expect(ok.backend).toBe('opfs');
  });
});

describe('S2 — Remove from library', () => {
  test('clears the active session, is not restored on boot, and a re-import revives the row', async () => {
    const m = await FileLibrary.importFile(wav(3), { mode: 'library' });
    expect((await FileLibrary.getSessionState()).activeFileId).toBe(m.id);
    await FileLibrary.removeFromLibrary(m.id);
    expect((await FileLibrary.getSessionState()).activeFileId).toBeNull();
    const boot = await FileLibrary.restoreSessionBootstrap();
    expect(boot.activeMeta?.id).not.toBe(m.id);
    const blobsBefore = libDir().map.size;
    const again = await FileLibrary.importFile(wav(3), { mode: 'library' });
    expect(again.id).toBe(m.id);
    expect(again.inLibrary).toBe(true);
    expect(libDir().map.size).toBe(blobsBefore);
  });
});

describe('S4 — the track cap never evicts project sources and evicts removed rows first', () => {
  test('a 6-source pack keeps all six sources, and re-export carries all six', async () => {
    const entries = [];
    const files = [];
    for (let i = 0; i < 6; i++) {
      const path = `sources/x${i}/a${i}.wav`;
      const data = new Uint8Array(await wav(10 + i).arrayBuffer());
      entries.push({ name: path, data });
      files.push({ path, originalFilename: `a${i}.wav`, mimeType: 'audio/wav' });
    }
    const pack = ProjectPack.buildPackBlob({ format: 'vippack', version: 1, project: { name: 'Six' }, files }, entries);
    const { projectId, fileIds } = await ProjectPack.importProjectPack(pack);
    for (const id of fileIds) expect(await FileLibrary.getFileMeta(id)).not.toBeNull();
    const out = await ProjectPack.parseProjectPack(await ProjectPack.exportProjectPack(projectId));
    expect(out.manifest.files).toHaveLength(6);
  });

  test('export refuses to drop a missing source silently', async () => {
    const p = await ProjectStore.createProject({ name: 'Gap' });
    const m = await FileLibrary.importFile(wav(40), { mode: 'project', projectId: p.projectId });
    await ProjectStore.linkSourceFile(p.projectId, m.id);
    await ProjectStore.linkSourceFile(p.projectId, 'gone-id');
    await expect(ProjectPack.exportProjectPack(p.projectId)).rejects.toMatchObject({ code: 'MISSING_SOURCES', missing: ['gone-id'] });
    const partial = await ProjectPack.parseProjectPack(await ProjectPack.exportProjectPack(p.projectId, { allowMissing: true }));
    expect(partial.manifest.files).toHaveLength(1);
  });

  test('removed rows are evicted before listed library rows', async () => {
    const removed = await FileLibrary.importFile(wav(50), { mode: 'library' });
    await FileLibrary.removeFromLibrary(removed.id);
    const listed = await FileLibrary.importFile(wav(51), { mode: 'library' });
    for (let i = 0; i < 6; i++) await FileLibrary.importFile(wav(60 + i), { mode: 'library' });
    expect(await FileLibrary.getFileMeta(removed.id)).toBeNull();
    // Project sources from the tests above are untouched by the cap.
    const projectRows = (await FileLibrary.listLibraryFiles()).filter((f) => f.projectId);
    expect(projectRows.length).toBeGreaterThanOrEqual(7);
    expect(listed).toBeTruthy();
  });
});

describe('S3 — untrusted .vippack manifests', () => {
  const entry = (path) => ({ name: path, data: new Uint8Array([1, 2, 3, 4]) });
  const packOf = (manifest, entries) => ProjectPack.buildPackBlob({ format: 'vippack', version: 1, ...manifest }, entries);

  test.each([
    ['files is not an array', { project: { name: 'p' }, files: { 0: {} } }, []],
    ['a null file entry', { project: { name: 'p' }, files: [null] }, []],
    ['a non-string path', { project: { name: 'p' }, files: [{ path: 7 }] }, []],
    ['an entry without data', { project: { name: 'p' }, files: [{ path: 'sources/a' }] }, []],
    ['savedParams is an array', { project: { name: 'p', savedParams: [1] }, files: [] }, []],
  ])('%s is refused before anything is written', async (_n, manifest, entries) => {
    const before = (await ProjectStore.listProjects()).length;
    await expect(ProjectPack.importProjectPack(packOf(manifest, entries))).rejects.toThrow(/invalid manifest|missing entry/);
    expect((await ProjectStore.listProjects()).length).toBe(before);
  });

  test('wrong-typed metadata is dropped, not stored', async () => {
    const pack = packOf({
      project: { name: { evil: 1 }, savedParams: { gain: 3, bad: 'x' } },
      files: [{ path: 'sources/a', duration: '12', sampleRate: {}, channels: true, tags: ['ok', 5] }],
    }, [entry('sources/a')]);
    const { projectId, fileIds } = await ProjectPack.importProjectPack(pack);
    const meta = await FileLibrary.getFileMeta(fileIds[0]);
    expect(meta.duration).toBeNull();
    expect(meta.sampleRate).toBeNull();
    expect(meta.channels).toBeNull();
    expect(meta.tags).toEqual(['ok']);
    const proj = await ProjectStore.getProject(projectId);
    expect(proj.name).toBe('Imported project');
    expect(proj.savedParams).toEqual({ gain: 3 });
  });
});

describe('S1 — Clear Local Data', () => {
  test('lists the project and legacy speaker databases', () => {
    expect(Clear.VIP_IDB_NAMES).toEqual(expect.arrayContaining(['vip-projects', 'VoiceIsolateProDB']));
  });

  test('removes OPFS library/ (sources, removed rows, stem packs) and reports a blocked delete', async () => {
    const m = await FileLibrary.importFile(wav(90), { mode: 'library' });
    await FileLibrary.removeFromLibrary(m.id);
    expect(libDir().map.size).toBeGreaterThan(0);
    globalThis.indexedDB.deleteDatabase = (name) => {
      const req = {};
      setTimeout(() => (name === 'vip-projects' ? req.onblocked?.() : req.onsuccess?.()), 0);
      return req;
    };
    const result = await Clear.clearAllLocalData({ includeModels: true });
    expect(opfsRoot.map.has('library')).toBe(false);
    expect(result.complete).toBe(false);
    expect(result.failures).toEqual([expect.stringMatching(/^vip-projects: blocked/)]);
  });
});
