#!/usr/bin/env node
/**
 * Reproduce landing-page progress stalls on longer audio.
 * Usage: node scripts/debug-progress-stall.cjs [seconds]
 */
'use strict';

/* global document — used only inside page.evaluate */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SECS = Number(process.argv[2] || 120);

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
      const req = http.get(`${base}/`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error('server timeout'));
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
    const t = i / sr;
    const voice =
      0.35 * Math.sin(2 * Math.PI * 220 * t) +
      0.18 * Math.sin(2 * Math.PI * 440 * t) +
      0.08 * Math.sin(2 * Math.PI * 880 * t);
    const noise = 0.22 * (Math.random() * 2 - 1);
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round((voice + noise) * 32767 * 0.8)));
  }
  const data = Buffer.from(pcm.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 4, 28);
  header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  const file = path.join(os.tmpdir(), `vip-debug-${secs}s.wav`);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

async function main() {
  const wavPath = makeWav(SECS);
  const PORT = await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`\n[debug] ${SECS}s stereo WAV → ${BASE}\n`);

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
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e}`));

  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    const t = document.getElementById('statusText')?.textContent || '';
    return t.includes('Idle');
  }, null, { timeout: 30000 });

  await page.setInputFiles('#fileInput', wavPath);
  await page.locator('#fileInput').dispatchEvent('change');

  const deadline = Date.now() + Math.max(300_000, SECS * 4000);
  let lastPct = -1;
  let lastChange = Date.now();
  let stallAt = null;
  let maxPct = 0;
  let sawPast88 = false;

  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const status = (document.getElementById('statusText')?.textContent || '').trim();
      const loader = document.getElementById('procLoaderMount');
      const pctMatch = loader?.textContent?.match(/(\d+)%/);
      const pct = pctMatch ? Number(pctMatch[1]) : null;
      const hidden = loader?.hidden ?? true;
      return { status, pct, hidden };
    });

    if (snap.pct != null && snap.pct > maxPct) maxPct = snap.pct;
    if (snap.pct != null && snap.pct > 88) sawPast88 = true;

    if (snap.status.includes('Stems ready')) {
      console.log(`✓ Completed — status: ${snap.status} (maxPct=${maxPct})`);
      if (!sawPast88 && maxPct >= 80) {
        console.error('✗ Completed but progress never advanced past 88% (desktop freeze regression)');
        await browser.close();
        cleanup();
        process.exit(4);
      }
      await browser.close();
      cleanup();
      return;
    }
    if (snap.status.toLowerCase().includes('failed') || snap.status.toLowerCase().includes('error')) {
      console.error(`✗ Failed — status: ${snap.status}`);
      console.error(logs.slice(-10).join('\n'));
      await browser.close();
      cleanup();
      process.exit(1);
    }

    if (snap.pct != null && snap.pct !== lastPct) {
      console.log(`  progress ${snap.pct}% — ${snap.status}`);
      lastPct = snap.pct;
      lastChange = Date.now();
      stallAt = null;
    } else if (!snap.hidden && snap.pct != null) {
      const idleMs = Date.now() - lastChange;
      if (idleMs > 45_000 && stallAt == null) stallAt = snap.pct;
      // Explicit 86–89% stall is the historical desktop/Android freeze band.
      const stallLimit = (snap.pct >= 86 && snap.pct <= 89) ? 35_000 : 60_000;
      if (idleMs > stallLimit) {
        console.error(`✗ STALL at ${snap.pct}% for ${Math.round(idleMs / 1000)}s`);
        console.error(`  status: ${snap.status}`);
        console.error(logs.slice(-15).join('\n'));
        await browser.close();
        cleanup();
        process.exit(2);
      }
    }

    await page.waitForTimeout(2000);
  }

  console.error('✗ Timed out waiting for completion');
  await browser.close();
  cleanup();
  process.exit(3);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});