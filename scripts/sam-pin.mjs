#!/usr/bin/env node
/**
 * pnpm sam:pin [-- --model ID --revision REV]
 * Runs scripts/sam-pin-weights.py with the SAM venv python (same lookup as
 * run-sam-worker.mjs) to write services/sam-audio/weights.lock.json.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pointer = path.join(ROOT, 'services', 'sam-audio', '.python-path');
const venvPy = path.join(ROOT, '.venv-sam', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

let python = process.env.SAM_AUDIO_PYTHON || process.env.PYTHON || '';
if (!python && fs.existsSync(pointer)) python = fs.readFileSync(pointer, 'utf8').trim();
if (!python && fs.existsSync(venvPy)) python = venvPy;
if (!python) python = process.platform === 'win32' ? 'python' : 'python3';

const r = spawnSync(python, [path.join(ROOT, 'scripts', 'sam-pin-weights.py'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
