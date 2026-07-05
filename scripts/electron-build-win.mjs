#!/usr/bin/env node
/**
 * Windows Electron unpacked build (unsigned test artifact).
 * Skips code-sign tooling that requires symlink privileges on Windows.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const dirOnly = process.argv.includes('--dir');

const env = {
  ...process.env,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
    env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('pnpm', ['run', 'build']);

const builderArgs = [
  'electron-builder',
  '--config',
  'electron/electron-builder.yml',
];
if (dirOnly) builderArgs.push('--dir');

run('pnpm', ['exec', ...builderArgs]);

if (dirOnly) {
  const exe = path.join(ROOT, 'dist', 'electron', 'win-unpacked', 'VoiceIsolate Pro.exe');
  console.log(`[electron] Unpacked app → ${exe}`);
}