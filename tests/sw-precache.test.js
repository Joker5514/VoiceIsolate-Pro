/**
 * F19 — service-worker precache + cache generation (scripts/sw-precache.cjs).
 * Browser behaviour (cold/warm offline, upgrade, missing asset, corrupt cache,
 * model replacement) is driven in Chromium by scripts/sw-offline-check.cjs.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { computePrecache, stampServiceWorker } = require('../scripts/sw-precache.cjs');

const ROOT = path.join(__dirname, '..');

function tree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-sw-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const base = {
  'index.html': '<html>landing</html>',
  'landing.js': 'x',
  'app/index.html': '<html>engineer</html>',
  'app/app.js': 'app',
  'app/sw.js': "const CACHE_VERSION = 'vip-app-dev';\nconst PRECACHE_URLS = [];\n",
  'app/models/bsrnn_vocals.onnx': 'model-v1',
  'lib/ort.min.js': 'ort',
  'lib/ort-wasm-simd-threaded.wasm': 'wasm-v1',
  'lib/ort.min.js.map': 'map',
  'src/pipeline/JobController.js': 'v1',
  'app/hero.mp4': 'video',
  'app/big.js': 'x'.repeat(1024 * 1024 + 1),
  'src/core/foo.test.js': 'test',
};

describe('F19 — precache covers the served code graph', () => {
  test('includes landing, /app and /src code; excludes models, wasm, maps, media, oversize, undeployed', () => {
    const { precacheUrls } = computePrecache({ root: tree(base) });
    expect(precacheUrls).toEqual([
      '/app/app.js', '/app/index.html', '/index.html', '/landing.js', '/lib/ort.min.js',
      '/src/pipeline/JobController.js',
    ]);
  });

  test('src outside the web root is served at /src (Vercel and dev layout)', () => {
    const web = tree({ 'index.html': 'l', 'app/sw.js': '' });
    const src = tree({ 'core/a.js': 'a' });
    expect(computePrecache({ root: web, srcDir: src }).precacheUrls).toEqual(['/index.html', '/src/core/a.js']);
  });

  test('the repository precache is about 6 MiB and holds every worklet and the Engineer entry', () => {
    const { precacheUrls } = computePrecache({ root: path.join(ROOT, 'public'), srcDir: path.join(ROOT, 'src') });
    let bytes = 0;
    for (const u of precacheUrls) {
      bytes += fs.statSync(u.startsWith('/src/') ? path.join(ROOT, u) : path.join(ROOT, 'public', u)).size;
    }
    expect(bytes).toBeLessThan(10 * 1024 * 1024);
    for (const u of ['/index.html', '/landing.js', '/app/index.html', '/app/app.js',
      '/src/workers/MLWorker.js', '/src/pipeline/JobController.js', '/lib/ort.min.js']) {
      expect(precacheUrls).toContain(u);
    }
  });
});

describe('F19 — the generation tracks complete content', () => {
  const gen = (overrides) => computePrecache({ root: tree({ ...base, ...overrides }) }).cacheVersion;

  test('any served file changes it, including ones the old six-file hash ignored', () => {
    const g0 = gen({});
    expect(g0).toMatch(/^vip-app-[0-9a-f]{12}$/);
    expect(gen({})).toBe(g0);
    expect(gen({ 'src/pipeline/JobController.js': 'v2' })).not.toBe(g0);
    expect(gen({ 'app/style.css': 'new file' })).not.toBe(g0);
    expect(gen({ 'lib/ort-wasm-simd-threaded.wasm': 'wasm-v2' })).not.toBe(g0);
  });

  test('model bytes are not part of it (MLWorker keys its cache by manifest sha256)', () => {
    expect(gen({ 'app/models/bsrnn_vocals.onnx': 'model-v2' })).toBe(gen({}));
  });
});

describe('F19 — stamping', () => {
  test('rewrites both markers and refuses a worker without them', () => {
    const dir = tree(base);
    const sw = path.join(dir, 'app/sw.js');
    stampServiceWorker(sw, { cacheVersion: 'vip-app-0123456789ab', precacheUrls: ['/a.js', '/b.css'] });
    const out = fs.readFileSync(sw, 'utf8');
    expect(out).toContain("const CACHE_VERSION = 'vip-app-0123456789ab';");
    expect(out).toMatch(/const PRECACHE_URLS = \[\n {2}"\/a\.js",\n {2}"\/b\.css"\n\];/);
    fs.writeFileSync(sw, 'self.x = 1;');
    expect(() => stampServiceWorker(sw, { cacheVersion: 'v', precacheUrls: [] })).toThrow(/no CACHE_VERSION/);
  });

  test('the committed worker is unstamped and both builds stamp it', () => {
    const sw = fs.readFileSync(path.join(ROOT, 'public/app/sw.js'), 'utf8');
    expect(sw).toContain("const CACHE_VERSION = 'vip-app-dev';");
    expect(sw).toContain('const PRECACHE_URLS = [];');
    expect(fs.readFileSync(path.join(ROOT, 'scripts/vercel-build.js'), 'utf8'))
      .toMatch(/stampServiceWorker\(path\.join\(ROOT, 'public', 'app', 'sw\.js'\)/);
    expect(fs.readFileSync(path.join(ROOT, 'scripts/build.mjs'), 'utf8')).toMatch(/stampServiceWorker\(swPath/);
  });

  test('the worker is network-first, never caches models, and keeps the waiting lifecycle', () => {
    const sw = fs.readFileSync(path.join(ROOT, 'public/app/sw.js'), 'utf8');
    expect(sw).toMatch(/networkFirst\(request, url\)/);
    expect(sw).not.toMatch(/serveModelCacheFirst|serveAppShellCacheFirst/);
    expect(sw).toMatch(/\\\/app\\\/models\\\/\.\+\\\.onnx/);
    expect(sw).toMatch(/cache\.addAll\(/);
    expect(sw).not.toMatch(/skipWaiting\s*\(/);
  });
});
