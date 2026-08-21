#!/usr/bin/env node
/**
 * Cross-platform static build: public/ + src/ → build/
 * Replaces Unix-only mkdir/cp in package.json for Windows CI/dev.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
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

// Capacitor upgrades retain WebView service-worker storage. Stamp the copied
// worker from the shared Engineer sources so Android cannot keep serving an
// older rack (missing EQ/Whisper controls) after an APK update.
const swPath = path.join(BUILD, 'app', 'sw.js');
const shellInputs = [
  'app/app.js',
  'app/index.html',
  'app/slider-map.js',
  'app/workflow-tier.js',
  'app/whisper-hunter.js',
  'src/presentation/DspSlider.js',
];
const shellHash = crypto.createHash('sha256');
for (const rel of shellInputs) shellHash.update(fs.readFileSync(path.join(BUILD, rel)));
const cacheVersion = `vip-app-${shellHash.digest('hex').slice(0, 12)}`;
const swSource = fs.readFileSync(swPath, 'utf8').replace(
  /const CACHE_VERSION\s*=\s*'[^']+';/,
  `const CACHE_VERSION    = '${cacheVersion}';`,
);
fs.writeFileSync(swPath, swSource);

console.log(`[build] Copied public/ + src/ → build/ (${cacheVersion})`);
