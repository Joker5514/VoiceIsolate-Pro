#!/usr/bin/env node
/**
 * End-to-end pipeline debugger — logs every stage from upload to stems.
 * Usage: node scripts/debug-full-pipeline.cjs [seconds] [audio|video]
 */
'use strict';

/* global document, window, MutationObserver — used only inside page.evaluate */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SECS = Number(process.argv[2] || 30);
const MODE = process.argv[3] || 'audio';

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
    pcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * t) * 16000);
  }
  const data = Buffer.from(pcm.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  const file = path.join(os.tmpdir(), `vip-pipeline-${secs}s.wav`);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

async function main() {
  const wavPath = makeWav(SECS);
  const PORT = await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`\n[pipeline-debug] ${SECS}s ${MODE} test @ ${BASE}\n`);

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } };
  process.on('exit', cleanup);
  await waitForServer(BASE);

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();

  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.evaluate(() => {
    window.__vipTrace = [];
    const push = (msg) => window.__vipTrace.push({ t: Date.now(), msg });
    const orig = console.log;
    console.log = (...a) => { push(a.join(' ')); orig(...a); };

    // Patch decode if loaded later — hook via ingest progress on DOM
    const obs = new MutationObserver(() => {
      const pill = document.getElementById('statusPillMount');
      const loader = document.getElementById('procLoaderMount');
      if (pill || loader) {
        const status = pill?.textContent?.trim() || '';
        const pct = loader?.textContent?.match(/(\d+)%/)?.[1];
        push(`UI status="${status}" pct=${pct ?? 'n/a'} hidden=${loader?.hidden}`);
      }
    });
    const mount = document.getElementById('procLoaderMount');
    if (mount) obs.observe(mount, { childList: true, subtree: true, characterData: true });
    const statusMount = document.getElementById('statusPillMount');
    if (statusMount) obs.observe(statusMount, { childList: true, subtree: true, characterData: true });
  });

  await page.setInputFiles('#fileInput', wavPath);
  await page.locator('#fileInput').dispatchEvent('change');

  const start = Date.now();
  let lastPct = -1;
  let stallMs = 0;
  const deadline = start + Math.max(180_000, SECS * 8000);

  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const status = (document.getElementById('statusText')?.textContent || '').trim();
      const loader = document.getElementById('procLoaderMount');
      const pctMatch = loader?.textContent?.match(/(\d+)%/);
      const pct = pctMatch ? Number(pctMatch[1]) : null;
      const stage = loader?.textContent?.split('…')[0]?.trim() || '';
      return { status, pct, stage, hidden: loader?.hidden ?? true };
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (snap.pct !== lastPct) {
      console.log(`  [${elapsed}s] ${snap.pct ?? '—'}% | ${snap.stage || snap.status}`);
      lastPct = snap.pct;
      stallMs = 0;
    } else if (!snap.hidden && snap.pct != null) {
      stallMs += 1000;
      if (stallMs >= 15_000) {
        console.error(`\n✗ STALL at ${snap.pct}% for ${stallMs / 1000}s`);
        console.error(`  status: ${snap.status}`);
        const trace = await page.evaluate(() => window.__vipTrace?.slice(-20) || []);
        console.error('  trace:', trace);
        await browser.close();
        cleanup();
        process.exit(2);
      }
    }

    if (snap.status.includes('Stems ready')) {
      console.log(`\n✓ Pipeline complete in ${elapsed}s`);
      await browser.close();
      cleanup();
      return;
    }
    if (/failed|error/i.test(snap.status) && !snap.status.includes('Idle')) {
      console.error(`\n✗ Error: ${snap.status}`);
      await browser.close();
      cleanup();
      process.exit(1);
    }

    await page.waitForTimeout(1000);
  }

  console.error('\n✗ Deadline exceeded');
  await browser.close();
  cleanup();
  process.exit(3);
}

main().catch((e) => { console.error(e); process.exit(1); });