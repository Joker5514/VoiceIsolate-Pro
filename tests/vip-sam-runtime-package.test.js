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
      'services/sam-audio/torchcodec_bootstrap.py',
      'services/sam-audio/sam_hub_compat.py',
      'services/sam-audio/requirements.txt',
      'scripts/install-sam-runtime.mjs',
      'scripts/sam-production-setup.mjs',
      'scripts/ensure-sam-in-build.mjs',
      'scripts/run-sam-worker.mjs',
      // SAM 3 vision sidecar (all platforms)
      'src/sam3_integration/index.js',
      'src/sam3_integration/worker.js',
      'public/app/sam3-worker.js',
      'public/app/models/sam3/README.md',
      'public/app/models/sam3-runtime.marker.json',
    ]) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true);
    }
  });

  test('worker production hardening is present', () => {
    const server = fs.readFileSync(path.join(ROOT, 'services/sam-audio/server.py'), 'utf8');
    expect(server).toMatch(/SAM_AUDIO_PRODUCTION/);
    expect(server).toMatch(/SAM_AUDIO_ALLOW_MOCK/);
    expect(server).toMatch(/torchcodec_bootstrap/);
    expect(server).toMatch(/sam_hub_compat|apply_sam_hub_compat|_apply_hub_compat/);
    expect(server).toMatch(/\/ready/);
    expect(server).toMatch(/real-sam-required/);
    const electron = fs.readFileSync(path.join(ROOT, 'electron/main.cjs'), 'utf8');
    expect(electron).toMatch(/SAM_AUDIO_PRODUCTION/);
    expect(electron).toMatch(/VIP_FFMPEG_SHARED_BIN|resolveFfmpegSharedBin/);
    expect(electron).toMatch(/--preload/);
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

  test('electron-builder bundles sam-audio + sam3 extraResources', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'electron/electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/extraResources/);
    expect(yml).toMatch(/services\/sam-audio/);
    expect(yml).toMatch(/vip-sam-runtime/);
    expect(yml).toMatch(/sam3_integration|sam3-runtime\.marker/);
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
    // Seed what older builds staged, so the test proves they are removed.
    for (const stale of ['build/sam-audio', 'build/ffmpeg-shared']) {
      fs.mkdirSync(path.join(ROOT, stale), { recursive: true });
      fs.writeFileSync(path.join(ROOT, stale, 'stale.txt'), 'stale');
    }
    fs.mkdirSync(path.join(ROOT, 'build/app/models'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'build/app/models/sam_audio.onnx'), 'stale');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ensure-sam-in-build.mjs')], {
      encoding: 'utf8',
      cwd: ROOT,
    });
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(ROOT, 'build/app/models/sam-runtime.marker.json'))).toBe(true);
    // Desktop-only worker and FFmpeg ship via electron-builder extraResources,
    // never through build/ (the Capacitor webDir and app.asar).
    expect(fs.existsSync(path.join(ROOT, 'build/sam-audio'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'build/ffmpeg-shared'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'build/app/models/sam_audio.onnx'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT, 'build/packages/vip-sam-runtime/package.json'))).toBe(true);
    // SAM 3 vision on all three surfaces via build/
    expect(fs.existsSync(path.join(ROOT, 'build/app/models/sam3-runtime.marker.json'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'build/src/sam3_integration/index.js'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'build/app/sam3-worker.js'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'build/app/models/sam3/README.md'))).toBe(true);
  });
});
