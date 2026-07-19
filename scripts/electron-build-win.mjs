#!/usr/bin/env node
/**
 * Windows Electron build (unsigned by default).
 * Produces a fully offline desktop package: UI + ONNX models + ORT wasm.
 * Skips code-sign tooling that requires symlink privileges on Windows.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const dirOnly = process.argv.includes('--dir');

const env = {
  ...process.env,
  // Never auto-discover certs for local builds (avoids winCodeSign symlink errors).
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  WIN_CSC_LINK: '',
  CSC_LINK: '',
};

/** Models required for 100% offline default isolation (bsrnn + denoise + VAD). */
const REQUIRED_OFFLINE_MODELS = [
  'bsrnn_vocals.onnx',
  'rnnoise_suppressor.onnx',
  'silero_vad.onnx',
];

function run(cmd, args) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: isWin,
    env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function assertOfflineModels() {
  const modelsDir = path.join(ROOT, 'public', 'app', 'models');
  const missing = REQUIRED_OFFLINE_MODELS.filter(
    (f) => !fs.existsSync(path.join(modelsDir, f)),
  );
  if (missing.length) {
    console.error('[electron] Missing offline models in public/app/models/:');
    for (const f of missing) console.error(`  - ${f}`);
    console.error('[electron] Place ONNX weights before building the desktop installer.');
    process.exit(1);
  }
  console.log('[electron] Offline model check OK:', REQUIRED_OFFLINE_MODELS.join(', '));
}

assertOfflineModels();
run('pnpm', ['run', 'build']);

// Re-check after static build (build.mjs copies public/ → build/)
const builtModels = path.join(ROOT, 'build', 'app', 'models');
for (const f of REQUIRED_OFFLINE_MODELS) {
  if (!fs.existsSync(path.join(builtModels, f))) {
    console.error(`[electron] Model not copied into build/: ${f}`);
    process.exit(1);
  }
}

const builderArgs = [
  'electron-builder',
  '--config',
  'electron/electron-builder.yml',
  '--win',
];
if (dirOnly) builderArgs.push('--dir');

run('pnpm', ['exec', ...builderArgs]);

const dist = path.join(ROOT, 'dist', 'electron');
if (dirOnly) {
  const exe = path.join(dist, 'win-unpacked', 'VoiceIsolate Pro.exe');
  console.log(`[electron] Unpacked offline app → ${exe}`);
  console.log('[electron] Run offline (no network): double-click the .exe');
} else {
  const files = fs.existsSync(dist)
    ? fs.readdirSync(dist).filter((n) => n.endsWith('.exe') || n.endsWith('.msi'))
    : [];
  console.log('[electron] Installer output →', dist);
  for (const f of files) console.log(`  - ${f}`);
  console.log('[electron] Ship the NSIS .exe for downloadable offline install.');
}