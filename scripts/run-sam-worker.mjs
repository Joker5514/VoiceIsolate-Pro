#!/usr/bin/env node
/**
 * Launch production SAM worker with Desktop venv python + shared FFmpeg when available.
 *
 * Env:
 *   SAM_AUDIO_PRODUCTION=1  → require real model (default when unset for this script: 0 for dev)
 *   SAM_AUDIO_ALLOW_MOCK=1  → allow deterministic mock (CI/dev)
 *   SAM_AUDIO_PRELOAD=1     → warm-load model at startup
 *   HF_TOKEN / HUGGING_FACE_HUB_TOKEN → gated Meta weights
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(ROOT, 'services', 'sam-audio', 'server.py');
const pointer = path.join(ROOT, 'services', 'sam-audio', '.python-path');
const ffmpegPointer = path.join(ROOT, 'services', 'sam-audio', '.ffmpeg-bin');

let python = process.env.SAM_AUDIO_PYTHON || process.env.PYTHON || '';
if (!python && fs.existsSync(pointer)) {
  python = fs.readFileSync(pointer, 'utf8').trim();
}
if (!python) {
  const venvPy = path.join(
    ROOT,
    '.venv-sam',
    process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
  );
  if (fs.existsSync(venvPy)) python = venvPy;
}
if (!python) {
  python = process.platform === 'win32' ? 'python' : 'python3';
}

function resolveFfmpegBin() {
  if (process.env.VIP_FFMPEG_SHARED_BIN && fs.existsSync(process.env.VIP_FFMPEG_SHARED_BIN)) {
    return process.env.VIP_FFMPEG_SHARED_BIN;
  }
  if (fs.existsSync(ffmpegPointer)) {
    const line = fs.readFileSync(ffmpegPointer, 'utf8').trim();
    if (line && fs.existsSync(line)) return line;
  }
  const tools = path.join(ROOT, '.tools', 'ffmpeg-shared');
  if (!fs.existsSync(tools)) return null;
  const stack = [tools];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    if (ents.some((e) => e.isFile() && /^avcodec/i.test(e.name))) return d;
    for (const e of ents) {
      if (e.isDirectory()) stack.push(path.join(d, e.name));
    }
  }
  return null;
}

const port = process.env.SAM_AUDIO_PORT || '8765';
const production =
  process.env.SAM_AUDIO_PRODUCTION ||
  (process.argv.includes('--production') ? '1' : '0');
const allowMock =
  process.env.SAM_AUDIO_ALLOW_MOCK ||
  (production === '1' ? '0' : '1');
const preload =
  process.env.SAM_AUDIO_PRELOAD ||
  (production === '1' || process.argv.includes('--preload') ? '1' : '0');

const env = {
  ...process.env,
  SAM_AUDIO_MODE: process.env.SAM_AUDIO_MODE || 'local-worker',
  SAM_AUDIO_HOST: '127.0.0.1',
  SAM_AUDIO_PORT: String(port),
  SAM_AUDIO_PRODUCTION: production,
  SAM_AUDIO_ALLOW_MOCK: allowMock,
  SAM_AUDIO_PRELOAD: preload,
  PYTHONPATH: [
    path.join(ROOT, 'services', 'sam-audio'),
    process.env.PYTHONPATH || '',
  ]
    .filter(Boolean)
    .join(path.delimiter),
};

const ffmpegBin = resolveFfmpegBin();
if (ffmpegBin) {
  env.PATH = `${ffmpegBin}${path.delimiter}${env.PATH || ''}`;
  env.VIP_FFMPEG_SHARED_BIN = ffmpegBin;
}

const args = [script, '--host', '127.0.0.1', '--port', String(port)];
if (preload === '1' || process.argv.includes('--preload')) {
  args.push('--preload');
}

console.error(
  `[sam-worker] python=${python} production=${production} allowMock=${allowMock} ffmpeg=${ffmpegBin || 'none'}`,
);

const child = spawn(python, args, {
  cwd: ROOT,
  env,
  stdio: 'inherit',
});
child.on('error', (err) => {
  console.error(`[sam-worker] spawn error: ${err?.message || err}`);
  process.exitCode = 1;
});
child.on('exit', (code) => process.exit(code ?? process.exitCode ?? 0));
