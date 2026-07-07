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
  test('app.js imports decodeBlobToAudioBuffer and resampleToCanonical', () => {
    expect(appJs).toContain("import { decodeBlobToAudioBuffer } from '/src/pipeline/media-decode.js'");
    expect(appJs).toContain("import { resampleToCanonical } from '/src/pipeline/FileIngestion.js'");
  });

  test('handleFile decodes via shared media path (not broken video-metadata stub)', () => {
    expect(appJs).toContain('const decoded = await decodeBlobToAudioBuffer(file)');
    expect(appJs).toContain('buffer = await resampleToCanonical(decoded)');
    expect(appJs).not.toContain('resolve(this.inputBuffer || null)');
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

  test('app.js disables live mic capture on desktop shell', () => {
    expect(appJs).toContain('isMicCaptureEnabled');
    expect(appJs).toContain('hideMicControls');
  });
});