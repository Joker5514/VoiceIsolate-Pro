#!/usr/bin/env node
/**
 * Install the real Meta SAM-Audio Python package into a local venv used by
 * Desktop Electron + the services/sam-audio worker.
 *
 * Also ensures the vip-sam-runtime package files are present for all platforms.
 *
 * Usage:
 *   node scripts/install-sam-runtime.mjs
 *   node scripts/install-sam-runtime.mjs --skip-pip   # layout only
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const VENV = path.join(ROOT, '.venv-sam');
const skipPip = process.argv.includes('--skip-pip');

function log(msg) {
  console.log(`[sam-runtime] ${msg}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with ${r.status}`);
  }
}

function ensureLayout() {
  const need = [
    'services/sam-audio/server.py',
    'services/sam-audio/requirements.txt',
    'packages/vip-sam-runtime/package.json',
    'packages/vip-sam-runtime/manifest.json',
    'public/app/models/README.md',
  ];
  for (const rel of need) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) {
      throw new Error(`Missing required package file: ${rel}`);
    }
  }
  // Marker so Android/web builds know SAM runtime is part of the product
  const marker = path.join(ROOT, 'public/app/models/sam-runtime.marker.json');
  fs.writeFileSync(
    marker,
    JSON.stringify(
      {
        packageId: 'vip-sam-runtime',
        version: '25.0.1',
        bundled: true,
        platforms: ['web', 'android', 'desktop'],
        worker: 'services/sam-audio/server.py',
        onnxOptional: '/app/models/sam_audio.onnx',
        officialInstall: 'git+https://github.com/facebookresearch/sam-audio.git',
        defaultModel: 'facebook/sam-audio-small',
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  log(`wrote ${path.relative(ROOT, marker)}`);
}

function findPython() {
  const candidates = process.platform === 'win32'
    ? ['py -3.12', 'py -3.11', 'py -3', 'python']
    : ['python3.12', 'python3.11', 'python3', 'python'];
  for (const c of candidates) {
    const parts = c.split(' ');
    const r = spawnSync(parts[0], [...parts.slice(1), '--version'], {
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (r.status === 0) {
      log(`using ${c}: ${(r.stdout || r.stderr || '').trim()}`);
      return c;
    }
  }
  throw new Error('Python 3.11+ not found. Install Python to use real Desktop SAM.');
}

function ensureVenv(pythonCmd) {
  if (!fs.existsSync(VENV)) {
    log('creating .venv-sam …');
    const parts = pythonCmd.split(' ');
    run(parts[0], [...parts.slice(1), '-m', 'venv', VENV]);
  }
  const pip = process.platform === 'win32'
    ? path.join(VENV, 'Scripts', 'pip.exe')
    : path.join(VENV, 'bin', 'pip');
  const py = process.platform === 'win32'
    ? path.join(VENV, 'Scripts', 'python.exe')
    : path.join(VENV, 'bin', 'python');
  return { pip, py };
}

function installSam(py, pip) {
  log('upgrading pip …');
  // Must use python -m pip to upgrade pip itself on Windows.
  run(py, ['-m', 'pip', 'install', '-U', 'pip', 'wheel', 'setuptools']);
  log('installing official sam-audio from GitHub …');
  // May take several minutes; requires network + git.
  run(py, ['-m', 'pip', 'install', 'git+https://github.com/facebookresearch/sam-audio.git']);
  log('installing worker extras (numpy) …');
  run(py, ['-m', 'pip', 'install', '-r', path.join('services', 'sam-audio', 'requirements.txt')]);
  log('REAL sam-audio package installed into .venv-sam');
  log('Next: hf auth login  (after Meta HF access approval)');
  log('Then: pnpm sam:worker   or Electron samWorkerStart()');
  void pip;
}

function writeDesktopPythonPointer(py) {
  const out = path.join(ROOT, 'services', 'sam-audio', '.python-path');
  fs.writeFileSync(out, py + '\n');
  log(`python path written to ${path.relative(ROOT, out)}`);
  // Electron can read this
  const envExample = path.join(ROOT, 'services', 'sam-audio', '.env.example');
  fs.writeFileSync(
    envExample,
    [
      'SAM_AUDIO_MODE=local-worker',
      'SAM_AUDIO_HOST=127.0.0.1',
      'SAM_AUDIO_PORT=8765',
      'SAM_AUDIO_MODEL=facebook/sam-audio-small',
      'SAM_AUDIO_DEVICE=auto',
      'SAM_AUDIO_REQUIRE_REAL=0',
      `# SAM_AUDIO_PYTHON=${py.replace(/\\/g, '/')}`,
      '',
    ].join('\n'),
  );
}

function main() {
  ensureLayout();
  if (skipPip) {
    log('skip-pip: layout only (package still in program for all 3 platforms)');
    return;
  }
  try {
    const pyCmd = findPython();
    const { pip, py } = ensureVenv(pyCmd);
    installSam(py, pip);
    writeDesktopPythonPointer(py);
  } catch (err) {
    log(`WARNING: pip install failed: ${err.message}`);
    log('Package code is still bundled; run again when Python/network ready.');
    log('Desktop will use mock until real install succeeds; Android/Web use USM/ONNX.');
    process.exitCode = 0; // do not fail builds — package layout is the product guarantee
  }
}

main();
