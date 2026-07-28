/**
 * Guardrails: download page + README point at real GitHub Release assets.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dl = fs.readFileSync(path.join(ROOT, 'public/download/index.html'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const dlDoc = fs.readFileSync(path.join(ROOT, 'download/README.md'), 'utf8');
const vercel = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');

const APK_LATEST =
  'https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk';
const APK_PINNED =
  'https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-android-debug.apk';
const EXE_LATEST =
  'https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.0-win-x64.exe';
const EXE_PINNED =
  'https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe';

describe('Download page links', () => {
  test('Android APK latest + pinned direct download URLs', () => {
    expect(dl).toContain(APK_LATEST);
    expect(dl).toContain(APK_PINNED);
    expect(dl).toContain('VoiceIsolate-Pro-android-debug.apk');
  });

  test('Windows installer latest + pinned direct download URLs', () => {
    expect(dl).toContain(EXE_LATEST);
    expect(dl).toContain(EXE_PINNED);
    expect(dl).toContain('VoiceIsolate-Pro-25.0.0-win-x64.exe');
    // Must not only link the releases index without a direct asset
    expect(dl).toMatch(/releases\/latest\/download\/VoiceIsolate-Pro-25\.0\.0-win-x64\.exe/);
  });

  test('reports realistic package sizes (not stale 303/480 MB)', () => {
    expect(dl).toMatch(/~?238/);
    // Windows installer is the lean offline package (~178 MB), not the old ~480 MB build
    expect(dl).toMatch(/~?178/);
    expect(dl).not.toMatch(/~303/);
    expect(dl).not.toMatch(/~480/);
  });
});

describe('README + download docs', () => {
  test('README lists correct APK and Windows asset URLs', () => {
    expect(readme).toContain(APK_LATEST);
    expect(readme).toContain(EXE_LATEST);
    expect(readme).toContain('VoiceIsolate-Pro-25.0.0-win-x64.exe');
  });

  test('download/README.md documents both assets', () => {
    expect(dlDoc).toContain(APK_LATEST);
    expect(dlDoc).toContain(EXE_LATEST);
    expect(dlDoc).toContain('VoiceIsolate-Pro-android-debug.apk');
  });
});

describe('Vercel download redirects', () => {
  test('redirects APK and EXE to GitHub Releases', () => {
    expect(vercel).toContain('VoiceIsolate-Pro-android-debug.apk');
    expect(vercel).toContain('VoiceIsolate-Pro-25.0.0-win-x64.exe');
    expect(vercel).toContain('releases/latest/download/VoiceIsolate-Pro-android-debug.apk');
    expect(vercel).toContain('releases/latest/download/VoiceIsolate-Pro-25.0.0-win-x64.exe');
    expect(vercel).toContain('.apk');
    expect(vercel).toContain('.exe');
  });
});
