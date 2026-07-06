/**
 * mobile-upload-fix.js regression — Browse button and drop routing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const js = fs.readFileSync(
  path.join(__dirname, '../public/app/mobile-upload-fix.js'),
  'utf8'
);

describe('mobile-upload-fix.js', () => {
  test('does not clone upload zones (avoids orphaning app.js handlers)', () => {
    expect(js).not.toContain('cloneNode(true)');
    expect(js).not.toContain('replaceChild(fresh, zone)');
  });

  test('re-binds file input change to _vipApp.handleFile', () => {
    expect(js).toContain('ensureUploadWiring');
    expect(js).toContain('live.handleFile(file)');
  });

  test('does not add duplicate picker click handlers (app.js owns Browse)', () => {
    expect(js).not.toContain('vipPickerBound');
  });

  test('drop handler routes to Engineer Mode handleFile when available', () => {
    expect(js).toContain('window._vipApp');
    expect(js).toContain('live.handleFile(file)');
  });
});