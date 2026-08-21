#!/usr/bin/env node
/**
 * Sync packaged application version strings to `package.json#version`.
 *
 * Writes:
 *   - android/app/build.gradle  → versionCode + versionName
 *   - ios/App/App/Info.plist    → CFBundleShortVersionString + CFBundleVersion
 *   - capacitor.config.json     → Android/iOS user-agent version
 *   - public/manifest.json      → installed browser/PWA version
 *
 * versionCode / CFBundleVersion are derived as major * 10000 + minor * 100 + patch.
 * Run manually, or wire into `postversion` to update automatically on bump.
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const ROOT = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
if (!match) {
  console.error(`[sync-mobile-version] Unexpected version string: ${version}`);
  process.exit(1);
}
const [, major, minor, patch] = match.map(Number);
const buildNumber = major * 10000 + minor * 100 + patch;


// ── Android build.gradle ─────────────────────────────────────────────────────
const gradlePath = join(ROOT, 'android/app/build.gradle');
let gradle = readFileSync(gradlePath, 'utf8');
gradle = gradle
  .replace(/versionCode\s+\d+/, `versionCode ${buildNumber}`)
  .replace(/versionName\s+"[^"]+"/, `versionName "${version}"`);
writeFileSync(gradlePath, gradle);

// ── iOS Info.plist ───────────────────────────────────────────────────────────
const plistPath = join(ROOT, 'ios/App/App/Info.plist');
let plist = readFileSync(plistPath, 'utf8');
plist = plist
  .replace(
    /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+(<\/string>)/,
    `$1${version}$2`
  )
  .replace(
    /(<key>CFBundleVersion<\/key>\s*<string>)[^<]+(<\/string>)/,
    `$1${buildNumber}$2`
  );
writeFileSync(plistPath, plist);

// ── Capacitor + browser metadata ────────────────────────────────────────────
const capacitorPath = join(ROOT, 'capacitor.config.json');
const capacitor = JSON.parse(readFileSync(capacitorPath, 'utf8'));
capacitor.android.appendUserAgent = `VoiceIsolatePro/${version} Android`;
capacitor.ios.appendUserAgent = `VoiceIsolatePro/${version}`;
writeFileSync(capacitorPath, `${JSON.stringify(capacitor, null, 2)}\n`);

const manifestPath = join(ROOT, 'public/manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
manifest.version = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`[sync-mobile-version] version=${version} buildNumber=${buildNumber}`);
