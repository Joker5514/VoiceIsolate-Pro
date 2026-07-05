#!/usr/bin/env node
/**
 * Cross-platform static build: public/ + src/ → build/
 * Replaces Unix-only mkdir/cp in package.json for Windows CI/dev.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const PUBLIC = path.join(ROOT, 'public');
const SRC = path.join(ROOT, 'src');

function cpRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) cpRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
}

if (fs.existsSync(BUILD)) fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });
cpRecursive(PUBLIC, BUILD);
const buildSrc = path.join(BUILD, 'src');
if (fs.existsSync(buildSrc)) fs.rmSync(buildSrc, { recursive: true, force: true });
cpRecursive(SRC, buildSrc);
console.log('[build] Copied public/ + src/ → build/');