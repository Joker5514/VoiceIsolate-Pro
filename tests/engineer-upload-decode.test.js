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
  const handleFileSection = appJs.match(/async handleFile\(file\) \{[\s\S]*?\n  \}\n\n  \/\*\*/)?.[0] || '';
  const ensureDecodedSection = appJs.match(/async ensureDecoded\(fileSeq = this\._fileSeq\) \{[\s\S]*?\n  \}\n\n  \/\*\*/)?.[0] || '';

  test('app.js imports decodeBlobToAudioBuffer and resampleToCanonical', () => {
    expect(appJs).toContain("import { decodeBlobToAudioBuffer } from '/src/pipeline/media-decode.js'");
    expect(appJs).toContain("import { resampleToCanonical } from '/src/pipeline/FileIngestion.js'");
  });

  test('handleFile accepts uploads without decoding and ensureDecoded owns shared decode path', () => {
    expect(handleFileSection).toContain('ready (decode on Analyze/Process)');
    expect(handleFileSection).not.toContain('decodeBlobToAudioBuffer(');
    expect(handleFileSection).not.toContain('resampleToCanonical(');
    expect(ensureDecodedSection).toContain('const decoded = await decodeBlobToAudioBuffer(file, {');
    expect(ensureDecodedSection).toContain('const buffer = await resampleToCanonical(decoded);');
    expect(ensureDecodedSection).not.toContain('resolve(this.inputBuffer || null)');
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