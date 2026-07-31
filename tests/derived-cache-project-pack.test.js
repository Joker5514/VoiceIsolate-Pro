/**
 * Durable stem pack codec + project pack binary round-trip (no real IDB).
 */
'use strict';

describe('DerivedCache codec', () => {
  /** @type {typeof import('../src/core/storage/DerivedCache.js')} */
  let Derived;

  beforeAll(async () => {
    Derived = await import('../src/core/storage/DerivedCache.js');
  });

  test('encode/decode stem pack round-trips mono stems', () => {
    const clean = [new Float32Array([0.1, -0.2, 0.3, 0.0])];
    const noise = [new Float32Array([0.01, 0.02, -0.01, 0.0])];
    const ab = Derived.encodeStemPack({ clean, noise, sampleRate: 48000 });
    const out = Derived.decodeStemPack(ab);
    expect(out).toBeTruthy();
    expect(out.sampleRate).toBe(48000);
    expect(out.clean).toHaveLength(1);
    expect(out.noise).toHaveLength(1);
    expect(Array.from(out.clean[0])).toEqual(Array.from(clean[0]));
    expect(Array.from(out.noise[0])).toEqual(Array.from(noise[0]));
  });

  test('stemDurableKey is stable for model chain', () => {
    expect(Derived.stemDurableKey('abc', ['bsrnn_vocals', 'rnnoise']))
      .toBe('stems:abc:bsrnn_vocals→rnnoise');
    expect(Derived.analysisDurableKey('abc')).toBe('analysis:abc');
  });

  test('decodeStemPack rejects garbage', () => {
    expect(Derived.decodeStemPack(new ArrayBuffer(4))).toBeNull();
  });

  test('canPersistStems rejects oversized packs', () => {
    const huge = new Float32Array(48000 * 200); // > 180s limit
    expect(Derived.canPersistStems({
      clean: [huge],
      noise: [huge],
      sampleRate: 48000,
    })).toBe(false);
  });

  test('compactAnalysisForStorage drops bulk fields', () => {
    const compact = Derived.compactAnalysisForStorage({
      duration: 12,
      speechSegments: [{ start: 0, end: 1 }],
      frameFeatures: new Float32Array(10000),
      recommendedPreset: 'Voice Clarity',
    });
    expect(compact.duration).toBe(12);
    expect(compact.speechSegments).toHaveLength(1);
    expect(compact.frameFeatures).toBeUndefined();
    expect(compact.recommendedPreset).toBe('Voice Clarity');
  });
});

describe('ProjectPack binary', () => {
  test('build/parse round-trip', async () => {
    const { buildPackBlob, parseProjectPack } = await import('../src/core/ProjectPack.js');
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = buildPackBlob(
      {
        format: 'vippack',
        version: 1,
        project: { name: 'Demo', description: '', savedParams: {}, activePreset: null, sourceFileIds: ['f1'] },
        files: [{ id: 'f1', originalFilename: 'a.wav', mimeType: 'audio/wav', size: 5, path: 'sources/f1/a.wav' }],
      },
      [{ name: 'sources/f1/a.wav', data }],
    );
    const ab = await blob.arrayBuffer();
    const { manifest, files } = await parseProjectPack(ab);
    expect(manifest.project.name).toBe('Demo');
    expect(files.get('sources/f1/a.wav')).toBeTruthy();
    expect(Array.from(files.get('sources/f1/a.wav'))).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('model IDB schema constants', () => {
  test('ModelIdbSchema exports v3 key-value', async () => {
    const mod = await import('../src/core/storage/ModelIdbSchema.js');
    expect(mod.MODEL_IDB_NAME).toBe('vip-model-cache');
    expect(mod.MODEL_IDB_VERSION).toBe(3);
    expect(mod.MODEL_IDB_STORE).toBe('models');
  });

  test('MLWorker and fetch-cache use version 3', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const ml = fs.readFileSync(path.join(process.cwd(), 'src/workers/MLWorker.js'), 'utf8');
    const fc = fs.readFileSync(path.join(process.cwd(), 'public/app/ml-worker-fetch-cache.js'), 'utf8');
    expect(ml).toMatch(/IDB_VERSION\s*=\s*3/);
    expect(fc).toMatch(/VIP_IDB_VERSION\s*=\s*3/);
  });
});
