/**
 * Static guardrails for download/release references.
 * Live HTTP/GitHub metadata validation runs in scripts/validate-download-links.mjs.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));
const provenance = JSON.parse(read('docs/releases/release-provenance.json'));

const VERSION = pkg.version;
const TAG = `v${VERSION}`;
const APK_NAME = 'VoiceIsolate-Pro-android-debug.apk';
const EXE_NAME = `VoiceIsolate-Pro-${VERSION}-win-x64.exe`;
const APK_LATEST =
  `https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/${APK_NAME}`;
const APK_PINNED =
  `https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/${TAG}/${APK_NAME}`;
const EXE_LATEST =
  `https://github.com/Joker5514/VoiceIsolate-Pro/releases/latest/download/${EXE_NAME}`;
const EXE_PINNED =
  `https://github.com/Joker5514/VoiceIsolate-Pro/releases/download/${TAG}/${EXE_NAME}`;

const CURRENT_DOCS = [
  'README.md',
  'download/README.md',
  'docs/DOWNLOADS.md',
  'docs/guides/ANDROID.md',
  'docs/guides/electron-desktop.md',
  'docs/releases/PLATFORM_SYNC.md',
  'public/download/index.html',
];

describe('current download references', () => {
  test.each(CURRENT_DOCS)('%s does not foreground v24 direct downloads', (rel) => {
    expect(read(rel)).not.toContain('/releases/download/v24.0.0/');
  });

  test('public download page uses latest + pinned current Android assets', () => {
    const html = read('public/download/index.html');
    expect(html).toContain(APK_LATEST);
    expect(html).toContain(APK_PINNED);
    expect(html).toContain(APK_NAME);
    expect(html).toContain(VERSION);
  });

  test('public download page uses latest + pinned current Windows assets', () => {
    const html = read('public/download/index.html');
    expect(html).toContain(EXE_LATEST);
    expect(html).toContain(EXE_PINNED);
    expect(html).toContain(EXE_NAME);
  });

  test('README and canonical download docs expose current latest URLs', () => {
    for (const rel of ['README.md', 'download/README.md', 'docs/DOWNLOADS.md']) {
      const text = read(rel);
      expect(text).toContain(APK_LATEST);
      expect(text).toContain(EXE_LATEST);
    }
  });
});

describe('release provenance references', () => {
  test('provenance version and tag match package.json', () => {
    expect(provenance.productVersion).toBe(VERSION);
    expect(provenance.tag).toBe(TAG);
  });

  test('native provenance points to current pinned asset names and URLs', () => {
    const android = provenance.platforms.find((entry) => entry.platform === 'android');
    const windows = provenance.platforms.find((entry) => entry.platform === 'windows');

    expect(android.artifact.filename).toBe(APK_NAME);
    expect(android.artifact.url).toBe(APK_PINNED);
    expect(android.artifact.sizeBytes).toBeGreaterThan(0);
    expect(android.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(windows.artifact.filename).toBe(EXE_NAME);
    expect(windows.artifact.url).toBe(EXE_PINNED);
    expect(windows.artifact.sizeBytes).toBeGreaterThan(0);
    expect(windows.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('current docs do not claim published native artifacts are synchronized with current main', () => {
    expect(provenance.claims.sameBuildAcrossWebAndroidWindowsMainAndTag).toBe(false);
    expect(provenance.claims.synchronizedPublishedArtifacts).toBe(false);
    expect(['stale', 'unknown']).toContain(
      provenance.platforms.find((entry) => entry.platform === 'android').status,
    );
    expect(['stale', 'unknown']).toContain(
      provenance.platforms.find((entry) => entry.platform === 'windows').status,
    );
  });
});

describe('Vercel download redirects', () => {
  test('current APK and EXE redirect routes point at release latest URLs', () => {
    const vercel = JSON.parse(read('vercel.json'));
    const redirects = vercel.redirects || [];
    const android = redirects.find((entry) => entry.source === `/download/${APK_NAME}`);
    const windows = redirects.find((entry) => entry.source === `/download/${EXE_NAME}`);

    expect(android).toBeDefined();
    expect(android.destination).toBe(APK_LATEST);
    expect(windows).toBeDefined();
    expect(windows.destination).toBe(EXE_LATEST);
  });
});
