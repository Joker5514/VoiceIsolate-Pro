/**
 * @jest-environment jsdom
 */
/**
 * Round 13, item 1 (#948 follow-up). The downloaded .viprovenance.json must
 * always carry the last Process stage timings, mlMs and the effective ML
 * provider, with no debug flag. Randy's downloaded sidecar had operations
 * import/process/export and no timing: the Forensic Inspector / Save-provenance
 * download serves the EngineerProvenanceCoordinator record, which never got
 * timing, and the Analysis-workspace export called publishExportProvenance
 * without timing.
 */
'use strict';

const { TextEncoder, TextDecoder } = require('util');
const { webcrypto } = require('crypto');

globalThis.TextEncoder = globalThis.TextEncoder || TextEncoder;
globalThis.TextDecoder = globalThis.TextDecoder || TextDecoder;
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

// jsdom's Blob has no arrayBuffer(); the hashing path needs it.
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer() {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsArrayBuffer(this);
    });
  };
}

let EngineerProvenanceCoordinator;
let mountForensicInspectorUI;
let publishExportProvenance;
let resetTimings;
let stageStart;
let stageEnd;
let setOrtStatus;

beforeAll(async () => {
  ({ EngineerProvenanceCoordinator } = await import('../src/pipeline/EngineerProvenanceCoordinator.js'));
  ({ mountForensicInspectorUI } = await import('../src/presentation/ForensicInspectorUI.js'));
  ({ publishExportProvenance } = await import('../src/pipeline/export-provenance.js'));
  ({ resetTimings, stageStart, stageEnd } = await import('../src/pipeline/PipelineTiming.js'));
  ({ setOrtStatus } = await import('../src/core/OrtStatus.js'));
});

function readBlobText(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = reject;
    r.readAsText(blob);
  });
}

function simulateProcess() {
  localStorage.clear(); // no vip_debug / vip-debug-progress flags
  resetTimings();
  for (const s of ['decode', 'resample', 'ml_isolation', 'pipeline']) stageStart(s);
  for (const s of ['decode', 'resample', 'ml_isolation', 'pipeline']) stageEnd(s);
  setOrtStatus({ provider: 'wasm', providerVerified: true, runtimeLoaded: true });
}

function expectTiming(timing) {
  expect(timing).toBeTruthy();
  for (const s of ['decode', 'resample', 'ml_isolation', 'pipeline']) {
    expect(typeof timing.stagesMs[s]).toBe('number');
  }
  expect(typeof timing.mlMs).toBe('number');
  expect(timing.mlMs).toBe(timing.stagesMs.ml_isolation);
  expect(typeof timing.pipelineMs).toBe('number');
  expect(timing.provider).toBe('wasm');
  expect(timing.providerVerified).toBe(true);
}

describe('downloaded provenance sidecar carries stage timings and provider (no flag)', () => {
  test('Forensic Inspector "Download .viprovenance.json" (coordinator record)', async () => {
    simulateProcess();
    const coordinator = new EngineerProvenanceCoordinator({
      hashBlobFn: async (blob) => ({ hex: 'ab'.repeat(32), bytes: blob.size }),
      fetchVersionFn: async () => 'test',
    });
    const src = new Blob(['source'], { type: 'audio/wav' });
    Object.defineProperty(src, 'name', { value: 'in.wav' });
    await coordinator.recordSourceImport(src);
    coordinator.recordProcessSnapshot({ modelIds: ['bsrnn_vocals'], processingEngine: 'ml-worker', effectiveParams: {} });
    await coordinator.recordExport({ outputBlob: new Blob(['out']), filename: 'out.wav' });

    const container = document.createElement('div');
    document.body.appendChild(container);
    mountForensicInspectorUI(container, coordinator);
    const captured = [];
    URL.createObjectURL = jest.fn((b) => { captured.push(b); return 'blob:x'; });
    URL.revokeObjectURL = jest.fn();
    HTMLAnchorElement.prototype.click = jest.fn();
    container.querySelector('#btnDownloadProvenanceSidecar').click();
    await new Promise((r) => setTimeout(r, 0));
    expect(captured).toHaveLength(1);
    const record = JSON.parse(await readBlobText(captured[0]));
    expect(record.processing.operations.map((o) => o.id)).toEqual(['import', 'process', 'export']);
    expectTiming(record.processing.timing);
  });

  test('publishExportProvenance without an explicit timing (Analysis-workspace export)', async () => {
    simulateProcess();
    let sidecar = null;
    const res = await publishExportProvenance({
      outputBlob: new Blob(['out']),
      filename: 'out.wav',
      appVersion: 'test',
      deliver: (b) => { sidecar = b; },
    });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    const record = JSON.parse(await readBlobText(sidecar));
    expectTiming(record.processing.timing);
  });
});
