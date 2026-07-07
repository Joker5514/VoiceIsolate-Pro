/**
 * Live browser smoke test — exercises the active playback AudioWorklets
 * (GateProcessor + DeEsserProcessor) against a running dev server.
 *
 * Opt-in: requires dev server on PORT and Playwright Chromium.
 *   pnpm dev &
 *   VIP_RUN_INTEGRATION=1 pnpm test -- tests/worklet-integration.test.js
 */

'use strict';

/* global window */

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const INTEGRATION_OPT_IN = process.env.VIP_RUN_INTEGRATION === '1';

const WORKLET_URLS = [
  '/src/workers/GateProcessor.js',
  '/src/workers/DeEsserProcessor.js',
  '/app/dsp-processor.js',
];

function probeServer(port) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/', method: 'HEAD', timeout: 1000,
    }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function fetchWorklet(url) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: url, method: 'GET', timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

describe('Worklet Integration Verification', () => {
  let browser;
  let serverReachable = false;
  let chromiumAvailable = false;

  beforeAll(async () => {
    serverReachable = await probeServer(PORT);
    if (!serverReachable) {
      console.warn(`[worklet-integration] dev server not reachable at 127.0.0.1:${PORT} — skipping live integration test.`);
      return;
    }
    try {
      browser = await chromium.launch({
        args: [
          '--no-sandbox',
          '--enable-features=SharedArrayBuffer',
          '--autoplay-policy=no-user-gesture-required',
        ],
      });
      chromiumAvailable = true;
    } catch (err) {
      console.warn('[worklet-integration] Playwright Chromium unavailable — skipping:', err.message);
    }
  }, 20000);

  afterAll(async () => {
    if (browser) await browser.close();
  });

  test('dev server serves all three worklet scripts with registerProcessor', async () => {
    if (!INTEGRATION_OPT_IN) {
      console.warn('[worklet-integration] VIP_RUN_INTEGRATION=1 not set — skipping.');
      return;
    }
    if (!serverReachable) return;

    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/worklet-manifest.json'), 'utf8'));
    for (const entry of manifest.worklets) {
      const { status, body } = await fetchWorklet(entry.url);
      expect(status).toBe(200);
      expect(body).toContain(`registerProcessor('${entry.processorName}'`);
    }
  });

  test('PlaybackMixer loads gate + de-esser worklets in Chromium', async () => {
    if (!INTEGRATION_OPT_IN) {
      console.warn('[worklet-integration] VIP_RUN_INTEGRATION=1 not set — skipping.');
      return;
    }
    if (!serverReachable || !chromiumAvailable) return;

    const page = await browser.newPage();
    const consoleMsgs = [];
    page.on('console', (m) => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', (e) => consoleMsgs.push(`[pageerror] ${e.message}`));

    try {
      await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' });

      const result = await page.evaluate(async () => {
        const { PlaybackMixer } = await import('/src/pipeline/PlaybackMixer.js');
        const mixer = new PlaybackMixer();
        await mixer.workletsReady();
        const status = mixer.getWorkletStatus();
        await mixer.dispose();
        return status;
      });

      expect(result.gate.state).toBe('loaded');
      expect(result.gate.node).toBe(true);
      expect(result.deEsser.state).toBe('loaded');
      expect(result.deEsser.node).toBe(true);
    } catch (err) {
      console.error('Worklet integration test failed. Recent browser console messages:');
      consoleMsgs.forEach((m) => console.error(m));
      throw err;
    }
  }, 30000);
});