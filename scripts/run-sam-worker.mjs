#!/usr/bin/env node
/**
 * Launch SAM worker with Desktop venv python when available.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(ROOT, 'services', 'sam-audio', 'server.py');
const pointer = path.join(ROOT, 'services', 'sam-audio', '.python-path');

let python = process.env.SAM_AUDIO_PYTHON || process.env.PYTHON || '';
if (!python && fs.existsSync(pointer)) {
  python = fs.readFileSync(pointer, 'utf8').trim();
}
if (!python) {
  python = process.platform === 'win32' ? 'python' : 'python3';
}

const port = process.env.SAM_AUDIO_PORT || '8765';
const child = spawn(python, [script, '--host', '127.0.0.1', '--port', String(port)], {
  cwd: ROOT,
  env: {
    ...process.env,
    SAM_AUDIO_MODE: process.env.SAM_AUDIO_MODE || 'local-worker',
    SAM_AUDIO_HOST: '127.0.0.1',
    SAM_AUDIO_PORT: String(port),
  },
  stdio: 'inherit',
});
child.on('exit', (code) => process.exit(code ?? 0));
