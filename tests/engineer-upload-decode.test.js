/**
 * Engineer Mode handleFile() uses the shared media-decode pipeline.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const appJs = fs.readFileSync(
  path.join(__dirname, '../public/app/app.js'),
  'utf8'
);

describe('Engineer upload decode wiring', () => {
  // Flexible method boundaries for CRLF line endings + optional options param.
  const handleFileSection = appJs.match(
    /async handleFile\(file(?:,\s*options\s*=\s*\{\})?\)\s*\{[\s\S]*?async ensureDecoded/,
  )?.[0] || '';

  test('app.js imports decodeBlobToAudioBuffer and resampleToCanonical', () => {
    expect(appJs).toContain("import { decodeBlobToAudioBuffer } from '/src/pipeline/media-decode.js'");
    expect(appJs).toContain("import { resampleToCanonical } from '/src/pipeline/FileIngestion.js'");
  });

  test('app.js refreshes the upload input accept list from shared media-types metadata', () => {
    expect(appJs).toContain('getFileInputAccept');
    expect(appJs).toContain("d.fileInput.setAttribute('accept', getFileInputAccept())");
  });

  test('handleFile accepts uploads without decoding and ensureDecoded owns shared decode path', () => {
    expect(appJs).toContain('ready (decode on Analyze/Process)');
    expect(appJs).toMatch(/async handleFile\(/);
    expect(handleFileSection.length).toBeGreaterThan(50);
    // Decode lives in ensureDecoded, not handleFile body.
    expect(appJs).toMatch(/async ensureDecoded[\s\S]*decodeBlobToAudioBuffer\(/);
    expect(appJs).toMatch(/async ensureDecoded[\s\S]*resampleToCanonical\(/);
    expect(appJs).toContain('const decoded = await decodeBlobToAudioBuffer(file, {');
    expect(appJs).toContain('const buffer = await resampleToCanonical(decoded, { signal: decodeSignal });');
  });

  test('Process stays enabled for deferred _sourceFile (no decoded buffer yet)', () => {
    // Regression: hero/status handlers re-ran _updateProcessButtonsState and
    // disabled Process because hasBuf only checked inputBuffer/origBuffer.
    expect(appJs).toMatch(
      /_updateProcessButtonsState\(\)\s*\{[\s\S]*?_sourceFile/,
    );
    expect(appJs).toMatch(
      /this\.inputBuffer \|\| this\.origBuffer \|\| this\._sourceFile/,
    );
  });

  test('app.js wires desktop native picker in bindEvents', () => {
    expect(appJs).toContain('pickAudioFile');
    expect(appJs).toContain('isDesktopShell');
  });

  test('boot splash dismisses once bindEvents completes (upload not blocked)', () => {
    expect(appJs).toMatch(/bindEvents\(\);[\s\S]*_dismissBootSplash\(\)/);
  });

  test('openFilePicker import is aliased to avoid infinite recursion', () => {
    expect(appJs).toContain('openFilePicker as triggerFileInput');
    expect(appJs).toContain('triggerFileInput(this.dom.fileInput)');
  });

  test('file picker opens synchronously before primeAudioGesture (preserves user activation)', () => {
    expect(appJs).toContain('triggerFileInput(this.dom.fileInput)');
    expect(appJs).toMatch(/triggerFileInput\([\s\S]*?\)[\s\S]*primeAudioGesture\(\)/);
    expect(appJs).not.toContain("import('/mic-capture.js')");
    expect(appJs).not.toContain('heroCtaRecord');
    expect(appJs).not.toContain('id="micBtn"');
  });
});
