/**
 * Regression: "Upload failed: Cannot set properties of null (setting 'textContent')"
 *
 * The landing unhandledrejection handler used to prefix every rejection with
 * "Upload failed:". A missing status node then looked like the file import failed.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const landing = fs.readFileSync(path.join(ROOT, 'public/landing.js'), 'utf8');
const premium = fs.readFileSync(path.join(ROOT, 'public/landing-premium.js'), 'utf8');
const badge = fs.readFileSync(path.join(ROOT, 'src/ui/components/OnDeviceBadge/OnDeviceBadge.js'), 'utf8');

let classifyClientRejection;

beforeAll(async () => {
  ({ classifyClientRejection } = await import('../src/presentation/UploadWiring.js'));
});

describe('classifyClientRejection', () => {
  test('a null textContent write is a UI defect even while ingest is in flight', () => {
    const reason = new TypeError("Cannot set properties of null (setting 'textContent')");
    const classified = classifyClientRejection(reason, { ingestInFlight: true });
    expect(classified.kind).toBe('ui');
    expect(classified.status).toBeNull();
    expect(classified.message).toBe(reason.message);
  });

  test('null writes of innerHTML, hidden, disabled, and value are UI defects', () => {
    for (const prop of ['innerHTML', 'hidden', 'disabled', 'value']) {
      const reason = new TypeError(`Cannot set properties of null (setting '${prop}')`);
      const classified = classifyClientRejection(reason, { ingestInFlight: true });
      expect(classified.kind).toBe('ui');
      expect(classified.status).toBeNull();
    }
  });

  test('a serialized TypeError with the same message is still a UI defect', () => {
    const classified = classifyClientRejection({
      name: 'TypeError',
      message: "Cannot set properties of null (setting 'textContent')",
    }, { ingestInFlight: true });
    expect(classified.kind).toBe('ui');
    expect(classified.status).toBeNull();
  });

  test('an in-flight decode error stays an upload failure', () => {
    const classified = classifyClientRejection(new Error('Decode failed'), { ingestInFlight: true });
    expect(classified.kind).toBe('upload');
    expect(classified.status).toBe('Upload failed: Decode failed');
  });

  test('a rejection outside ingest keeps the original message', () => {
    const classified = classifyClientRejection(new Error('network down'), { ingestInFlight: false });
    expect(classified.kind).toBe('app');
    expect(classified.status).toBe('network down');
  });

  test('a null property read is not classified as a DOM write', () => {
    const classified = classifyClientRejection(
      new TypeError("Cannot read properties of null (reading 'length')"),
      { ingestInFlight: false },
    );
    expect(classified.kind).toBe('app');
    expect(classified.status).toContain("reading 'length'");
  });
});

describe('landing status reporting', () => {
  test('unhandledrejection classifies before it writes status', () => {
    expect(landing).toContain('classifyClientRejection(event.reason, { ingestInFlight })');
    expect(landing).not.toContain('Upload failed: ${msg}');
    const handler = landing.slice(landing.indexOf("addEventListener('unhandledrejection'"));
    expect(handler).toContain("classified.kind === 'ui'");
    expect(handler).toContain('import state was left unchanged');
  });

  test('file choice, picker, and drop rejections are caught at the call site', () => {
    const chosen = landing.slice(
      landing.indexOf('async function onFileChosen'),
      landing.indexOf('function wireUploadDropZone'),
    );
    expect(chosen).toContain('file choice failed');
    expect(landing).toContain('openPickerSafely');
    expect(landing).toContain('picker failed');
    expect(landing).toContain('drop import failed');
  });

  test('chunked import updates the clock through the guarded readout helper', () => {
    const fn = landing.slice(
      landing.indexOf('function presentChunkedImport'),
      landing.indexOf('function recomputeMemoryPlan'),
    );
    expect(fn).toContain('writeTimeReadout(0, next.duration || 0)');
    expect(fn).not.toContain('ui.timeReadout.textContent');
  });

  test('speaker detection does not write when the panel is missing', () => {
    const fn = landing.slice(
      landing.indexOf('async function detectSpeakers'),
      landing.indexOf('async function ensureTargetSpeakerUi'),
    );
    expect(fn).toMatch(/if\s*\(\s*!ui\.speakersPanel\s*\|\|\s*!ui\.speakerStatus\s*\)/);
    expect(fn).toContain('detection UI skipped');
    expect(fn).not.toContain('ui.speakerStatus.textContent');
  });

  test('the time readout helper warns once and still writes when the node exists', () => {
    const fn = landing.slice(landing.indexOf('function writeTimeReadout'), landing.indexOf('function setSpeakerStatus'));
    expect(fn).toContain('time readout is missing');
    expect(fn).toContain('ui.timeReadout.textContent');
    expect(fn).toContain('if (!ui.timeReadout)');
  });
});

describe('premium analysis status', () => {
  test('a missing analysis overlay does not fail a successful analysis', () => {
    expect(premium).not.toMatch(/getElementById\('analysisOverlayStatus'\)\.textContent/);
    expect(premium).toContain('analysis overlay status is missing; analysis result stays successful');
    expect(premium).toContain('if (uiWrite) return');
  });

  test('capability detection and the import listener cannot reject unhandled', () => {
    expect(premium).toMatch(/detectCapabilities\(\)\.then\([\s\S]*?\)\.catch\(/);
    expect(premium).toContain('file import listener failed');
  });
});

describe('OnDeviceBadge mount guard', () => {
  test('setStatus returns when its status nodes are missing', () => {
    expect(badge).toMatch(/if\s*\(\s*!this\._els\.dot\s*\|\|\s*!this\._els\.label\s*\)/);
    expect(badge).toContain('status nodes missing; badge was cleared or failed to mount');
  });
});
