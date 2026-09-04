#!/usr/bin/env node
/**
 * Engineer Mode upload smoke — Browse + file decode + video card wiring.
 */
'use strict';

/* global window, document */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function waitForServer(base, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(`${base}/app/`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error('server did not start'));
      else setTimeout(ping, 250);
    };
    ping();
  });
}

async function ensureAppReady(page) {
  await page.waitForFunction(
    () => typeof window._vipApp?.handleFile === 'function' && !!document.getElementById('fileInput'),
    null,
    { timeout: 20000 },
  );
  await page.evaluate(() => {
    window._vipApp?._dismissBootSplash?.();
    const splash = document.getElementById('bootSplash');
    if (splash && splash.dataset.dismissed !== '1') {
      splash.dataset.dismissed = '1';
      splash.style.pointerEvents = 'none';
      splash.style.display = 'none';
    }
  });
}

async function ingestWav(page, wavPath) {
  // Prefer File constructor + handleFile — more reliable than setInputFiles on
  // hidden inputs with long accept= lists across Playwright/Chromium builds.
  const bytes = fs.readFileSync(wavPath);
  await page.evaluate(async (arr) => {
    const u8 = new Uint8Array(arr);
    const file = new File([u8], 'vip-engineer-smoke.wav', { type: 'audio/wav' });
    await window._vipApp.handleFile(file);
  }, [...bytes]);
}

async function readUploadDiag(page) {
  return page.evaluate(() => ({
    hasApp: Boolean(window._vipApp),
    hasHandleFile: typeof window._vipApp?.handleFile === 'function',
    bufferLen: window._vipApp?.inputBuffer?.length ?? 0,
    fileInfo: document.getElementById('fileInfo')?.textContent || '',
    splashDismissed: document.getElementById('bootSplash')?.dataset?.dismissed || '',
    processDisabled: document.getElementById('processBtn')?.disabled ?? true,
  }));
}

function makeWav() {
  const sr = 48000, secs = 1, n = sr * secs;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    pcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * (i / sr)) * 16000);
  }
  const data = Buffer.from(pcm.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  const file = path.join(os.tmpdir(), 'vip-engineer-smoke.wav');
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

(async () => {
  const PORT = Number(process.env.SMOKE_PORT) || await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const wavPath = makeWav();
  const fails = [];

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } };
  process.on('exit', cleanup);

  await waitForServer(BASE);
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
    await ensureAppReady(page);
    await ingestWav(page, wavPath);

    // Upload may remain deferred as _sourceFile or may already be decoded into
    // input/origBuffer. Either state is Process-ready when the button is enabled.
    try {
      await page.waitForFunction(
        () => {
          const app = window._vipApp;
          const hasInput = Boolean(app?._sourceFile || app?.inputBuffer?.length || app?.origBuffer?.length);
          return hasInput && !document.getElementById('processBtn')?.disabled;
        },
        null,
        { timeout: 15000 },
      );
    } catch (waitErr) {
      const diag = await readUploadDiag(page);
      throw new Error(`source not ready for Process: ${JSON.stringify(diag)} (${waitErr.message})`);
    }

    // Exercise Process path: decode + ML isolation must complete without freeze.
    await page.evaluate(() => window._vipApp.runPipeline());
    try {
      await page.waitForFunction(
        () => {
          const app = window._vipApp;
          if (!app) return false;
          if (app.isProcessing) return false;
          const status = (document.getElementById('hStatus')?.textContent || '').trim();
          const out = app.outputBuffer?.length || app.procBuffer?.length || 0;
          return status === 'DONE' || status === 'ERROR' || out > 0;
        },
        null,
        { timeout: 120000 },
      );
    } catch (procErr) {
      const diag = await page.evaluate(() => ({
        status: document.getElementById('hStatus')?.textContent,
        detail: document.getElementById('pipeDetail')?.textContent,
        isProcessing: window._vipApp?.isProcessing,
        inputLen: window._vipApp?.inputBuffer?.length || 0,
        outLen: window._vipApp?.outputBuffer?.length || window._vipApp?.procBuffer?.length || 0,
      }));
      throw new Error(`process did not complete: ${JSON.stringify(diag)} (${procErr.message})`);
    }

    const state = await page.evaluate(() => ({
      hasSource: Boolean(window._vipApp?._sourceFile),
      hasBuffer: Boolean(window._vipApp?.inputBuffer?.length),
      hasOut: Boolean(window._vipApp?.outputBuffer?.length || window._vipApp?.procBuffer?.length),
      fileInfo: document.getElementById('fileInfo')?.textContent || '',
      processEnabled: !document.getElementById('processBtn')?.disabled,
      status: (document.getElementById('hStatus')?.textContent || '').trim(),
      mlOk: window._vipApp?._mlIsolationSucceeded,
    }));

    if (!state.hasSource && !state.hasBuffer) fails.push('no source after upload');
    if (!state.processEnabled && state.status !== 'DONE') fails.push('processBtn still disabled after load');
    if (!state.fileInfo.includes('vip-engineer-smoke')) fails.push(`fileInfo unexpected: ${state.fileInfo}`);
    if (!state.hasBuffer) fails.push('inputBuffer not decoded after Process');
    if (!state.hasOut && state.status !== 'DONE') fails.push('no processed output after Process');
    if (state.status === 'ERROR') fails.push('pipeline ended in ERROR');

    console.log('  ✓ audio upload accepted (deferred or eager decode)');
    console.log('  ✓ Process enabled after upload');
    console.log(`  ✓ Process completed — status=${state.status} ml=${state.mlOk} out=${state.hasOut}`);
    console.log(`  ✓ fileInfo: ${state.fileInfo}`);
  } finally {
    await browser.close();
    cleanup();
  }

  if (errors.length) fails.push(`page errors: ${errors.join(' | ')}`);
  if (fails.length) {
    console.error('\n❌ Engineer upload smoke failed:\n', fails.join('\n'));
    process.exit(1);
  }
  console.log('\n✅ Engineer upload smoke: ALL CHECKS PASSED\n');
})().catch((e) => {
  console.error('[engineer-upload-smoke] fatal:', e);
  process.exit(1);
});