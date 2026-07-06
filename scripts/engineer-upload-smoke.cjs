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
    await page.waitForFunction(
      () => {
        const splash = document.getElementById('bootSplash');
        const splashGone = !splash
          || splash.dataset.dismissed === '1'
          || splash.classList.contains('is-complete')
          || splash.style.display === 'none';
        return splashGone && !!window._vipApp && !!document.getElementById('fileInput');
      },
      null,
      { timeout: 20000 },
    );

    // Browse Files — prefer real filechooser; headless may skip the event.
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
    await page.locator('#fileBtn').click();
    const fileChooser = await chooserPromise;
    if (fileChooser) {
      await fileChooser.setFiles(wavPath);
    } else {
      await page.setInputFiles('#fileInput', wavPath);
      await page.locator('#fileInput').dispatchEvent('change');
    }

    await page.waitForFunction(
      () => window._vipApp?.inputBuffer?.length > 0,
      null,
      { timeout: 30000 }
    );

    const state = await page.evaluate(() => ({
      hasBuffer: Boolean(window._vipApp?.inputBuffer?.length),
      fileInfo: document.getElementById('fileInfo')?.textContent || '',
      processEnabled: !document.getElementById('processBtn')?.disabled,
    }));

    if (!state.hasBuffer) fails.push('inputBuffer not loaded');
    if (!state.processEnabled) fails.push('processBtn still disabled after load');
    if (!state.fileInfo.includes('vip-engineer-smoke')) fails.push(`fileInfo unexpected: ${state.fileInfo}`);

    console.log('  ✓ audio upload via Browse → inputBuffer loaded');
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