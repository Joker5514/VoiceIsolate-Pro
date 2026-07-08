#!/usr/bin/env node
/**
 * Engineer Mode — processing + slider calibration smoke test.
 * Usage: node scripts/engineer-calibration-smoke.cjs [seconds]
 */
'use strict';

const { spawn } = require('child_process');
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
    pcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / sr) * 12000);
  }
  const data = Buffer.from(pcm.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  const file = path.join(os.tmpdir(), `vip-eng-cal-${secs}s.wav`);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

async function main() {
  const wavPath = makeWav(SECS);
  const PORT = await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`\n[engineer-cal-smoke] ${SECS}s @ ${BASE}/app/\n`);

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
  await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window._vipApp?.handleFile === 'function', null, { timeout: 30000 });
  await page.evaluate(() => {
    window._vipApp?._dismissBootSplash?.();
    const splash = document.getElementById('bootSplash');
    if (splash) { splash.style.display = 'none'; splash.style.pointerEvents = 'none'; }
  });

  await page.setInputFiles('#fileInput', wavPath);
  await page.locator('#fileInput').dispatchEvent('change');

  const deadline = Date.now() + Math.max(180_000, SECS * 10000);
  while (Date.now() < deadline) {
    const done = await page.evaluate(() => document.getElementById('hStatus')?.textContent?.trim() === 'DONE');
    if (done) break;
    await page.waitForTimeout(500);
  }

  const snap = await page.evaluate(() => {
    const params = window.VIP_PARAMS || {};
    const bridgeIds = window._vipBridgeIds || [];
    return {
      abMode: window._vipApp?.abMode,
      mlOk: window._vipApp?._mlIsolationSucceeded,
      whisperMode: params.whisperMode,
      outGain: params.outGain,
      gateThresh: params.gateThresh,
      eqMid: params.eqMid,
      paramCount: Object.keys(params).length,
      bridgeHandlesOutGain: bridgeIds.includes('outGain'),
      outputBuffer: Boolean(window._vipApp?.outputBuffer),
      sliderCount: document.querySelectorAll('.slider-row input[type="range"]').length,
    };
  });

  console.log('  Snapshot:', snap);

  const failures = [];
  if (snap.abMode !== 'processed') failures.push(`abMode=${snap.abMode} (expected processed)`);
  if (!snap.outputBuffer) failures.push('outputBuffer missing');
  if (snap.paramCount < 50) failures.push(`VIP_PARAMS count ${snap.paramCount} < 50`);
  if (!Number.isFinite(snap.outGain)) failures.push('outGain not calibrated');
  if (!Number.isFinite(snap.gateThresh)) failures.push('gateThresh not calibrated');
  if (snap.sliderCount < 60) failures.push(`slider DOM count ${snap.sliderCount} < 60`);

  await browser.close();
  cleanup();

  if (failures.length) {
    console.error('\n✗ Engineer calibration smoke failed:');
    failures.forEach((f) => console.error('  -', f));
    process.exit(1);
  }
  console.log('\n✓ Engineer processing + calibration smoke passed');
}

main().catch((e) => { console.error(e); process.exit(1); });