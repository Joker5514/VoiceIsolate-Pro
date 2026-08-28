#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const http = require('http');
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
      http.get(`${base}/`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
      }).on('error', retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error('server did not start'));
      else setTimeout(ping, 250);
    };
    ping();
  });
}

(async () => {
  const { chromium } = require('playwright');
  const PORT = await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const fail = [];
  const check = (ok, msg) => {
    if (ok) console.log(`  ✓ ${msg}`);
    else {
      console.log(`  ✗ ${msg}`);
      fail.push(msg);
    }
  };

  try {
    await waitForServer(BASE);
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    check(await page.locator('#fileInput').count() === 1, 'landing fileInput');
    check(await page.locator('#processBtn').count() === 1, 'landing processBtn');
    check(await page.locator('#waveCanvas').count() === 1, 'landing waveCanvas');
    check(await page.getByRole('heading', { name: /Clean voice/i }).count() >= 1, 'landing hero');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    check(await page.locator('#processBtn').count() === 1, 'mobile landing processBtn');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
    await page.waitForTimeout(800);
    check(await page.locator('#processBtn').count() === 1, 'studio processBtn');
    check(await page.locator('#fileInput').count() === 1, 'studio fileInput');
    check(await page.locator('[data-hero-tier="creator"]').count() === 1, 'Quick tier pill');
await page.click('[data-hero-tier="creator"]', { timeout: 3000 });
    await page.waitForTimeout(200);
    const tier = await page.evaluate(() => document.getElementById('vipHero')?.dataset.workflowTier);
    check(tier === 'creator', `Quick maps to creator (got ${tier})`);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(600);
    check(await page.locator('#psFieldNav').count() === 1, 'field nav present');

    const cspish = consoleErrors.filter((t) => /Content Security Policy|Refused to/i.test(t));
    check(cspish.length === 0, `no CSP console errors (${cspish.slice(0, 3).join(' | ')})`);

    await browser.close();
  } catch (err) {
    fail.push(String(err && err.stack || err));
    console.error(err);
  } finally {
    server.kill();
  }

  console.log(fail.length ? `\nFAILED ${fail.length}` : '\nPrecision Studio UI smoke: ALL CHECKS PASSED');
  process.exit(fail.length ? 1 : 0);
})();
