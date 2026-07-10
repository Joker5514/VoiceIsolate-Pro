'use strict';

const fs = require('fs');
const path = require('path');

const uploadJs = fs.readFileSync(
  path.join(__dirname, '../src/presentation/UploadWiring.js'),
  'utf8'
);
const landingJs = fs.readFileSync(
  path.join(__dirname, '../public/landing.js'),
  'utf8'
);
const appJs = fs.readFileSync(
  path.join(__dirname, '../public/app/app.js'),
  'utf8'
);

describe('UploadWiring.js', () => {
  test('exports openFilePicker with showPicker fallback', () => {
    expect(uploadJs).toContain('export function openFilePicker');
    expect(uploadJs).toContain('showPicker');
    expect(uploadJs).toContain('fileInput.click()');
  });

  test('exports primeAudioGesture for mobile decode unlock', () => {
    expect(uploadJs).toContain('export async function primeAudioGesture');
  });
});

describe('Landing + Engineer import UploadWiring', () => {
  test('landing.js uses shared openFilePicker + touch fixes', () => {
    expect(landingJs).toContain("from '/src/presentation/UploadWiring.js'");
    expect(landingJs).toContain('openFilePicker(ui.fileInput)');
    expect(landingJs).toContain('fixUploadTouchTargets()');
  });

  test('app.js uses triggerFileInput alias (avoids openFilePicker recursion)', () => {
    expect(appJs).toContain("openFilePicker as triggerFileInput");
    expect(appJs).toContain('triggerFileInput(this.dom.fileInput)');
  });

  test('landing opens picker before awaiting primeAudioGesture', () => {
    expect(landingJs).toContain('openFilePicker(ui.fileInput)');
    expect(landingJs).toMatch(/openFilePicker\(ui\.fileInput\)[\s\S]*primeAudioGesture/);
  });
});