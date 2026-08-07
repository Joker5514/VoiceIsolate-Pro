/**
 * Guardrails: download page + README point at real GitHub Release assets.
 * Published `latest` (as of 2026-08-07) is still v24.0.0:
 *   - APK name is version-stable → latest/download/...apk works
 *   - Windows asset is VoiceIsolate-Pro-24.0.0-win-x64.exe only
 *   - VoiceIsolate-Pro-25.*.exe latest URLs 404 until a new release is cut
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dl = fs.readFileSync(path.join(ROOT, 'public/download/index.html'), 'utf8');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const dlDoc = fs.readFileSync(path.join(ROOT, 'download/README.md'), 'utf8');
const downloadsMd = fs.readFileSync(path.join(ROOT, 'docs/DOWNLOADS.md'), 'utf8');
const vercel = fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const APK_LATEST =
  'https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-android-debug.apk';
const APK_PINNED =
  'https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-android-debug.apk';
/** Only Windows asset published on GitHub today (v24.0.0). */
const EXE_PUBLISHED_LATEST =
  'https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-24.0.0-win-x64.exe';
const EXE_PINNED =
  'https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe';
/** Broken until maintainers upload a 25.x Windows installer. */
const EXE_25_BROKEN =
  'https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.0-win-x64.exe';

describe('Download page links', () => {
  test('Android APK latest + pinned direct download URLs', () => {
    expect(dl).toContain(APK_LATEST);
    expect(dl).toContain(APK_PINNED);
    expect(dl).toContain('VoiceIsolate-Pro-android-debug.apk');
  });

  test('Windows primary button uses published v24 asset (not 404 25.x names)', () => {
    expect(dl).toContain(EXE_PUBLISHED_LATEST);
    expect(dl).toContain(EXE_PINNED);
    expect(dl).toContain('VoiceIsolate-Pro-24.0.0-win-x64.exe');
    // Must not advertise a non-existent 25.x latest asset as the primary download
    expect(dl).not.toContain(EXE_25_BROKEN);
    expect(dl).not.toMatch(/releases\/latest\/download\/VoiceIsolate-Pro-25\.\d+\.\d+-win-x64\.exe/);
  });

  test('download page states in-repo version and published lag honestly', () => {
    expect(dl).toContain(pkg.version);
    expect(dl).toMatch(/v24\.0\.0/);
  });
});

describe('README + download docs', () => {
  test('README lists working APK and Windows asset URLs', () => {
    expect(readme).toContain(APK_LATEST);
    expect(readme).toContain(EXE_PUBLISHED_LATEST);
    expect(readme).toContain('VoiceIsolate-Pro-24.0.0-win-x64.exe');
    expect(readme).not.toContain(EXE_25_BROKEN);
  });

  test('download/README.md + docs/DOWNLOADS.md document working assets', () => {
    expect(dlDoc).toContain(APK_LATEST);
    expect(dlDoc).toContain(EXE_PUBLISHED_LATEST);
    expect(dlDoc).toContain('VoiceIsolate-Pro-android-debug.apk');
    expect(downloadsMd).toContain(EXE_PUBLISHED_LATEST);
    expect(downloadsMd).toContain('404');
  });
});

describe('Vercel download redirects', () => {
  test('redirects APK and EXE to GitHub Releases with working destinations', () => {
    expect(vercel).toContain('VoiceIsolate-Pro-android-debug.apk');
    expect(vercel).toContain('releases/latest/download/VoiceIsolate-Pro-android-debug.apk');
    // Legacy 25.x paths must remap to the published v24 Windows asset (not a 404)
    expect(vercel).toContain('VoiceIsolate-Pro-25.0.0-win-x64.exe');
    expect(vercel).toContain('VoiceIsolate-Pro-25.0.1-win-x64.exe');
    expect(vercel).toContain(
      'releases/latest/download/VoiceIsolate-Pro-24.0.0-win-x64.exe'
    );
    expect(vercel).not.toContain(
      'releases/latest/download/VoiceIsolate-Pro-25.0.0-win-x64.exe'
    );
    expect(vercel).toContain('.apk');
    expect(vercel).toContain('.exe');
  });
});
