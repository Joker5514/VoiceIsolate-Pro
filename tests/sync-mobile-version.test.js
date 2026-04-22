/**
 * VoiceIsolate Pro — scripts/sync-mobile-version.js Unit Tests
 *
 * The sync-mobile-version.js script reads package.json#version and writes
 * the version string to:
 *   - android/app/build.gradle  → versionCode + versionName
 *   - ios/App/App/Info.plist    → CFBundleShortVersionString + CFBundleVersion
 *
 * versionCode / CFBundleVersion = major * 10000 + minor * 100 + patch
 *
 * Because the script is an ES module that writes directly to the filesystem,
 * tests exercise the pure version-derivation logic and the regex replacements
 * in isolation, then verify the actual files have been updated correctly.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Pure version-to-build-number conversion (mirrors the script logic) ────────
function versionToBuildNumber(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return null;
  const [, major, minor, patch] = match.map(Number);
  return major * 10000 + minor * 100 + patch;
}

describe('versionToBuildNumber()', () => {
  test('24.0.0 → 240000', () => {
    expect(versionToBuildNumber('24.0.0')).toBe(240000);
  });

  test('1.0.0 → 10000', () => {
    expect(versionToBuildNumber('1.0.0')).toBe(10000);
  });

  test('0.0.1 → 1', () => {
    expect(versionToBuildNumber('0.0.1')).toBe(1);
  });

  test('22.1.0 → 220100', () => {
    expect(versionToBuildNumber('22.1.0')).toBe(220100);
  });

  test('10.5.3 → 100503', () => {
    expect(versionToBuildNumber('10.5.3')).toBe(100503);
  });

  test('0.10.0 → 1000', () => {
    expect(versionToBuildNumber('0.10.0')).toBe(1000);
  });

  test('returns null for a non-semver string', () => {
    expect(versionToBuildNumber('invalid')).toBeNull();
  });

  test('returns null for an empty string', () => {
    expect(versionToBuildNumber('')).toBeNull();
  });

  test('strips prerelease/build metadata suffixes', () => {
    // The regex matches only the numeric prefix
    expect(versionToBuildNumber('3.2.1-beta.1')).toBe(30201);
  });

  test('minor and patch each max at 99 (field widths)', () => {
    // minor * 100 means each minor increment adds 100 to buildNumber
    expect(versionToBuildNumber('1.99.99')).toBe(10000 + 9900 + 99);
  });
});

// ── build.gradle replacement regex ────────────────────────────────────────────
describe('build.gradle regex replacements', () => {
  function applyGradleReplacements(gradle, version, buildNumber) {
    return gradle
      .replace(/versionCode\s+\d+/, `versionCode ${buildNumber}`)
      .replace(/versionName\s+"[^"]+"/, `versionName "${version}"`);
  }

  const SAMPLE_GRADLE = `
android {
    defaultConfig {
        applicationId "com.voiceisolatepro.app"
        minSdkVersion rootProject.ext.minSdkVersion
        versionCode 22100
        versionName "22.1.0"
        testInstrumentationRunner "androidx.test.runner.AndroidJUnitRunner"
    }
}`;

  test('replaces versionCode correctly', () => {
    const result = applyGradleReplacements(SAMPLE_GRADLE, '24.0.0', 240000);
    expect(result).toContain('versionCode 240000');
    expect(result).not.toContain('versionCode 22100');
  });

  test('replaces versionName correctly', () => {
    const result = applyGradleReplacements(SAMPLE_GRADLE, '24.0.0', 240000);
    expect(result).toContain('versionName "24.0.0"');
    expect(result).not.toContain('versionName "22.1.0"');
  });

  test('leaves other content unchanged', () => {
    const result = applyGradleReplacements(SAMPLE_GRADLE, '24.0.0', 240000);
    expect(result).toContain('applicationId "com.voiceisolatepro.app"');
    expect(result).toContain('minSdkVersion rootProject.ext.minSdkVersion');
  });

  test('handles large versionCode correctly', () => {
    const result = applyGradleReplacements(SAMPLE_GRADLE, '100.0.0', 1000000);
    expect(result).toContain('versionCode 1000000');
  });

  test('replacement is idempotent (running twice gives same result)', () => {
    const once  = applyGradleReplacements(SAMPLE_GRADLE, '24.0.0', 240000);
    const twice = applyGradleReplacements(once, '24.0.0', 240000);
    expect(twice).toBe(once);
  });
});

// ── Info.plist replacement regex ──────────────────────────────────────────────
describe('Info.plist regex replacements', () => {
  function applyPlistReplacements(plist, version, buildNumber) {
    return plist
      .replace(
        /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/,
        `$1${version}$2`
      )
      .replace(
        /(<key>CFBundleVersion<\/key>\s*<string>)[^<]+(<\/string>)/,
        `$1${buildNumber}$2`
      );
  }

  const SAMPLE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>22.1.0</string>
  <key>CFBundleVersion</key>
  <string>22100</string>
  <key>LSRequiresIPhoneOS</key>
  <true/>
</dict>
</plist>`;

  test('replaces CFBundleShortVersionString correctly', () => {
    const result = applyPlistReplacements(SAMPLE_PLIST, '24.0.0', 240000);
    expect(result).toContain('<string>24.0.0</string>');
    expect(result).not.toContain('<string>22.1.0</string>');
  });

  test('replaces CFBundleVersion correctly', () => {
    const result = applyPlistReplacements(SAMPLE_PLIST, '24.0.0', 240000);
    expect(result).toContain('<string>240000</string>');
    expect(result).not.toContain('<string>22100</string>');
  });

  test('does not alter CFBundlePackageType', () => {
    const result = applyPlistReplacements(SAMPLE_PLIST, '24.0.0', 240000);
    expect(result).toContain('<string>APPL</string>');
  });

  test('replacement is idempotent', () => {
    const once  = applyPlistReplacements(SAMPLE_PLIST, '24.0.0', 240000);
    const twice = applyPlistReplacements(once, '24.0.0', 240000);
    expect(twice).toBe(once);
  });

  test('handles multi-digit build numbers correctly', () => {
    const result = applyPlistReplacements(SAMPLE_PLIST, '1.2.3', 10203);
    const buildMatch = result.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
    expect(buildMatch).not.toBeNull();
    expect(buildMatch[1]).toBe('10203');
  });

  test('version string is placed inside <string> tags', () => {
    const result = applyPlistReplacements(SAMPLE_PLIST, '24.0.0', 240000);
    const versionMatch = result.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
    );
    expect(versionMatch).not.toBeNull();
    expect(versionMatch[1]).toBe('24.0.0');
  });
});

// ── Integration: actual package.json version matches current mobile files ─────
describe('Version consistency — package.json vs mobile config files', () => {
  const ROOT = path.join(__dirname, '..');

  let pkgVersion;
  let expectedBuildNumber;

  beforeAll(() => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    pkgVersion = pkg.version;
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(pkgVersion);
    const [, major, minor, patch] = match.map(Number);
    expectedBuildNumber = major * 10000 + minor * 100 + patch;
  });

  test('package.json version is a valid semver string', () => {
    expect(/^\d+\.\d+\.\d+/.test(pkgVersion)).toBe(true);
  });

  test('android/app/build.gradle versionCode matches package.json version', () => {
    const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
    const match = gradle.match(/versionCode\s+(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBe(expectedBuildNumber);
  });

  test('android/app/build.gradle versionName matches package.json version', () => {
    const gradle = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
    const match = gradle.match(/versionName\s+"([^"]+)"/);
    expect(match).not.toBeNull();
    expect(match[1]).toBe(pkgVersion);
  });

  test('ios/App/App/Info.plist CFBundleShortVersionString matches package.json', () => {
    const plist = fs.readFileSync(path.join(ROOT, 'ios/App/App/Info.plist'), 'utf8');
    const match = plist.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
    );
    expect(match).not.toBeNull();
    expect(match[1]).toBe(pkgVersion);
  });

  test('ios/App/App/Info.plist CFBundleVersion matches computed build number', () => {
    const plist = fs.readFileSync(path.join(ROOT, 'ios/App/App/Info.plist'), 'utf8');
    const match = plist.match(
      /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/
    );
    expect(match).not.toBeNull();
    expect(Number(match[1])).toBe(expectedBuildNumber);
  });

  test('build number derivation formula: major*10000 + minor*100 + patch', () => {
    // For 24.0.0: 24*10000 + 0*100 + 0 = 240000
    expect(versionToBuildNumber('24.0.0')).toBe(240000);
    expect(versionToBuildNumber(pkgVersion)).toBe(expectedBuildNumber);
  });
});

// ── Script source structure ────────────────────────────────────────────────────
describe('sync-mobile-version.js source structure', () => {
  const scriptSrc = fs.readFileSync(
    path.join(__dirname, '../scripts/sync-mobile-version.js'),
    'utf8'
  );

  test('script reads package.json for the version', () => {
    expect(scriptSrc).toContain('package.json');
  });

  test('script writes to android/app/build.gradle', () => {
    expect(scriptSrc).toContain('android/app/build.gradle');
  });

  test('script writes to ios/App/App/Info.plist', () => {
    expect(scriptSrc).toContain('ios/App/App/Info.plist');
  });

  test('script uses major * 10000 + minor * 100 + patch formula', () => {
    expect(scriptSrc).toContain('major * 10000 + minor * 100 + patch');
  });

  test('script uses readFileSync and writeFileSync', () => {
    expect(scriptSrc).toContain('readFileSync');
    expect(scriptSrc).toContain('writeFileSync');
  });

  test('script exits with non-zero when version is invalid', () => {
    expect(scriptSrc).toContain('process.exit(1)');
  });

  test('script is an ES module (uses import)', () => {
    expect(scriptSrc.trimStart()).toMatch(/^(\/\*[\s\S]*?\*\/\s*)?import /m);
  });
});