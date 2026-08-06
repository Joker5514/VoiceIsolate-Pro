#!/usr/bin/env node
/**
 * Production SAM-Audio setup for Desktop (and shared package layout for all platforms).
 *
 * 1. Ensures vip-sam-runtime package layout
 * 2. Downloads shared FFmpeg DLLs (Windows) for torchcodec when possible
 * 3. Creates .venv-sam and installs official facebookresearch/sam-audio
 * 4. Writes services/sam-audio/.python-path
 * 5. Smoke-tests import with torchcodec bootstrap
 *
 * Usage:
 *   node scripts/sam-production-setup.mjs
 *   node scripts/sam-production-setup.mjs --skip-pip
 *   node scripts/sam-production-setup.mjs --skip-ffmpeg
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skipPip = process.argv.includes('--skip-pip');
const skipFfmpeg = process.argv.includes('--skip-ffmpeg');

function log(m) {
  console.log(`[sam-prod] ${m}`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...opts.env },
  });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.status}`);
}

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(dest);
          download(res.headers.location, dest).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
      })
      .on('error', reject);
  });
}

async function ensureFfmpegShared() {
  if (process.platform !== 'win32') {
    log('non-Windows: ensure system FFmpeg shared libs are installed');
    return null;
  }
  const tools = path.join(ROOT, '.tools', 'ffmpeg-shared');
  const existing = findAvcodecBin(tools);
  if (existing) {
    log(`FFmpeg shared bin present: ${existing}`);
    return existing;
  }
  const zip = path.join(tools, 'ffmpeg-shared.zip');
  const url =
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl-shared.zip';
  log('downloading shared FFmpeg (Windows torchcodec dependency)…');
  await download(url, zip);
  // Expand via PowerShell
  run('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Path '${zip.replace(/'/g, "''")}' -DestinationPath '${tools.replace(/'/g, "''")}' -Force`,
  ]);
  const bin = findAvcodecBin(tools);
  if (!bin) throw new Error('FFmpeg shared extract failed — avcodec*.dll not found');
  log(`FFmpeg shared ready: ${bin}`);
  return bin;
}

function findAvcodecBin(root) {
  if (!fs.existsSync(root)) return null;
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    const has = ents.some((e) => e.isFile() && /^avcodec.*\.dll$/i.test(e.name));
    if (has) return d;
    for (const e of ents) {
      if (e.isDirectory()) stack.push(path.join(d, e.name));
    }
  }
  return null;
}

function ensureLayout() {
  run(process.execPath, [path.join(ROOT, 'scripts', 'install-sam-runtime.mjs'), '--skip-pip']);
}

function ensureVenvAndSam(ffmpegBin) {
  const venv = path.join(ROOT, '.venv-sam');
  const pyHost = process.platform === 'win32' ? 'py' : 'python3';
  if (!fs.existsSync(path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))) {
    log('creating .venv-sam …');
    try {
      run(pyHost, ['-3.11', '-m', 'venv', venv]);
    } catch {
      run(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'venv', venv]);
    }
  }
  const py = process.platform === 'win32'
    ? path.join(venv, 'Scripts', 'python.exe')
    : path.join(venv, 'bin', 'python');
  const env = { ...process.env };
  if (ffmpegBin) env.PATH = `${ffmpegBin}${path.delimiter}${env.PATH || ''}`;

  log('pip install sam-audio (official GitHub)…');
  run(py, ['-m', 'pip', 'install', '-U', 'pip', 'wheel', 'setuptools'], { env });
  run(py, ['-m', 'pip', 'install', 'git+https://github.com/facebookresearch/sam-audio.git'], { env });
  run(py, ['-m', 'pip', 'install', '-r', path.join('services', 'sam-audio', 'requirements.txt')], { env });
  // Ensure huggingface_hub present (pulled transitively; re-assert for worker)
  run(py, ['-m', 'pip', 'install', 'huggingface_hub'], { env });

  fs.writeFileSync(path.join(ROOT, 'services', 'sam-audio', '.python-path'), py + '\n');
  if (ffmpegBin) {
    fs.writeFileSync(path.join(ROOT, 'services', 'sam-audio', '.ffmpeg-bin'), ffmpegBin + '\n');
  }
  return { py, env };
}

function smokeImport(py, env) {
  log('smoke: import sam_audio + hub compat…');
  const code = `
import sys
sys.path.insert(0, r${JSON.stringify(path.join(ROOT, 'services', 'sam-audio'))})
from torchcodec_bootstrap import bootstrap_torchcodec
print('torchcodec', bootstrap_torchcodec())
import sam_audio
from sam_audio import SAMAudio, SAMAudioProcessor
from sam_hub_compat import apply_sam_hub_compat
print('hub_compat', apply_sam_hub_compat())
print('IMPORT_OK', sam_audio.__file__)
`;
  const r = spawnSync(py, ['-c', code], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    shell: false,
  });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status !== 0) {
    log('WARNING: import smoke failed — worker may still mock until HF auth / CUDA fixed');
    return false;
  }
  log('IMPORT_OK — real package importable + hub compat patched');
  return true;
}

async function main() {
  ensureLayout();
  let ffmpegBin = null;
  if (!skipFfmpeg) {
    try {
      ffmpegBin = await ensureFfmpegShared();
    } catch (e) {
      log(`FFmpeg setup warning: ${e.message}`);
    }
  }
  if (skipPip) {
    log('skip-pip done');
    return;
  }
  try {
    const { py, env } = ensureVenvAndSam(ffmpegBin);
    if (ffmpegBin) env.PATH = `${ffmpegBin}${path.delimiter}${env.PATH || ''}`;
    env.VIP_FFMPEG_SHARED_BIN = ffmpegBin || '';
    smokeImport(py, env);
    log('Production setup complete.');
    log('If model weights gated: hf auth login');
    log('Start worker:  set SAM_AUDIO_PRODUCTION=1 && pnpm sam:worker');
  } catch (e) {
    log(`ERROR: ${e.message}`);
    process.exitCode = 1;
  }
}

main();
