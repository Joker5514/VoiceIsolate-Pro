#!/usr/bin/env node
/**
 * F19 — service-worker offline/update check in real Chromium.
 *
 * Serves public/ + src/ like the static hosts do (COOP/COEP, stamped
 * /app/sw.js), registers the worker through the shipped registerSW(), then
 * takes the server down to go offline. Covers: cold offline launch of both
 * surfaces, cold and warm offline Process, old→new upgrade, a precached asset
 * missing from a deploy, a corrupt cache entry, model replacement and legacy
 * cache cleanup. Nothing leaves localhost.
 *
 *   node scripts/sw-offline-check.cjs [--json]
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const { launchChromium } = require('./lib/launch-chromium.cjs');
const { computePrecache, stampSource } = require('./sw-precache.cjs');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const SRC = path.join(ROOT, 'src');
const JSON_OUT = process.argv.includes('--json');

const base = computePrecache({ root: PUBLIC, srcDir: SRC });
const swSource = fs.readFileSync(path.join(PUBLIC, 'app', 'sw.js'), 'utf8');
const state = { overlay: new Map(), deleted: new Set() };
function manifest() {
  const tag = JSON.stringify([base.cacheVersion, [...state.overlay], [...state.deleted]]);
  return {
    cacheVersion: `vip-app-${crypto.createHash('sha256').update(tag).digest('hex').slice(0, 12)}`,
    precacheUrls: base.precacheUrls,
  };
}

const app = express();
app.use((req, res, next) => {
  res.set({
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-cache',
  });
  next();
});
app.get('/app/sw.js', (_req, res) => res.type('application/javascript').send(stampSource(swSource, manifest())));
app.use((req, res, next) => {
  if (state.deleted.has(req.path)) return res.status(404).end();
  if (state.overlay.has(req.path)) return res.type(path.extname(req.path) || 'html').send(state.overlay.get(req.path));
  return next();
});
app.use('/src', express.static(SRC));
app.use(express.static(PUBLIC));

let server = null;
const sockets = new Set();
let port = 0;
function up() {
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    server.listen(port, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}
function down() {
  return new Promise((resolve) => {
    for (const s of sockets) s.destroy();
    server.close(() => resolve());
  });
}

function writeWav() {
  const n = 48000 * 3;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const v = 0.3 * Math.sin((2 * Math.PI * 220 * i) / 48000) + 0.05 * (seed / 2147483648 - 0.5);
    b.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vip-sw-')), 'tone.wav');
  fs.writeFileSync(file, b);
  return file;
}

const results = [];
function check(ok, name, detail) {
  results.push({ ok: !!ok, name, detail });
  if (!JSON_OUT) console.log(`${ok ? '✓' : '✗'} ${name}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ''}`);
}

async function main() {
  await up();
  const BASE = `http://127.0.0.1:${port}`;
  const wav = writeWav();
  const browser = await launchChromium();
  const ctx = await browser.newContext();
  // Page-level failures only: the worker's own network attempts fail while
  // offline by design and are answered from its cache.
  const failed = [];
  const fromPage = (req) => req.url().startsWith(BASE) && !req.serviceWorker();
  ctx.on('response', (r) => { if (r.status() >= 500 && fromPage(r.request())) failed.push(new URL(r.url()).pathname); });
  ctx.on('requestfailed', (r) => { if (fromPage(r)) failed.push(new URL(r.url()).pathname); });

  const openEngineer = async () => {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof window._vipApp?.handleFile === 'function', null, { timeout: 60000 });
    return page;
  };
  const closeAll = async () => { for (const p of ctx.pages()) await p.close(); };
  // vip-models-v1 is also opened (empty) by model-status-ui.js on every load;
  // generations are the worker's vip-app-* caches.
  const cacheKeys = (page) => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('vip-app-')));
  const processOnce = async (page) => {
    await page.setInputFiles('#fileInput', wav);
    await page.waitForFunction(() => { const b = document.getElementById('processBtn'); return b && !b.disabled; }, null, { timeout: 60000 });
    await page.click('#processBtn');
    let end = 'TIMEOUT';
    for (const t = Date.now(); Date.now() - t < 180000;) {
      end = await page.evaluate(() => document.getElementById('hStatus')?.textContent?.trim() || '');
      if (end === 'DONE' || end === 'ERROR' || end === 'IDLE') break;
      await page.waitForTimeout(500);
    }
    return page.evaluate((status) => {
      const a = window._vipApp;
      const ch = a?.outputBuffer?.getChannelData(0);
      let nonFinite = 0; let peak = 0;
      for (let i = 0; ch && i < ch.length; i++) {
        if (!Number.isFinite(ch[i])) nonFinite++;
        else peak = Math.max(peak, Math.abs(ch[i]));
      }
      return { status, engine: a?._processingEngine, length: ch?.length || 0, nonFinite, peak: +peak.toFixed(4) };
    }, end);
  };

  // ── 1. register through the shipped helper; legacy caches are cleaned ─────
  let page = await openEngineer();
  await page.evaluate(async () => {
    await (await caches.open('vip-models-v1')).put('/app/models/old.onnx', new Response('old model'));
    await (await caches.open('vip-app-3b315dc')).put('/app/app.js', new Response('old app'));
  });
  // `ready` never settles when the all-or-nothing precache install fails, so
  // the wait is bounded and a failed install is reported, not hung on.
  const reg = await page.evaluate(async () => {
    const r = await (await import('/app/sw-register.js')).registerSW();
    const ready = await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise((res) => setTimeout(() => res(false), 60000)),
    ]);
    const w = r?.installing || r?.waiting || r?.active || null;
    return { scope: r?.scope || null, ready, state: w?.state || null, controlled: !!navigator.serviceWorker.controller };
  });
  check(reg.scope === `${BASE}/`, 'registerSW() registers at scope /', reg);
  check(reg.ready, 'the worker installs and activates within 60 s (precache succeeded)', reg);
  if (!reg.ready) throw new Error(`service worker never became ready (state ${reg.state}); later checks need it`);
  const gen1 = manifest().cacheVersion;
  const keys1 = await cacheKeys(page);
  const legacyModel = await page.evaluate(() => caches.match('/app/models/old.onnx').then((r) => !!r));
  check(keys1.length === 1 && keys1[0] === gen1 && !legacyModel, 'activation leaves only the current generation (legacy app + model caches deleted)', keys1);
  const entries = await page.evaluate(async (g) => (await (await caches.open(g)).keys()).map((r) => new URL(r.url).pathname), gen1);
  check(entries.length === base.precacheUrls.length, 'install precached the whole served code graph', { cached: entries.length, expected: base.precacheUrls.length });
  await closeAll();

  // ── 2. cold offline launch (nothing processed yet) ────────────────────────
  await down();
  failed.length = 0;
  page = await ctx.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  const landing = await page.evaluate(() => ({ title: document.title, links: document.querySelectorAll('a').length }));
  check(/VoiceIsolate/i.test(landing.title) && landing.links > 0, 'Landing launches offline', landing);
  page = await openEngineer();
  check(await page.locator('#processBtn').count() === 1, 'Engineer launches offline (app.js ran)');
  const codeFailures = failed.filter((u) => !/\.(onnx|wasm)$/.test(u));
  check(codeFailures.length === 0, 'cold offline launch requested no uncached code', codeFailures);
  const cold = await processOnce(page);
  check(cold.status === 'DONE' && cold.nonFinite === 0 && cold.peak > 1e-4, 'cold offline Process completes with finite, non-silent output', cold);
  await closeAll();

  // ── 3. warm offline: one online Process, then offline ─────────────────────
  await up();
  page = await openEngineer();
  const online = await processOnce(page);
  check(online.status === 'DONE' && online.engine === 'ml', 'online Process runs the ML path', online);
  await closeAll();
  await down();
  page = await openEngineer();
  const warm = await processOnce(page);
  check(warm.status === 'DONE' && warm.engine === 'ml' && warm.nonFinite === 0 && warm.length === online.length,
    'warm offline Process runs the same ML path (wasm runtime-cached, models from MLWorker IDB)', warm);
  await closeAll();

  // ── 4. old → new upgrade ─────────────────────────────────────────────────
  const marker = '\n// sw-offline-check generation 2\n';
  state.overlay.set('/src/pipeline/JobController.js', fs.readFileSync(path.join(SRC, 'pipeline/JobController.js'), 'utf8') + marker);
  const gen2 = manifest().cacheVersion;
  await up();
  page = await openEngineer();
  const waiting = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration('/');
    await r.update();
    for (let i = 0; i < 100 && !r.waiting; i++) await new Promise((s) => setTimeout(s, 100));
    return !!r.waiting;
  });
  check(waiting, 'a new deploy installs a waiting worker (no skipWaiting while a tab is open)');
  await closeAll();
  page = await openEngineer();
  const keys2 = await cacheKeys(page);
  check(keys2.length === 1 && keys2[0] === gen2, 'after the old tabs close the new generation activates and the old one is deleted', keys2);
  await closeAll();
  await down();
  page = await openEngineer();
  const offlineText = await page.evaluate(() => fetch('/src/pipeline/JobController.js').then((r) => r.text()));
  check(offlineText.endsWith(marker), 'offline after the upgrade serves the new code');
  await closeAll();

  // ── 5. a precached asset missing from the deploy ──────────────────────────
  state.deleted.add('/app/visuals.js');
  await up();
  page = await openEngineer();
  const missing = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration('/');
    await r.update().catch(() => {});
    for (let i = 0; i < 100 && (r.installing || r.waiting); i++) await new Promise((s) => setTimeout(s, 100));
    return { waiting: !!r.waiting, keys: (await caches.keys()).filter((k) => k.startsWith('vip-app-')) };
  });
  check(!missing.waiting && missing.keys.length === 1 && missing.keys[0] === gen2,
    'an install with a missing asset fails atomically and the previous generation stays', missing);
  await closeAll();
  await down();
  page = await openEngineer();
  check(await page.locator('#processBtn').count() === 1, 'offline launch still works on the previous generation');
  await closeAll();
  state.deleted.clear();

  // ── 6. corrupt cache entry ────────────────────────────────────────────────
  await up();
  page = await openEngineer();
  await page.evaluate(async (g) => (await caches.open(g)).put('/app/app.js', new Response('corrupt')), gen2);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof window._vipApp?.handleFile === 'function', null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const repaired = await page.evaluate(async (g) => {
    const cached = await (await (await caches.open(g)).match('/app/app.js')).text();
    return { cachedLength: cached.length, corrupt: cached === 'corrupt' };
  }, gen2);
  check(!repaired.corrupt && repaired.cachedLength > 1000, 'a corrupt entry is bypassed online and repaired by the next fetch', repaired);
  await closeAll();

  // ── 7. model replacement ──────────────────────────────────────────────────
  state.overlay.set('/app/models/silero_vad.onnx', 'replacement model bytes');
  page = await openEngineer();
  const model = await page.evaluate(async () => {
    const body = await (await fetch('/app/models/silero_vad.onnx')).text();
    const cachedOnnx = [];
    for (const k of await caches.keys()) {
      for (const r of await (await caches.open(k)).keys()) if (r.url.endsWith('.onnx')) cachedOnnx.push(r.url);
    }
    return { body, cachedOnnx };
  });
  check(model.body === 'replacement model bytes' && model.cachedOnnx.length === 0,
    'models are never cached by the worker, so a replaced model is served as deployed', model.cachedOnnx);
  await closeAll();

  await browser.close();
  await down();
  const failedChecks = results.filter((r) => !r.ok);
  if (JSON_OUT) console.log(JSON.stringify({ ok: failedChecks.length === 0, results }, null, 2));
  else console.log(`\n${results.length - failedChecks.length}/${results.length} checks passed`);
  process.exit(failedChecks.length ? 1 : 0);
}

main().catch((err) => {
  console.error('[sw-offline-check]', err);
  process.exit(2);
});
