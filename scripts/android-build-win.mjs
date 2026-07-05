#!/usr/bin/env node
/**
 * Windows Android debug APK build.
 * Uses JDK 21 when the system default is too new for Gradle (e.g. Java 25).
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = path.join(ROOT, 'android');
const isWin = process.platform === 'win32';

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

function run(cmd, args, cwd = ROOT) {
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: isWin,
    env: buildEnv,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const jdk21 = findJdk21();
const sdkHome = process.env.ANDROID_HOME || path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
const buildEnv = {
  ...process.env,
  ANDROID_HOME: sdkHome,
  ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT || sdkHome,
};

if (jdk21) {
  buildEnv.JAVA_HOME = jdk21;
  const sep = path.delimiter;
  buildEnv.PATH = `${path.join(jdk21, 'bin')}${sep}${buildEnv.PATH || ''}`;
  console.log(`[android] Using JAVA_HOME=${jdk21}`);
} else {
  console.warn('[android] JDK 21 not found — set VIP_JAVA_HOME or install Temurin 21 to C:\\Users\\<you>\\.jdks\\temurin-21');
}

run('pnpm', ['run', 'build']);
run('npx', ['cap', 'sync', 'android']);
run(path.join(ANDROID, 'gradlew.bat'), ['assembleDebug'], ANDROID);

const apk = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const distDir = path.join(ROOT, 'dist', 'android');
if (fs.existsSync(apk)) {
  fs.mkdirSync(distDir, { recursive: true });
  fs.copyFileSync(apk, path.join(distDir, 'VoiceIsolate-Pro-debug.apk'));
  console.log(`[android] APK → ${path.join(distDir, 'VoiceIsolate-Pro-debug.apk')}`);
}