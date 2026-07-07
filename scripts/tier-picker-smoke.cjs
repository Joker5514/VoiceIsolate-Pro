#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');
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
      http.get(`${base}/app/`, (res) => {
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
  const PORT = await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });

  try {
    await waitForServer(BASE);
    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
    await page.waitForFunction(
      () => window._vipApp && document.querySelector('[data-hero-tier]'),
      null,
      { timeout: 20000 },
    );
    await page.evaluate(() => window._vipApp._dismissBootSplash());

    await page.click('[data-hero-tier="creator"]');
    await page.waitForTimeout(200);
    const creator = await page.evaluate(() => ({
      tier: document.getElementById('vipHero')?.dataset.workflowTier,
      sceneHidden: document.getElementById('heroSceneRow')?.hidden,
      gridHidden: document.querySelector('.presets-grid')?.hidden,
    }));
    if (creator.tier !== 'creator' || !creator.sceneHidden || !creator.gridHidden) {
      throw new Error(`Creator tier failed: ${JSON.stringify(creator)}`);
    }
    console.log('  ✓ Creator Pro tier hides scene picker and preset grid');

    await page.click('[data-hero-tier="studio"]');
    await page.waitForTimeout(200);
    const studio = await page.evaluate(() => ({
      tier: document.getElementById('vipHero')?.dataset.workflowTier,
      sceneHidden: document.getElementById('heroSceneRow')?.hidden,
    }));
    if (studio.tier !== 'studio' || studio.sceneHidden) {
      throw new Error(`Studio tier failed: ${JSON.stringify(studio)}`);
    }
    console.log('  ✓ Studio tier shows scene preset picker');

    await page.click('[data-hero-tier="forensic"]');
    await page.waitForTimeout(200);
    const forensic = await page.evaluate(() => ({
      tier: document.getElementById('vipHero')?.dataset.workflowTier,
      preset: document.getElementById('presetSel')?.value,
      extremeHidden: document.getElementById('tab-extreme-group')?.hidden,
    }));
    if (forensic.tier !== 'forensic' || forensic.preset !== 'Forensic Extract' || forensic.extremeHidden) {
      throw new Error(`Forensic tier failed: ${JSON.stringify(forensic)}`);
    }
    console.log('  ✓ Forensic tier applies Forensic Extract and shows EXTREME panel');

    await browser.close();
    console.log('\n✅ Tier picker smoke: ALL CHECKS PASSED\n');
  } finally {
    server.kill();
  }
})().catch((err) => {
  console.error('[tier-picker-smoke] fatal:', err.message || err);
  process.exit(1);
});