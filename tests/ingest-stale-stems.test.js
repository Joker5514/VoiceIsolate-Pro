/**
 * Live test t24u/t25u: two different 30 s inputs (whisper+club mix, whisper
 * only) exported byte-identical WAVs (same output SHA-256), the control run's
 * "ML" took 9 ms, and the sidecar had "source": null.
 *
 * Reproduced in headless Chrome on main 2f78ab3: dsp-bootstrap.js injects
 * m4a-decode-fix.js, which replaced VoiceIsolatePro#handleFile (prototype and
 * live instance) with a legacy loader. That loader never bumped _fileSeq,
 * never dropped the previous file's stems and never set _sourceFile, so the
 * second Process took the "retained stems" branch and re-used file 1's stems.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public/app/app.js'), 'utf8').replace(/\r\n/g, '\n');
const patchSource = fs.readFileSync(path.join(root, 'public/app/m4a-decode-fix.js'), 'utf8');

function methodSource(name, signature) {
  const start = appSource.indexOf(`\n  ${name}(${signature}) {`);
  if (start < 0) throw new Error(`method ${name}(${signature}) not found in app.js`);
  const end = appSource.indexOf('\n  }\n', start);
  return appSource.slice(start + 1, end + 4);
}

describe('legacy m4a decode patch', () => {
  function loadPatch() {
    const originalHandleFile = async function handleFile() {};
    class VoiceIsolatePro {}
    VoiceIsolatePro.prototype.handleFile = originalHandleFile;
    const replaceChild = jest.fn();
    const fileInput = { cloneNode: () => ({ addEventListener: jest.fn() }), parentNode: { replaceChild } };
    const app = new VoiceIsolatePro();
    app.dom = { fileInput };
    const window = { VoiceIsolatePro, _vipApp: app };
    const ctx = {
      window, console: { info() {}, warn() {} },
      document: { readyState: 'complete', addEventListener() {} },
      setTimeout: (fn) => { fn(); return 0; },
    };
    vm.runInNewContext(patchSource, ctx);
    return { window, app, originalHandleFile, replaceChild, VoiceIsolatePro };
  }

  test('keeps the decode helper', () => {
    const { window } = loadPatch();
    expect(typeof window.decodeM4AWithFallback).toBe('function');
    expect(window.__vipM4ADecodeFixLoaded).toBe(true);
  });

  test('does not replace handleFile on the class or the live instance', () => {
    const { app, originalHandleFile, VoiceIsolatePro } = loadPatch();
    expect(VoiceIsolatePro.prototype.handleFile).toBe(originalHandleFile);
    expect(Object.prototype.hasOwnProperty.call(app, 'handleFile')).toBe(false);
  });

  test('does not clone the file input (which dropped the canonical change listener)', () => {
    const { replaceChild } = loadPatch();
    expect(replaceChild).not.toHaveBeenCalled();
  });
});

describe('retained stems belong to the decoded source they came from', () => {
  const makeHarness = () => new Function(`return class {
    ${methodSource('_canReuseRetainedStems', 'buf, fileSeq, processingRevision')}
  };`)();
  function app(over = {}) {
    const Harness = makeHarness();
    const a = new Harness();
    const src = { length: 10 };
    Object.assign(a, {
      _forceMlRerun: false, _stemFileSeq: 3, _stemProcessingRevision: 'r1',
      _cleanStemChannels: [new Float32Array(10)], outputBuffer: {}, _stemSourceBuffer: src,
    }, over);
    return { a, src };
  }

  test('same source, same file, same revision: reuse', () => {
    const { a, src } = app();
    expect(a._canReuseRetainedStems(src, 3, 'r1')).toBe(true);
  });

  test('a different decoded source never reuses stems, even with the same fileSeq', () => {
    const { a } = app();
    expect(a._canReuseRetainedStems({ length: 10 }, 3, 'r1')).toBe(false);
  });

  test('revision change, forced rerun, or missing stems: no reuse', () => {
    const { a, src } = app();
    expect(a._canReuseRetainedStems(src, 3, 'r2')).toBe(false);
    expect(app({ _forceMlRerun: true }).a._canReuseRetainedStems(src, 3, 'r1')).toBe(false);
    expect(app({ _cleanStemChannels: null }).a._canReuseRetainedStems(src, 3, 'r1')).toBe(false);
  });

  test('the ML pipeline uses the predicate and records the stems source', () => {
    const start = appSource.indexOf('\n  async _runMLIsolationPipeline(');
    const body = appSource.slice(start, appSource.indexOf('\n  }\n', start));
    expect(body).toMatch(/this\._canReuseRetainedStems\(buf, fileSeq, processingRevision\)/);
    expect((body.match(/this\._stemSourceBuffer = buf;/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('export sidecar hashes the exported bytes and names the source', () => {
  let publishExportProvenance;
  beforeAll(async () => {
    ({ publishExportProvenance } = await import('../src/pipeline/export-provenance.js'));
  });
  const wavBytes = (seed) => {
    const b = new Uint8Array(4096);
    for (let i = 0; i < b.length; i++) b[i] = (i * 31 + seed * 7) & 0xff;
    return b;
  };

  test('two different exports get two different output hashes, each equal to sha256(bytes)', async () => {
    const recs = [];
    for (const seed of [1, 2]) {
      const bytes = wavBytes(seed);
      const src = new File([new Uint8Array([seed, 1, 2, 3])], `in${seed}.wav`, { type: 'audio/wav' });
      const out = await publishExportProvenance({
        outputBlob: new Blob([bytes], { type: 'audio/wav' }), filename: `processed-${seed}.wav`,
        sourceFile: src, appVersion: 'test', deliver: () => {},
      });
      expect(out.ok).toBe(true);
      expect(out.record.export.output.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
      expect(out.record.source).toMatchObject({ name: `in${seed}.wav`, sizeBytes: 4 });
      expect(out.record.source.sha256).toMatch(/^[0-9a-f]{64}$/);
      recs.push(out.record);
    }
    expect(recs[0].export.output.sha256).not.toBe(recs[1].export.output.sha256);
  });
});
