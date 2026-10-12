'use strict';

/**
 * Service-worker precache list + cache generation, from the served tree.
 *
 * One rule set for every build (build.mjs → build/, vercel-build.js →
 * public/ + public/src/) so offline coverage is the served code graph, not a
 * hand-kept list (the old APP_SHELL covered /app only while a real session
 * executes ~180 URLs, 106 of them under /src). The generation hashes every
 * served non-model file, so any content change yields a new worker script;
 * the old native build hashed six files and Vercel never re-stamped at all.
 *
 * Precached: code and small static assets (HTML, JS, CSS, JSON, SVG, fonts,
 * icons). Not precached: ONNX models (MLWorker's integrity-checked IndexedDB
 * cache owns them), ORT .wasm binaries (13–26 MB each; runtime-cached on first
 * use), media, source maps, docs, and anything over 1 MiB.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PRECACHE_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.woff2', '.woff', '.ico', '.png', '.jpg', '.webmanifest']);
const MAX_PRECACHE_BYTES = 1024 * 1024;
const MODEL_DIR = '/app/models/';
// Mirrors .vercelignore: a precached URL that is not deployed fails every install.
const NOT_DEPLOYED = /\.(test|spec)\.js$|\/__tests__\/|\.scratch\.|\.bak$|\.tmp$|\/design-test\.html$/;

function walk(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    const url = `${base}/${e.name}`;
    if (e.isDirectory()) walk(abs, url, out);
    else if (e.isFile()) out.push({ url, abs });
  }
  return out;
}

/**
 * Served files as { url, abs }, sorted by URL.
 * @param {{ root: string, srcDir?: string|null }} opts root is the web root;
 *   srcDir, when the tree does not already contain src/, is served at /src.
 */
function servedFiles({ root, srcDir = null }) {
  const files = walk(root, '', []);
  if (srcDir) {
    const seen = new Set(files.map((f) => f.url));
    for (const f of walk(srcDir, '/src', [])) if (!seen.has(f.url)) files.push(f);
  }
  return files.filter((f) => f.url !== '/app/sw.js' && f.url !== '/sw.js' && !NOT_DEPLOYED.test(f.url))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}

function isPrecached({ url, abs }) {
  if (url.startsWith(MODEL_DIR)) return false;
  if (!PRECACHE_EXT.has(path.extname(url).toLowerCase())) return false;
  return fs.statSync(abs).size <= MAX_PRECACHE_BYTES;
}

/**
 * @returns {{ cacheVersion: string, precacheUrls: string[] }}
 */
function computePrecache(opts) {
  const files = servedFiles(opts);
  const hash = crypto.createHash('sha256');
  for (const f of files) {
    if (f.url.startsWith(MODEL_DIR)) continue;
    hash.update(f.url).update('\0').update(fs.readFileSync(f.abs)).update('\0');
  }
  return {
    cacheVersion: `vip-app-${hash.digest('hex').slice(0, 12)}`,
    precacheUrls: files.filter(isPrecached).map((f) => f.url),
  };
}

/**
 * Rewrite CACHE_VERSION and PRECACHE_URLS in a service worker in place.
 * @param {string} swPath
 * @param {{ cacheVersion: string, precacheUrls: string[] }} manifest
 */
function stampServiceWorker(swPath, manifest) {
  fs.writeFileSync(swPath, stampSource(fs.readFileSync(swPath, 'utf8'), manifest, swPath));
}

/** Pure form of stampServiceWorker for an in-memory worker source. */
function stampSource(src, { cacheVersion, precacheUrls }, label = 'sw.js') {
  const versionRe = /const CACHE_VERSION\s*=\s*'[^']*';/;
  const listRe = /const PRECACHE_URLS\s*=\s*\[[\s\S]*?\];/;
  if (!versionRe.test(src) || !listRe.test(src)) {
    throw new Error(`[sw-precache] ${label} has no CACHE_VERSION / PRECACHE_URLS to stamp`);
  }
  return src
    .replace(versionRe, `const CACHE_VERSION = '${cacheVersion}';`)
    .replace(listRe, `const PRECACHE_URLS = ${JSON.stringify(precacheUrls, null, 2)};`);
}

module.exports = { servedFiles, computePrecache, stampServiceWorker, stampSource, isPrecached, MAX_PRECACHE_BYTES };
