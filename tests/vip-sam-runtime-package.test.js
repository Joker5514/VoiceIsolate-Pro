/**
 * SAM runtime package must ship with all three product surfaces.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('vip-sam-runtime package in program', () => {
  test('package files exist', () => {
    for (const rel of [
      'packages/vip-sam-runtime/package.json',
      'packages/vip-sam-runtime/manifest.json',
      'packages/vip-sam-runtime/index.js',
      'packages/vip-sam-runtime/paths.js',
      'services/sam-audio/server.py',
      'services/sam-audio/requirements.txt',
      'scripts/install-sam-runtime.mjs',
      'scripts/ensure-sam-in-build.mjs',
      'scripts/run-sam-worker.mjs',
    ]) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    }
  });

  test('manifest lists web, android, desktop', () => {
    const m = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'packages/vip-sam-runtime/manifest.json'), 'utf8'),
    );
    expect(m.platforms.web).toBeTruthy();
    expect(m.platforms.android).toBeTruthy();
    expect(m.platforms.desktop).toBeTruthy();
    expect(m.sam.officialRepo).toMatch(/facebookresearch\/sam-audio/);
    expect(m.sam.defaultModelId).toMatch(/sam-audio/);
  });

  test('electron-builder bundles sam-audio extraResources', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'electron/electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/extraResources/);
    expect(yml).toMatch(/services\/sam-audio/);
    expect(yml).toMatch(/vip-sam-runtime/);
  });

  test('layout install writes marker for all platforms', () => {
    const { spawnSync } = require('child_process');
    const r = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'install-sam-runtime.mjs'), '--skip-pip'],
      { encoding: 'utf8', cwd: ROOT },
    );
    expect(r.status).toBe(0);
    const marker = path.join(ROOT, 'public/app/models/sam-runtime.marker.json');
    expect(fs.existsSync(marker)).toBe(true);
    const j = JSON.parse(fs.readFileSync(marker, 'utf8'));
    expect(j.bundled).toBe(true);
    expect(j.platforms).toEqual(expect.arrayContaining(['web', 'android', 'desktop']));
  });

  test('ensure-sam-in-build stages package into build/', () => {
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ensure-sam-in-build.mjs')], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(ROOT, 'build/app/models/sam-runtime.marker.json'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'build/sam-audio/server.py'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'build/packages/vip-sam-runtime/package.json'))).toBe(true);
  });
});
