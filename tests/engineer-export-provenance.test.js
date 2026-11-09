/**
 * Engineer processed exports must carry the same integrity sidecar Landing
 * already writes. The record is a hash check, not a certification.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const analysis = fs.readFileSync(path.join(ROOT, 'public/app/lib/analysis-workspace.js'), 'utf8');

describe('Engineer export provenance wiring', () => {
  test('processed WAV, video remux, and Drive save each attach a sidecar before the audio leaves', () => {
    const download = app.slice(app.indexOf('async _downloadProcessed()'), app.indexOf('/** @deprecated Use decodeBlobToAudioBuffer'));
    expect(download.match(/_attachExportProvenance\(/g).length).toBe(2);
    expect(download.indexOf('_attachExportProvenance(')).toBeLessThan(download.indexOf('triggerBlobDownload(result.blob'));
    expect(download.lastIndexOf('_attachExportProvenance(')).toBeLessThan(download.lastIndexOf('triggerBlobDownload(blob, filename)'));
    const videoDownload = download.indexOf('triggerBlobDownload(result.blob, result.filename)');
    const wavDownload = download.indexOf('triggerBlobDownload(blob, filename)');
    expect(download.indexOf('sidecar.flush()', videoDownload)).toBeGreaterThan(videoDownload);
    expect(download.indexOf('sidecar.flush()', wavDownload)).toBeGreaterThan(wavDownload);
    const drive = app.slice(app.indexOf('async _saveProcessedToGoogleDrive()'), app.indexOf('async _downloadProcessed()'));
    expect(drive).toContain('_attachExportProvenance(');
    expect(drive.indexOf('_attachExportProvenance(')).toBeLessThan(drive.indexOf('saveBlobToDrive('));
    expect(analysis).toContain('publishExportProvenance(');
  });

  test('the sidecar does not claim an ML chain for the DSP fallback', () => {
    const helper = app.slice(app.indexOf('_exportModelIds()'), app.indexOf('async _attachExportProvenance'));
    expect(helper).toContain("this._processingEngine === 'ml'");
    expect(helper).not.toContain('bsrnn_vocals');
  });
});

describe('publishExportProvenance', () => {
  let publishExportProvenance;
  let verifyProvenanceRecord;
  let hashBlobSha256;

  beforeAll(async () => {
    ({ publishExportProvenance } = await import('../src/pipeline/export-provenance.js'));
    ({ verifyProvenanceRecord } = await import('../src/core/Provenance.js'));
    ({ hashBlobSha256 } = await import('../src/core/sha256.js'));
  });

  test('writes a verifiable sidecar and leaves an unmeasured source as null', async () => {
    const output = new Blob(['processed-pcm']);
    const delivered = [];
    const result = await publishExportProvenance({
      outputBlob: output,
      filename: 'processed-1.wav',
      format: 'wav',
      sourceFile: null,
      options: { ditherAmt: 0, ditherSeed: null, sampleRate: 48000 },
      parameters: { nrAmount: 12 },
      modelIds: [],
      operations: [{ id: 'dsp-fallback', status: 'completed', detail: 'classical' }],
      appVersion: '25.0.2',
      deliver: (blob, name) => delivered.push({ blob, name }),
    });
    expect(result.ok).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].name).toBe('processed-1.viprovenance.json');
    const record = JSON.parse(await delivered[0].blob.text());
    expect(record.source).toBeNull();
    expect(record.application.modelIds).toEqual([]);
    expect(record.application.modelChainRevision).toBeNull();
    expect(record.processing.parameters.nrAmount).toBe(12);
    expect(record.processing.operations[0].id).toBe('dsp-fallback');
    const check = await verifyProvenanceRecord(record, {
      outputBlob: output,
      hashFn: async (blob) => (await hashBlobSha256(blob)).hex,
    });
    expect(check.ok).toBe(true);
    expect(check.checks.outputSha256).toBe('passed');
    expect(check.checks.sourceSha256).toBe('unverified');
  });

  test('hashes the original file when it is still on hand', async () => {
    const output = new Blob(['out']);
    const source = new File(['original-bytes'], 'room.wav', { type: 'audio/wav' });
    const result = await publishExportProvenance({
      outputBlob: output,
      filename: 'room-processed.wav',
      sourceFile: source,
      modelIds: ['bsrnn_vocals'],
      appVersion: '25.0.2',
      deliver: () => {},
    });
    const check = await verifyProvenanceRecord(result.record, {
      outputBlob: output,
      sourceBlob: source,
      hashFn: async (blob) => (await hashBlobSha256(blob)).hex,
    });
    expect(check.ok).toBe(true);
    expect(check.checks.sourceSha256).toBe('passed');
    expect(result.record.application.modelIds).toEqual(['bsrnn_vocals']);
    expect(result.record.application.models[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('cancellation does not deliver a sidecar', async () => {
    const signal = AbortSignal.abort();
    const delivered = [];
    await expect(publishExportProvenance({
      outputBlob: new Blob(['x']),
      filename: 'x.wav',
      signal,
      deliver: (blob, name) => delivered.push(name),
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(delivered).toEqual([]);
  });
});
