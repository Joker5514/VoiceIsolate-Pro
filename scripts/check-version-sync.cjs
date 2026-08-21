#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const version = pkg.version;
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);

if (!match) {
  console.error(`[version-sync] package.json has a non-release version: ${version}`);
  process.exit(1);
}

const buildNumber = Number(match[1]) * 10000 + Number(match[2]) * 100 + Number(match[3]);
const checks = [
  ['Android versionName', 'android/app/build.gradle', `versionName "${version}"`],
  ['Android versionCode', 'android/app/build.gradle', `versionCode ${buildNumber}`],
  ['Android Capacitor UA', 'capacitor.config.json', `VoiceIsolatePro/${version} Android`],
  ['Browser PWA manifest', 'public/manifest.json', `"version": "${version}"`],
  ['Browser API health', 'api-routes/index.js', `version: '${version}'`],
  ['Download page version', 'public/download/index.html', `v${version}`],
  ['Windows release asset', 'public/download/index.html', `VoiceIsolate-Pro-${version}-win-x64.exe`],
];

let failed = false;
for (const [label, file, expected] of checks) {
  if (read(file).includes(expected)) {
    console.log(`✓ ${label}: ${version}`);
  } else {
    failed = true;
    console.error(`✗ ${label}: ${file} does not contain ${JSON.stringify(expected)}`);
  }
}

if (failed) process.exit(1);
console.log(`[version-sync] Web, Electron, and Android are aligned at ${version} (${buildNumber}).`);
