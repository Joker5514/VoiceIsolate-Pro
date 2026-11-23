/**
 * Round 13 (#950 follow-up). Randy's live control (whisper only, no music)
 * still read "1 music-bed segment", "Hum / buzz (~60 Hz) 68%" (73% on the
 * mix), "Music / other residual 40% LOW" and "Hum (reconstructed) 30% LOW".
 * The current analyzer gives none of those for that file. They are exactly
 * what a durable analysis cached by a pre-#950 build produces when it is
 * restored now:
 *  - the cache record carries no analyzer version, so an old analysis
 *    (frame "hum" segments over 68% / 73% of the file) is restored forever;
 *  - compaction drops humProfile and confidenceScores, so the restored
 *    hum class falls back to "~60 Hz" with severity = hum coverage, and the
 *    audition layers fall back to their 0.4 / 0.3 placeholders.
 */
'use strict';

const mem = new Map();
const blobs = new Map();
const fakeStore = {};
const fakeDb = { transaction: () => ({ objectStore: () => fakeStore }) };

jest.unstable_mockModule('../src/core/storage/openIdb.js', () => ({
  openIdb: async () => fakeDb,
  idbGet: async (_s, key) => mem.get(key),
  idbPut: async (_s, val) => { mem.set(val.key, val); },
  idbDelete: async (_s, key) => { mem.delete(key); },
  idbTxDone: async () => {},
  idbTransaction: (db) => db.transaction(),
}));
jest.unstable_mockModule('../src/core/storage/BlobStore.js', () => ({
  writeSourceBlob: async (id, blob) => { blobs.set(id, blob); return { backend: 'mem', path: id }; },
  readSourceBlob: async (ref) => blobs.get(ref?.path) || null,
  deleteSourceBlob: async (ref) => { blobs.delete(ref?.path); },
}));

let Derived;
let classifyUnwantedSounds;
let ANALYZER_VERSION;

beforeAll(async () => {
  Derived = await import('../src/core/storage/DerivedCache.js');
  ({ classifyUnwantedSounds } = await import('../src/core/AnalyzerWhisperBridge.js'));
  ({ ANALYZER_VERSION } = await import('../src/core/FullAnalysis.js'));
});

beforeEach(() => { mem.clear(); blobs.clear(); });

/** A record exactly as a pre-#950 build stored it: compacted, no version. */
function writeOldBuildRecord(fileId) {
  const old = {
    duration: 30,
    sampleRate: 48000,
    recommendedPreset: 'Whisper Boost',
    speechSegments: [{ start: 0.5, end: 28 }],
    whisperRegions: [{ start: 1, end: 6 }],
    noiseSegments: [],
    musicSegments: [{ start: 23.16, end: 23.67, label: 'music' }],
    // Per-frame "hum" (wide low bins) over 68% of the file.
    humSegments: Array.from({ length: 17 }, (_, i) => ({ start: i * 1.76, end: i * 1.76 + 1.2, label: 'hum' })),
  };
  const key = Derived.analysisDurableKey(fileId);
  const path = `derived-${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  blobs.set(path, new Blob([JSON.stringify(old)], { type: 'application/json' }));
  mem.set(key, { key, kind: 'analysis', fileId, blobRef: { backend: 'mem', path }, createdAt: 1 });
  return old;
}

describe('durable analysis cache vs analyzer changes', () => {
  test('the stale record reproduces the live readout (why the cache must not restore it)', () => {
    const old = writeOldBuildRecord('f1');
    const hum = classifyUnwantedSounds(old).classes.hum;
    expect(hum.present).toBe(true);
    expect(hum.label).toBe('Hum / buzz (~60 Hz)');
    expect(Math.round(hum.severity * 100)).toBe(68);
  });

  test('a record from an older analyzer build is not restored', async () => {
    writeOldBuildRecord('f1');
    expect(await Derived.loadAnalysisDurable('f1')).toBeNull();
  });

  test('a record from this build round-trips with humProfile and confidenceScores', async () => {
    const analysis = {
      duration: 30,
      humProfile: { present: false, freq: 60, strength: 0 },
      confidenceScores: { musicRatio: 0, speechRatio: 0.6, snrDb: 6.1 },
      musicSegments: [],
      humSegments: [],
      speechSegments: [{ start: 0, end: 29 }],
      frameFeatures: new Float32Array(100),
    };
    await Derived.saveAnalysisDurable('f2', analysis);
    const back = await Derived.loadAnalysisDurable('f2');
    expect(back).not.toBeNull();
    expect(back.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(back.humProfile).toEqual({ present: false, freq: 60, strength: 0 });
    expect(back.confidenceScores.musicRatio).toBe(0);
    expect(back.frameFeatures).toBeUndefined();
    const u = classifyUnwantedSounds(back);
    expect(u.classes.hum.present).toBe(false);
    expect(u.classes.music.present).toBe(false);
  });
});

describe('audition layers only claim what analysis found', () => {
  function fakeBuf(sec = 1) {
    const n = 48000 * sec; const d = new Float32Array(n);
    return { duration: sec, sampleRate: 48000, numberOfChannels: 1, length: n, getChannelData: () => d };
  }
  test('no music bed and no hum -> the music and hum layers report 0, not 40% / 30%', async () => {
    const { SourceAuditionEngine } = await import('../src/pipeline/SourceAuditionEngine.js');
    const eng = new SourceAuditionEngine();
    eng.buildFromAnalysis({
      original: fakeBuf(), clean: fakeBuf(), noise: fakeBuf(),
      analysis: { humProfile: { present: false, freq: 60, strength: 0 }, confidenceScores: { musicRatio: 0 }, musicSegments: [] },
    }, null);
    const layers = Object.fromEntries([...eng.layers.values()].map((l) => [l.id, l]));
    expect(layers.music.confidence).toBe(0);
    expect(layers.hum.confidence).toBe(0);
  });
  test('restored analysis without scores (older cache) also reports 0, not placeholders', async () => {
    const { SourceAuditionEngine } = await import('../src/pipeline/SourceAuditionEngine.js');
    const eng = new SourceAuditionEngine();
    eng.buildFromAnalysis({ original: fakeBuf(), clean: fakeBuf(), noise: fakeBuf(), analysis: { musicSegments: [] } }, null);
    const layers = Object.fromEntries([...eng.layers.values()].map((l) => [l.id, l]));
    expect(layers.music.confidence).toBe(0);
    expect(layers.hum.confidence).toBe(0);
  });
  test('a detected music bed and hum keep their measured confidences', async () => {
    const { SourceAuditionEngine } = await import('../src/pipeline/SourceAuditionEngine.js');
    const eng = new SourceAuditionEngine();
    eng.buildFromAnalysis({
      original: fakeBuf(), clean: fakeBuf(), noise: fakeBuf(),
      analysis: { humProfile: { present: true, freq: 60, strength: 0.9 }, confidenceScores: { musicRatio: 0.5 }, musicSegments: [{ start: 0, end: 1 }] },
    }, null);
    const layers = Object.fromEntries([...eng.layers.values()].map((l) => [l.id, l]));
    expect(layers.music.confidence).toBe(0.5);
    expect(layers.hum.confidence).toBe(0.9);
    expect(layers.hum.quality).toBe('medium');
  });
});
