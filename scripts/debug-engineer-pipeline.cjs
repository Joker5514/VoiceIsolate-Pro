#!/usr/bin/env node
/**
 * Engineer Mode end-to-end pipeline debugger — decode → ML → completion.
 * Usage: node scripts/debug-engineer-pipeline.cjs [seconds]
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const SECS = Number(process.argv[2] || 30);

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
  const file = path.join(os.tmpdir(), `vip-eng-pipeline-${secs}s.wav`);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

async function ensureAppReady(page) {
  await page.waitForFunction(
    () => typeof window._vipApp?.handleFile === 'function',
    null,
    { timeout: 30000 },
  );
  await page.evaluate(() => {
    window._vipApp?._dismissBootSplash?.();
    const splash = document.getElementById('bootSplash');
    if (splash) {
      splash.dataset.dismissed = '1';
      splash.style.display = 'none';
      splash.style.pointerEvents = 'none';
    }
  });
}

async function main() {
  const wavPath = makeWav(SECS);
  const PORT = await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`\n[engineer-pipeline-debug] ${SECS}s test @ ${BASE}/app/\n`);

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

  await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
  await ensureAppReady(page);

  const fileBuf = fs.readFileSync(wavPath);
  const fileName = path.basename(wavPath);
  await page.evaluate(async ({ bytes, name }) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });
    const file = new File([blob], name, { type: 'audio/wav' });
    await window._vipApp.handleFile(file);
  }, { bytes: [...fileBuf], name: fileName });

  const start = Date.now();
  let lastPct = -1;
  let stallMs = 0;
  const deadline = start + Math.max(300_000, SECS * 12000);

  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => {
      const status = (document.getElementById('hStatus')?.textContent || '').trim();
      const pctEl = document.querySelector('.pipe-pct, #pipePct, [data-pipe-pct]');
      const pctText = document.getElementById('pipeDetail')?.closest('.pipe-row')?.textContent || '';
      const pctMatch = pctText.match(/(\d+)%/) || document.body.textContent.match(/Pipeline\s+(\d+)%/);
      const pct = pctMatch ? Number(pctMatch[1]) : null;
      const detail = (document.getElementById('pipeDetail')?.textContent || '').trim();
      return {
        status,
        pct,
        detail,
        whisperMode: window.VIP_PARAMS?.whisperMode,
        mlOk: window._vipApp?._mlIsolationSucceeded,
        timings: window.__vipStageTimings || {},
      };
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    if (snap.pct !== lastPct || snap.detail) {
      console.log(`  [${elapsed}s] ${snap.pct ?? '—'}% | ${snap.status} | ${snap.detail || '—'} | wm=${snap.whisperMode} ml=${snap.mlOk}`);
      lastPct = snap.pct;
      stallMs = 0;
    } else if (snap.status === 'PROCESSING') {
      stallMs += 1000;
      if (stallMs >= 30_000) {
        console.error(`\n✗ STALL during PROCESSING for ${stallMs / 1000}s`);
        console.error('  timings:', snap.timings);
        await browser.close();
        cleanup();
        process.exit(2);
      }
    }

    if (snap.status === 'DONE') {
      console.log(`\n✓ Engineer pipeline complete in ${elapsed}s`);
      console.log('  Stage timings (ms):', snap.timings);
      console.log(`  whisperMode=${snap.whisperMode} mlIsolation=${snap.mlOk}`);
      await browser.close();
      cleanup();
      return;
    }
    if (snap.status === 'ERROR') {
      console.error('\n✗ Pipeline error');
      console.error('  timings:', snap.timings);
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