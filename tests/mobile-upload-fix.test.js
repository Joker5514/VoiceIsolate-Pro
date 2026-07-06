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
  test('upload zone click opens file picker for BUTTON targets (Browse Files)', () => {
    expect(js).not.toMatch(
      /if\s*\(\s*e\.target\.tagName\s*===\s*['"]BUTTON['"]\s*&&\s*e\.target\s*!==\s*fresh\s*\)\s*return/
    );
    expect(js).toContain('if (fi) fi.click()');
  });

  test('drop handler routes to Engineer Mode handleFile when available', () => {
    expect(js).toContain('window._vipApp');
    expect(js).toContain('app.handleFile(file)');
  });
});