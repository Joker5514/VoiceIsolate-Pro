#!/usr/bin/env node
/**
 * Isolation-stage benchmark — mono vs stereo, stage timings, ONNX batch estimate.
 * Usage: node scripts/bench-isolation-speed.cjs [seconds]
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

function makeWav(secs, channels = 1) {
  const sr = 48000;
  const n = sr * secs;
  const pcm = new Int16Array(n * channels);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * t) * 16000);
    for (let ch = 0; ch < channels; ch++) {
      pcm[i * channels + ch] = sample;
    }
  }
  const data = Buffer.from(pcm.buffer);
  const header = Buffer.alloc(44);
  const blockAlign = channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sr, 24);
  header.writeUInt32LE(sr * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  const label = channels === 1 ? 'mono' : `stereo`;
  const file = path.join(os.tmpdir(), `vip-isolate-${secs}s-${label}.wav`);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

async function runCase(browser, BASE, wavPath, label) {
  const page = await browser.newPage();
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  const start = Date.now();
  await page.setInputFiles('#fileInput', wavPath);
  await page.locator('#fileInput').dispatchEvent('change');

  const deadline = start + Math.max(180_000, SECS * 8000);
  while (Date.now() < deadline) {
    const snap = await page.evaluate(() => ({
      status: (document.getElementById('statusText')?.textContent || '').trim(),
    }));
    if (snap.status.includes('Stems ready')) {
      const elapsed = Date.now() - start;
      const timings = await page.evaluate(() => window.__vipStageTimings || {});
      await page.close();
      return { label, elapsed, timings };
    }
    if (/failed|error/i.test(snap.status) && !snap.status.includes('Idle')) {
      await page.close();
      throw new Error(`${label} failed: ${snap.status}`);
    }
    await page.waitForTimeout(500);
  }
  await page.close();
  throw new Error(`${label} deadline exceeded`);
}

function estimateOnnxRuns(secs, channels, batchFrames = 96) {
  const samples = secs * 48000;
  const hop = 1024;
  const fft = 4096;
  const frames = Math.max(1, Math.ceil(Math.max(0, samples - fft) / hop) + 1);
  const runsPerChannel = Math.ceil(frames / batchFrames);
  return { frames, runsPerChannel, totalRuns: runsPerChannel * channels };
}

async function main() {
  const monoPath = makeWav(SECS, 1);
  const stereoPath = makeWav(SECS, 2);
  const PORT = await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;

  console.log(`\n[isolate-bench] ${SECS}s BS-RNN isolation @ ${BASE}\n`);

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

  const mono = await runCase(browser, BASE, monoPath, 'mono');
  const stereo = await runCase(browser, BASE, stereoPath, 'stereo');

  await browser.close();
  cleanup();

  const est = estimateOnnxRuns(SECS, 1);
  const estStereo = estimateOnnxRuns(SECS, 2);

  console.log('── Results ─────────────────────────────────────');
  for (const r of [mono, stereo]) {
    console.log(`  ${r.label}: ${(r.elapsed / 1000).toFixed(2)}s total`);
    console.log(`    timings: ${JSON.stringify(r.timings)}`);
  }
  console.log('\n── ONNX run estimate (batch=96) ────────────────');
  console.log(`  mono:   ${est.totalRuns} runs (${est.frames} STFT frames)`);
  console.log(`  stereo: ${estStereo.totalRuns} runs`);
  if (mono.timings.isolate && stereo.timings.isolate) {
    const ratio = (stereo.timings.isolate / mono.timings.isolate).toFixed(2);
    console.log(`\n  stereo/mono isolate ratio: ${ratio}x`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });