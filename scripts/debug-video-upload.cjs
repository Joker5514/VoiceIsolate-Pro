#!/usr/bin/env node
/**
 * Video upload pipeline debugger — creates a short MP4 and drives the landing page.
 */
'use strict';

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SECS = Number(process.argv[2] || 15);

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

function makeMp4(secs) {
  const wav = path.join(os.tmpdir(), 'vip-vid-src.wav');
  const mp4 = path.join(os.tmpdir(), `vip-vid-${secs}s.mp4`);
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
  } catch {
    return null;
  }
  execSync(
    `ffmpeg -y -f lavfi -i sine=frequency=440:duration=${secs} -f lavfi -i color=c=black:s=320x240:d=${secs} ` +
    `-c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "${mp4}"`,
    { stdio: 'ignore' },
  );
  return fs.existsSync(mp4) ? mp4 : null;
}

async function main() {
  const mp4 = makeMp4(SECS);
  if (!mp4) {
    console.log('ffmpeg not available — skipping video upload debug');
    process.exit(0);
  }

  const PORT = await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`\n[video-debug] ${SECS}s MP4 @ ${BASE}\n`);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const cleanup = () => { try { server.kill('SIGTERM'); } catch {} };
  process.on('exit', cleanup);
  await waitForServer(BASE);

  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error') logs.push(m.text()); });
  page.on('pageerror', (e) => logs.push(String(e)));

  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.setInputFiles('#fileInput', mp4);
  await page.locator('#fileInput').dispatchEvent('change');

  const start = Date.now();
  let lastPct = -1;
  let stallSince = 0;

  while (Date.now() - start < Math.max(300_000, SECS * 10000)) {
    const snap = await page.evaluate(() => {
      const status = (document.getElementById('statusText')?.textContent || '').trim();
      const loader = document.getElementById('procLoaderMount');
      const pct = loader?.textContent?.match(/(\d+)%/)?.[1];
      const stage = loader?.textContent?.split('…')[0]?.trim() || '';
      return { status, pct: pct ? Number(pct) : null, stage, hidden: loader?.hidden ?? true };
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (snap.pct !== lastPct) {
      console.log(`  [${elapsed}s] ${snap.pct ?? '—'}% | ${snap.stage || snap.status}`);
      lastPct = snap.pct;
      stallSince = Date.now();
    } else if (!snap.hidden && snap.pct != null && Date.now() - stallSince > 30_000) {
      console.error(`\n✗ VIDEO STALL at ${snap.pct}% for 30s+`);
      console.error(`  status: ${snap.status}`);
      if (logs.length) console.error('  errors:', logs.join('\n'));
      await browser.close();
      cleanup();
      process.exit(2);
    }

    if (snap.status.includes('Stems ready')) {
      console.log(`\n✓ Video pipeline complete in ${elapsed}s`);
      await browser.close();
      cleanup();
      return;
    }
    if (/failed|error/i.test(snap.status) && !/Idle/i.test(snap.status)) {
      console.error(`\n✗ ${snap.status}`);
      if (logs.length) console.error(logs.join('\n'));
      await browser.close();
      cleanup();
      process.exit(1);
    }

    await page.waitForTimeout(1000);
  }

  console.error('✗ timeout');
  await browser.close();
  cleanup();
  process.exit(3);
}

main().catch((e) => { console.error(e); process.exit(1); });