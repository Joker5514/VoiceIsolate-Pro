/**
 * tests/vip020-forensic-inspector-ux.test.js
 *
 * VIP-020 — Forensic inspector and provenance UX:
 *  - Verifies pass, mismatch (manifest tamper, source byte mismatch, output byte mismatch),
 *    malformed metadata, missing sidecar, and unsupported schema classifications
 *  - Verifies EngineerProvenanceCoordinator source import hashing, chronological
 *    operation history (completed / cancelled / failed), deterministic dither seed,
 *    and sidecar generation
 *  - Verifies ForensicInspectorUI displays source/output SHA-256, verification status,
 *    model/version pins, manifest digest, processing parameters, operation history,
 *    timestamps, sidecar JSON, and mandatory non-certification disclaimer
 */
'use strict';

let PROVENANCE_VERDICT;
let PROVENANCE_NON_CERTIFICATION_DISCLAIMER;
let classifyProvenanceVerification;
let EngineerProvenanceCoordinator;
let deriveDitherSeedFromHash;
let renderForensicInspectorHtml;
let encodeWav;
let hashBlobSha256;

beforeAll(async () => {
  ({
    PROVENANCE_VERDICT,
    PROVENANCE_NON_CERTIFICATION_DISCLAIMER,
    classifyProvenanceVerification,
  } = await import('../src/core/Provenance.js'));
  ({
    EngineerProvenanceCoordinator,
    deriveDitherSeedFromHash,
  } = await import('../src/pipeline/EngineerProvenanceCoordinator.js'));
  ({ renderForensicInspectorHtml } = await import('../src/presentation/ForensicInspectorUI.js'));
  ({ encodeWav } = await import('../src/pipeline/ExportManager.js'));
  ({ hashBlobSha256 } = await import('../src/core/sha256.js'));
});

function makeSourceFile(text = 'source-audio-bytes-v1', name = 'interview.wav') {
  const blob = new Blob([text], { type: 'audio/wav' });
  Object.defineProperty(blob, 'name', { value: name });
  return blob;
}

describe('VIP-020 provenance verification classification', () => {
  test('missing sidecar returns missing_sidecar with actionable hint', async () => {
    for (const empty of [null, undefined, '']) {
      const res = await classifyProvenanceVerification(empty);
      expect(res.ok).toBe(false);
      expect(res.verdict).toBe(PROVENANCE_VERDICT.MISSING_SIDECAR);
      expect(res.action).toMatch(/export|choose/i);
    }
  });

  test('invalid JSON, legacy array audit logs, and incomplete records return malformed_metadata', async () => {
    const truncated = await classifyProvenanceVerification('{ "schema": "vip-provenance", ');
    expect(truncated.ok).toBe(false);
    expect(truncated.verdict).toBe(PROVENANCE_VERDICT.MALFORMED_METADATA);

    const legacyArray = await classifyProvenanceVerification(JSON.stringify([{ stage: 'S01', hash: 'abc', ts: 1 }]));
    expect(legacyArray.ok).toBe(false);
    expect(legacyArray.verdict).toBe(PROVENANCE_VERDICT.MALFORMED_METADATA);

    const noSchema = await classifyProvenanceVerification(JSON.stringify({ foo: 'bar' }));
    expect(noSchema.ok).toBe(false);
    expect(noSchema.verdict).toBe(PROVENANCE_VERDICT.MALFORMED_METADATA);

    const badDigest = await classifyProvenanceVerification(JSON.stringify({
      schema: 'vip-provenance',
      schemaVersion: 1,
      createdAt: '2026-11-03T00:00:00.000Z',
      export: { timestamp: '2026-11-03T00:00:00.000Z' },
      manifestDigest: 'not-a-sha256',
    }));
    expect(badDigest.ok).toBe(false);
    expect(badDigest.verdict).toBe(PROVENANCE_VERDICT.MALFORMED_METADATA);
  });

  test('unknown schema or future schemaVersion returns unsupported_schema', async () => {
    const wrongSchema = await classifyProvenanceVerification(JSON.stringify({
      schema: 'other-tool',
      schemaVersion: 1,
    }));
    expect(wrongSchema.ok).toBe(false);
    expect(wrongSchema.verdict).toBe(PROVENANCE_VERDICT.UNSUPPORTED_SCHEMA);

    const futureVer = await classifyProvenanceVerification(JSON.stringify({
      schema: 'vip-provenance',
      schemaVersion: 99,
    }));
    expect(futureVer.ok).toBe(false);
    expect(futureVer.verdict).toBe(PROVENANCE_VERDICT.UNSUPPORTED_SCHEMA);
  });
});

describe('VIP-020 EngineerProvenanceCoordinator & ForensicInspectorUI', () => {
  test('full session lifecycle: source hash -> ops (cancelled + completed) -> seeded export -> pass & tamper/mismatch detection', async () => {
    const coord = new EngineerProvenanceCoordinator({
      hashBlobFn: (blob) => hashBlobSha256(blob),
      fetchVersionFn: async () => '25.0.2',
    });

    const srcFile = makeSourceFile('raw-source-recording-pcm-bytes', 'evidence-clip.wav');
    const srcHash = await coord.recordSourceImport(srcFile);
    expect(srcHash).toMatch(/^[0-9a-f]{64}$/);

    // Record cancelled attempt followed by completed process
    coord.recordOperation({ id: 'process', status: 'cancelled', detail: 'User cancelled' });
    coord.recordOperation({ id: 'analyze', status: 'failed', detail: 'Worker timeout' });
    coord.recordProcessSnapshot({
      modelIds: ['bsrnn_vocals', 'rnnoise'],
      processingEngine: 'ml-worker',
      effectiveParams: { nrAmount: 65, ditherAmt: 1, outGain: -1.5 },
    });

    // Deterministic dither seed produces bit-identical WAV output on rerun
    const seed = coord.getDeterministicDitherSeed();
    expect(seed).toBe(deriveDitherSeedFromHash(srcHash));
    const pcm = [new Float32Array(480).fill(0.12345)];
    const wav1 = encodeWav(pcm, 48000, { ditherAmt: 1, ditherSeed: seed });
    const wav2 = encodeWav(pcm, 48000, { ditherAmt: 1, ditherSeed: seed });
    expect((await hashBlobSha256(wav1)).hex).toBe((await hashBlobSha256(wav2)).hex);

    const exported = await coord.recordExport({
      outputBlob: wav1,
      filename: 'evidence-clip-clean.wav',
      format: 'wav',
      sampleRate: 48000,
      channels: 1,
      region: { in: 0, out: 0.01 },
      ditherAmt: 1,
      ditherSeed: seed,
      effectiveParams: { nrAmount: 65, ditherAmt: 1, outGain: -1.5 },
      modelIds: ['bsrnn_vocals', 'rnnoise'],
    });

    expect(exported.sidecarFilename).toBe('evidence-clip-clean.viprovenance.json');
    expect(exported.record.source.sha256).toBe(srcHash);
    expect(exported.record.export.options.ditherSeed).toBe(seed);
    expect(exported.record.application.version).toBe('25.0.2');
    expect(exported.record.application.modelIds).toEqual(['bsrnn_vocals', 'rnnoise']);

    // 1. Live session verification passes all 4 checks
    const passRes = await coord.verifyCurrentSession();
    expect(passRes.ok).toBe(true);
    expect(passRes.verdict).toBe(PROVENANCE_VERDICT.VERIFIED);
    expect(passRes.partialByteVerification).toBe(false);
    expect(passRes.checks).toEqual({
      schema: 'passed',
      manifestDigest: 'passed',
      sourceSha256: 'passed',
      outputSha256: 'passed',
    });

    // 2. Render ForensicInspectorUI HTML and verify all required fields + honesty disclaimer
    const html = renderForensicInspectorHtml(coord.getState(), { paramsOpen: true, jsonOpen: true });
    expect(html).toContain('NOT legal certification');
    expect(html).toContain('NOT a cryptographic digital signature');
    expect(html).toContain(PROVENANCE_NON_CERTIFICATION_DISCLAIMER.slice(0, 40));
    expect(html).toContain(srcHash);
    expect(html).toContain(exported.record.export.output.sha256);
    expect(html).toContain(exported.record.manifestDigest);
    expect(html).toContain('bsrnn_vocals');
    expect(html).toContain('rnnoise');
    expect(html).toContain('cancelled');
    expect(html).toContain('failed');
    expect(html).toContain('data-verdict="verified"');

    // 3. External verification WITHOUT source/output files honestly marks partialByteVerification
    const sidecarOnly = await coord.verifyExternalSidecar({ sidecarText: exported.jsonText });
    expect(sidecarOnly.ok).toBe(true);
    expect(sidecarOnly.verdict).toBe(PROVENANCE_VERDICT.VERIFIED);
    expect(sidecarOnly.partialByteVerification).toBe(true);
    expect(sidecarOnly.checks.sourceSha256).toBe('unverified');
    expect(sidecarOnly.checks.outputSha256).toBe('unverified');

    // 4. Tampered parameter in JSON (without recomputing manifestDigest) -> MISMATCH
    const tamperedObj = JSON.parse(exported.jsonText);
    tamperedObj.processing.parameters.nrAmount = 0;
    const tamperRes = await coord.verifyExternalSidecar({
      sidecarText: JSON.stringify(tamperedObj),
      sourceBlob: srcFile,
      outputBlob: wav1,
    });
    expect(tamperRes.ok).toBe(false);
    expect(tamperRes.verdict).toBe(PROVENANCE_VERDICT.MISMATCH);
    expect(tamperRes.checks.manifestDigest).toBe('failed');

    // 5. Modified source file bytes -> MISMATCH on sourceSha256
    const wrongSrc = makeSourceFile('different-source-bytes', 'evidence-clip.wav');
    const srcMismatch = await coord.verifyExternalSidecar({
      sidecarText: exported.jsonText,
      sourceBlob: wrongSrc,
      outputBlob: wav1,
    });
    expect(srcMismatch.ok).toBe(false);
    expect(srcMismatch.verdict).toBe(PROVENANCE_VERDICT.MISMATCH);
    expect(srcMismatch.checks.sourceSha256).toBe('failed');
    expect(srcMismatch.checks.outputSha256).toBe('passed');

    // 6. Modified output WAV bytes -> MISMATCH on outputSha256
    const wrongOut = new Blob(['tampered-wav-bytes'], { type: 'audio/wav' });
    const outMismatch = await coord.verifyExternalSidecar({
      sidecarText: exported.jsonText,
      sourceBlob: srcFile,
      outputBlob: wrongOut,
    });
    expect(outMismatch.ok).toBe(false);
    expect(outMismatch.verdict).toBe(PROVENANCE_VERDICT.MISMATCH);
    expect(outMismatch.checks.sourceSha256).toBe('passed');
    expect(outMismatch.checks.outputSha256).toBe('failed');
  });
});
