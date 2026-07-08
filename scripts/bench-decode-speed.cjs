#!/usr/bin/env node
/**
 * Decode speed benchmark — fails if ingest decode phase exceeds realtime/4.
 * Usage: node scripts/bench-decode-speed.cjs [seconds]
 */
'use strict';

/* global document */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SECS = Number(process.argv[2] || 60);
/** Decode must finish faster than this fraction of source duration. */
const MAX_DECODE_RATIO = 0.25;

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

function waitForServer(base) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(`${base}/`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > 20000) reject(new Error('server timeout'));
      else setTimeout(ping, 250);
    };
    ping();
  });
}

function makeWav(secs) {
  const sr = 48000;
  const n = sr * secs;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000);
  }
  const data = Buffer.from(pcm.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  const file = path.join(os.tmpdir(), `vip-bench-${secs}s.wav`);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

async function main() {
  const wav = makeWav(SECS);
  const PORT = await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const budgetMs = SECS * 1000 * MAX_DECODE_RATIO;

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } };
  process.on('exit', cleanup);
  await waitForServer(BASE);

  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();

  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  const t0 = Date.now();
  await page.setInputFiles('#fileInput', wav);
  await page.locator('#fileInput').dispatchEvent('change');

  await page.waitForFunction(() => {
    const loader = document.getElementById('procLoaderMount');
    const pct = loader?.textContent?.match(/(\d+)%/)?.[1];
    return pct != null && Number(pct) >= 20;
  }, null, { timeout: Math.max(120_000, budgetMs * 2) });

  const decodeMs = Date.now() - t0;
  await browser.close();
  cleanup();

  console.log(`[bench-decode] ${SECS}s WAV — decode phase ${(decodeMs / 1000).toFixed(2)}s (budget ${(budgetMs / 1000).toFixed(1)}s)`);

  if (decodeMs > budgetMs) {
    console.error(`✗ Decode too slow: ${decodeMs}ms > ${budgetMs}ms`);
    process.exit(1);
  }
  console.log('✓ Decode speed OK');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});