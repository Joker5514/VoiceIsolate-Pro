/**
 * Guardrails: download page + README point at real GitHub Release assets.
 * In-repo / intended `latest`: v25.0.2 (rebuild + release upload required for artifacts)
 *   - APK: VoiceIsolate-Pro-android-debug.apk
 *   - Windows: VoiceIsolate-Pro-${pkg.version}-win-x64.exe
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
const EXE_LATEST =
  `https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-${pkg.version}-win-x64.exe`;
const EXE_PINNED_V24 =
  'https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/v24.0.0/VoiceIsolate-Pro-24.0.0-win-x64.exe';
const EXE_LEGACY_250 =
  'https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/VoiceIsolate-Pro-25.0.0-win-x64.exe';

describe('Download page links', () => {
  test('Android APK latest direct download URL', () => {
    expect(dl).toContain(APK_LATEST);
    expect(dl).toContain('VoiceIsolate-Pro-android-debug.apk');
  });

  test('Windows primary button uses published package-version asset', () => {
    expect(dl).toContain(EXE_LATEST);
    expect(dl).toContain(`VoiceIsolate-Pro-${pkg.version}-win-x64.exe`);
    expect(dl).toContain(EXE_PINNED_V24);
    // Stale 25.0.0 latest name must not be the primary target
    expect(dl).not.toContain(EXE_LEGACY_250);
  });

  test('download page states product version', () => {
    expect(dl).toContain(pkg.version);
  });
});

describe('README + download docs', () => {
  test('README lists working APK and Windows asset URLs', () => {
    expect(readme).toContain(APK_LATEST);
    expect(readme).toContain(EXE_LATEST);
    expect(readme).toContain(`VoiceIsolate-Pro-${pkg.version}-win-x64.exe`);
  });

  test('download/README.md + docs/DOWNLOADS.md document working assets', () => {
    expect(dlDoc).toContain(APK_LATEST);
    expect(dlDoc).toContain(EXE_LATEST);
    expect(downloadsMd).toContain(EXE_LATEST);
    expect(downloadsMd).toContain(`v${pkg.version}`);
  });
});

describe('Vercel download redirects', () => {
  test('redirects APK and EXE to GitHub Releases with working destinations', () => {
    expect(vercel).toContain('VoiceIsolate-Pro-android-debug.apk');
    expect(vercel).toContain('releases/latest/download/VoiceIsolate-Pro-android-debug.apk');
    expect(vercel).toContain(`VoiceIsolate-Pro-${pkg.version}-win-x64.exe`);
    expect(vercel).toContain(
      `releases/latest/download/VoiceIsolate-Pro-${pkg.version}-win-x64.exe`
    );
    // Legacy 25.0.0 path must not destination-404; remap to current latest name
    expect(vercel).toContain('VoiceIsolate-Pro-25.0.0-win-x64.exe');
    expect(vercel).not.toContain(
      'releases/latest/download/VoiceIsolate-Pro-25.0.0-win-x64.exe'
    );
    expect(vercel).toContain('.apk');
    expect(vercel).toContain('.exe');
  });
});
