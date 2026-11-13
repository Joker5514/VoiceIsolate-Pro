'use strict';

const fs = require('fs');
const path = require('path');

describe('mobile upload wiring ownership', () => {
  const app = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '../public/app/mobile-upload-fix.js'), 'utf8');

  test('the application marks its canonical file-input change handler', () => {
    expect(app).toMatch(/bind\('fileInput', d\.fileInput, 'change',[\s\S]{0,260}vipAppChangeBound = '1'/);
  });

  test('the mobile fallback does not add a second change handler', () => {
    expect(mobile).toMatch(/if \(!fi\.dataset\.vipChangeBound && !fi\.dataset\.vipAppChangeBound\)/);
  });

  test('the application marks its canonical drop handler', () => {
    expect(app).toMatch(/d\.dropZone\.addEventListener\('drop',[\s\S]{0,260}vipAppDropBound = '1'/);
  });

  test('the mobile fallback does not add a second drop handler', () => {
    expect(mobile).toMatch(/if \(dropZone && !dropZone\.dataset\.vipDropBound && !dropZone\.dataset\.vipAppDropBound\)/);
  });
});
