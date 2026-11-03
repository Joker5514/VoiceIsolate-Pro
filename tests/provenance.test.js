/**
 * tests/provenance.test.js — VIP-010 / VIP-040 export provenance sidecar:
 * schema, mandatory-vs-null field policy (never fabricate), canonical
 * digest, tamper/missing-field/unsupported-schema/output-mismatch detection,
 * and the honest distinction between integrity record and signed evidence.
 */
'use strict';

let prov;

beforeAll(async () => {
  prov = await import('../src/core/Provenance.js');
});

function minimalRecord() {
  return prov.buildProvenanceRecord({
    source: { name: 'in.wav', sizeBytes: 1234, mimeType: 'audio/wav', sha256: 'a'.repeat(64) },
    export: {
      format: 'wav',
      options: { ditherMode: 2, ditherSeed: 424242, sampleRate: 48000, bitDepth: 16 },
      output: { filename: 'out.wav', sizeBytes: 999, sha256: 'b'.repeat(64) },
    },
    application: {
      version: '25.0.2',
      inferenceRevision: 'ir3-mains-hum-notch',
      modelChainRevision: 'rev-x',
      modelIds: ['bsrnn_vocals'],
      models: [{ id: 'bsrnn_vocals', sha256: 'c'.repeat(64) }],
    },
    processing: {
      parameters: { voiceIso: 42, nrAmount: 10 },
      operations: [
        { id: 'separate', status: 'completed' },
        { id: 'enhance', status: 'cancelled', detail: 'user cancelled' },
      ],
    },
    createdAt: '2026-11-02T12:00:00.000Z',
  });
}

describe('buildProvenanceRecord', () => {
  test('mandatory fields are present and the manifest digest is computed', () => {
    const r = minimalRecord();
    expect(r.schema).toBe('vip-provenance');
    expect(r.schemaVersion).toBe(1);
    expect(r.createdAt).toBe('2026-11-02T12:00:00.000Z');
    expect(r.export.timestamp).toBeTruthy();
    expect(r.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('unavailable values are explicit nulls — never fabricated', () => {
    const r = prov.buildProvenanceRecord({});
    expect(r.source).toBeNull();
    expect(r.export.output).toBeNull();
    expect(r.application).toBeNull();
    expect(r.processing).toBeNull();
    // output sha missing but shape preserved when output object exists
    const r2 = prov.buildProvenanceRecord({ export: { output: { filename: 'x.wav' } } });
    expect(r2.export.output.sha256).toBeNull();
    expect(r2.export.output.sizeBytes).toBeNull();
    // malformed hashes degrade to null, not to a fake digest
    const r3 = prov.buildProvenanceRecord({ source: { sha256: 'nope' } });
    expect(r3.source.sha256).toBeNull();
  });

  test('operation history keeps order and status vocabulary', () => {
    const r = minimalRecord();
    expect(r.processing.operations.map((o) => o.status)).toEqual(['completed', 'cancelled']);
    expect(r.export.options).toMatchObject({ ditherMode: 2, ditherSeed: 424242 });
  });
});

describe('canonicalJson + manifest digest', () => {
  test('key order does not change the digest (deterministic)', () => {
    const a = prov.canonicalJson({ b: 1, a: { d: 2, c: 3 } });
    const b = prov.canonicalJson({ a: { c: 3, d: 2 }, b: 1 });
    expect(a).toBe(b);
  });

  test('array order DOES matter (chronological operation history)', () => {
    expect(prov.canonicalJson([1, 2])).not.toBe(prov.canonicalJson([2, 1]));
  });

  test('digest is stable across rebuilds of identical inputs', () => {
    expect(minimalRecord().manifestDigest).toBe(minimalRecord().manifestDigest);
  });
});

describe('verifyProvenanceRecord', () => {
  const hashFn = async (blob) => {
    const { sha256Hex } = await import('../src/core/sha256.js');
    const buf = new Uint8Array(await blob.arrayBuffer());
    return sha256Hex(buf);
  };

  test('an untampered record verifies (digest + hashes)', async () => {
    const outBytes = new Uint8Array([9, 9, 9]);
    const { sha256Hex } = await import('../src/core/sha256.js');
    const outHash = sha256Hex(outBytes);
    const r = prov.buildProvenanceRecord({
      export: { output: { filename: 'o.wav', sizeBytes: 3, sha256: outHash } },
    });
    const v = await prov.verifyProvenanceRecord(r, { outputBlob: new Blob([outBytes]), hashFn });
    expect(v.ok).toBe(true);
    expect(v.checks.manifestDigest).toBe('passed');
    expect(v.checks.outputSha256).toBe('passed');
  });

  test('any content edit without a recomputed digest fails verification', async () => {
    const r = minimalRecord();
    const tampered = { ...r, processing: { ...r.processing, parameters: { voiceIso: 99 } } };
    const v = await prov.verifyProvenanceRecord(tampered);
    expect(v.ok).toBe(false);
    expect(v.checks.manifestDigest).toBe('failed');
    expect(v.failures.join(' ')).toMatch(/modified|corrupt/);
  });

  test('output bytes that do not match the recorded hash fail', async () => {
    const r = minimalRecord(); // output sha = 'b'*.repeat(64)
    const v = await prov.verifyProvenanceRecord(r, {
      outputBlob: new Blob([new Uint8Array([1])]),
      hashFn,
    });
    expect(v.ok).toBe(false);
    expect(v.checks.outputSha256).toBe('failed');
    expect(v.failures.join(' ')).toMatch(/output bytes/);
  });

  test('unsupported schema versions fail clearly', async () => {
    const r = minimalRecord();
    const future = { ...r, schemaVersion: 99, manifestDigest: prov.provenanceManifestDigest({ ...r, schemaVersion: 99 }) };
    const v = await prov.verifyProvenanceRecord(future);
    expect(v.ok).toBe(false);
    expect(v.checks.schema).toBe('failed');
    expect(v.failures.join(' ')).toMatch(/unsupported schema/);
  });

  test('missing mandatory integrity fields fail', async () => {
    const v = await prov.verifyProvenanceRecord({});
    expect(v.ok).toBe(false);
  });

  test('hashes never measured are reported "unverified", not "passed"', async () => {
    const r = prov.buildProvenanceRecord({
      export: { output: { filename: 'o.wav' } }, // sha256 null at export time
    });
    const v = await prov.verifyProvenanceRecord(r, {
      outputBlob: new Blob([new Uint8Array([1])]),
      hashFn,
    });
    expect(v.checks.outputSha256).toBe('unverified');
    expect(v.ok).toBe(true); // nothing contradicts the record
  });

  test('without evidence blobs the byte checks stay unverified', async () => {
    const v = await prov.verifyProvenanceRecord(minimalRecord());
    expect(v.checks.outputSha256).toBe('unverified');
    expect(v.checks.sourceSha256).toBe('unverified');
    expect(v.checks.manifestDigest).toBe('passed');
  });

  test('the record never claims to be a signature (honesty contract)', () => {
    const r = minimalRecord();
    expect(JSON.stringify(r)).not.toMatch(/signature|certif|chain of custody/i);
    expect(r.digestAlgorithm).toBe('sha256');
  });
});

describe('provenanceFilenameFor', () => {
  test('maps export names to the sidecar name', () => {
    expect(prov.provenanceFilenameFor('clean-voice.wav')).toBe('clean-voice.viprovenance.json');
    expect(prov.provenanceFilenameFor('export')).toBe('export.viprovenance.json');
    expect(prov.provenanceFilenameFor(null)).toBe('export.viprovenance.json');
  });
});

describe('deterministic export (VIP-040)', () => {
  let encodeWav;
  beforeAll(async () => {
    ({ encodeWav } = await import('../src/pipeline/ExportManager.js'));
  });

  function tone(n = 4096) {
    const ch = new Float32Array(n);
    for (let i = 0; i < n; i++) ch[i] = 0.3 * Math.sin(i / 17);
    return [ch];
  }

  async function bytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  test('a seeded dither export is bit-reproducible (same seed, same bytes)', async () => {
    const a = await bytes(encodeWav(tone(), 48_000, { ditherAmt: 2, ditherSeed: 424242 }));
    const b = await bytes(encodeWav(tone(), 48_000, { ditherAmt: 2, ditherSeed: 424242 }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test('different seeds produce different dithered bytes', async () => {
    const a = await bytes(encodeWav(tone(), 48_000, { ditherAmt: 2, ditherSeed: 1 }));
    const b = await bytes(encodeWav(tone(), 48_000, { ditherAmt: 2, ditherSeed: 2 }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test('dither off is always deterministic (no seed needed)', async () => {
    const a = await bytes(encodeWav(tone(), 48_000, { ditherAmt: 0 }));
    const b = await bytes(encodeWav(tone(), 48_000, { ditherAmt: 0 }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  test('unseeded dither stays random TPDF (documented non-reproducible path)', async () => {
    // Statistical smoke: with 4096 samples the odds of two independent random
    // dithered encodes being byte-identical are negligible.
    const a = await bytes(encodeWav(tone(), 48_000, { ditherAmt: 1 }));
    const b = await bytes(encodeWav(tone(), 48_000, { ditherAmt: 1 }));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

describe('Landing export wiring (regression pin)', () => {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.resolve(__dirname, '..');

  test('landing export downloads the .viprovenance.json sidecar and hashes in a worker-hosted path', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'landing.js'), 'utf8');
    expect(src).toMatch(/provenanceFilenameFor\(result\.filename\)/);
    expect(src).toMatch(/hashSourceBlob\(result\.blob/);
    expect(src).toMatch(/hashSourceBlob\(sourceFile/);
    expect(src).toMatch(/buildProvenanceRecord\(/);
  });

  test('the sidecar for a video export records the mp4 format honestly', () => {
    const src = fs.readFileSync(path.join(ROOT, 'public', 'landing.js'), 'utf8');
    expect(src).toMatch(/result\.filename\.endsWith\('\.mp4'\) \? 'mp4' : 'wav'/);
  });
});
