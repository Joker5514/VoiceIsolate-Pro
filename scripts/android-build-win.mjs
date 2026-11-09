#!/usr/bin/env node
/**
 * Windows Android package build.
 * Default: debug sideload APK.
 * `--release`: signed release APK. `--release --bundle`: signed release AAB.
 * Uses JDK 21 when the system default is too new for Gradle (e.g. Java 25).
 * Release mode exits before any build when signing env is incomplete.
 */
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');
const isWin = process.platform === 'win32';
const release = process.argv.includes('--release');
const bundle = process.argv.includes('--bundle');
const SIGNING_KEYS = [
  'ANDROID_KEYSTORE_PATH',
  'ANDROID_KEYSTORE_PASSWORD',
  'ANDROID_KEY_ALIAS',
  'ANDROID_KEY_PASSWORD',
];

if (bundle && !release) {
  console.error('[android] --bundle requires --release');
  process.exit(1);
}

function assertReleaseSigning() {
  const missing = SIGNING_KEYS.filter((key) => !String(process.env[key] || '').trim());
  if (missing.length) {
    console.error(`[android] Release signing is incomplete. Missing ${missing.join(', ')}.`);
    console.error('[android] Debug sideload builds stay on pnpm android:build:win. Do not publish an unsigned APK.');
    process.exit(1);
  }
  const store = process.env.ANDROID_KEYSTORE_PATH;
  if (!fs.existsSync(store) || !fs.statSync(store).isFile()) {
    console.error(`[android] ANDROID_KEYSTORE_PATH is not a file: ${store}`);
    process.exit(1);
  }
}

if (release) assertReleaseSigning();

function findJdk21() {
  const candidates = [
    process.env.VIP_JAVA_HOME,
    path.join(os.homedir(), '.jdks', 'temurin-21'),
    'C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.11.10-hotspot',
    process.env.JAVA_HOME,
  ].filter(Boolean);

  for (const home of candidates) {
    const java = path.join(home, 'bin', isWin ? 'java.exe' : 'java');
    if (fs.existsSync(java)) {
      const version = spawnSync(java, ['-version'], { encoding: 'utf8' });
      const out = `${version.stderr || ''}${version.stdout || ''}`;
      if (/version "21/.test(out)) return home;
    }
  }
  return null;
}

const jdk21 = findJdk21();
const sdkHome = process.env.ANDROID_HOME || path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
const npmGlobal = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
const nodeDir = path.dirname(process.execPath);
const buildEnv = {
  ...process.env,
  ANDROID_HOME: sdkHome,
  ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || sdkHome,
};

// Ensure node/npm/pnpm stay on PATH when JAVA_HOME is prepended (cmd.exe shells).
{
  const sep = path.delimiter;
  const parts = [
    jdk21 ? path.join(jdk21, 'bin') : null,
    nodeDir,
    npmGlobal,
    process.env.PATH || '',
  ].filter(Boolean);
  buildEnv.PATH = parts.join(sep);
  if (jdk21) {
    buildEnv.JAVA_HOME = jdk21;
    console.log(`[android] Using JAVA_HOME=${jdk21}`);
  } else {
    console.warn('[android] JDK 21 not found — set VIP_JAVA_HOME or install Temurin 21');
  }
}

function run(cmd, args, cwd = ROOT) {
  // Prefer .cmd shims on Windows so resolution works without shell PATH quirks.
  let bin = cmd;
  if (isWin && !path.isAbsolute(cmd) && !cmd.includes(path.sep)
      && !cmd.endsWith('.bat') && !cmd.endsWith('.cmd')) {
    const candidates = [
      path.join(npmGlobal, `${cmd}.cmd`),
      path.join(nodeDir, `${cmd}.cmd`),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { bin = c; break; }
    }
  }
  // Never shell:true with absolute paths that contain spaces (breaks on "Program Files").
  const useShell = isWin && (bin.endsWith('.bat') || bin.endsWith('.cmd'));
  const result = spawnSync(bin, args, {
    cwd,
    stdio: 'inherit',
    shell: useShell,
    env: buildEnv,
  });
  if (result.error) {
    console.error(`[android] Failed to spawn ${bin}:`, result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// node scripts — no pnpm required for the static build step
run(process.execPath, [path.join(ROOT, 'scripts', 'build.mjs')]);
// Turn build/ into a complete offline Engineer app (models, entry, no FP32 bloat).
run(process.execPath, [path.join(ROOT, 'scripts', 'prepare-android-complete.mjs')]);
const npxCmd = path.join(npmGlobal, 'npx.cmd');
const npxBin = fs.existsSync(npxCmd) ? npxCmd : path.join(nodeDir, 'npx.cmd');
run(fs.existsSync(npxBin) ? npxBin : 'npx', ['cap', 'sync', 'android']);
run(process.execPath, [path.join(ROOT, 'scripts', 'verify-worklets.js'), '--require-build', '--require-android']);
run(process.execPath, [path.join(ROOT, 'scripts', 'verify-android-complete.mjs')]);
function publishArtifact(source, outName) {
  const distDir = path.join(ROOT, 'dist', 'android');
  fs.mkdirSync(distDir, { recursive: true });
  const dest = path.join(distDir, outName);
  fs.copyFileSync(source, dest);
  const hash = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
  fs.writeFileSync(`${dest}.sha256`, `${hash}  ${outName}\n`);
  const mb = (fs.statSync(dest).size / (1024 * 1024)).toFixed(1);
  console.log(`[android] ${outName} → ${dest} (${mb} MB)`);
  console.log(`[android] SHA-256 ${hash}`);
  return dest;
}

const gradleTask = release ? (bundle ? 'bundleRelease' : 'assembleRelease') : 'assembleDebug';
run(path.join(ANDROID, isWin ? 'gradlew.bat' : 'gradlew'), [gradleTask], ANDROID);

if (!release) {
  const apk = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
  if (!fs.existsSync(apk)) {
    console.error('[android] APK not found after assembleDebug');
    process.exit(1);
  }
  publishArtifact(apk, 'VoiceIsolate-Pro-android-debug.apk');
  // Keep legacy filename for older scripts/docs.
  fs.copyFileSync(apk, path.join(ROOT, 'dist', 'android', 'VoiceIsolate-Pro-debug.apk'));
  console.log('[android] Sideload: enable Install unknown apps, then open the APK.');
} else if (bundle) {
  const aab = path.join(ANDROID, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab');
  if (!fs.existsSync(aab)) {
    console.error('[android] Signed release AAB was not produced.');
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  publishArtifact(aab, `VoiceIsolate-Pro-${pkg.version}-android-release.aab`);
} else {
  const releaseDir = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'release');
  const apk = path.join(releaseDir, 'app-release.apk');
  const unsigned = path.join(releaseDir, 'app-release-unsigned.apk');
  if (!fs.existsSync(apk)) {
    console.error('[android] Signed release APK was not produced. Refusing app-release-unsigned.apk.');
    if (fs.existsSync(unsigned)) {
      console.error(`[android] Unsigned artifact present: ${unsigned}`);
    }
    process.exit(1);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  publishArtifact(apk, `VoiceIsolate-Pro-${pkg.version}-android-release.apk`);
  console.log('[android] Release APK is signed. It is not the debug sideload asset VoiceIsolate-Pro-android-debug.apk.');
}