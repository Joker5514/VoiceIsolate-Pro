'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('privacy CI scripts', () => {
  test('check-privacy-invariants exits 0 on current tree', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-privacy-invariants.js')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/pass/i);
  });

  test('check-no-cloud-audio exits 0 on current tree', () => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-no-cloud-audio.js')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
  });
});
