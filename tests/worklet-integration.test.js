/**
 * Live browser smoke test — exercises the real AudioWorklet + ML Worker boot
 * path inside Chromium against a running dev server.
 *
 * This is an integration test. It is opt-in: it requires (1) the dev server
 * reachable on PORT and (2) Playwright's Chromium executable installed. If
 * either is missing, the test self-skips with a clear console message so it
 * doesn't fail unit-only runs of `pnpm test`.
 *
 * To exercise it explicitly:
 *   pnpm dev &                   # or pnpm start
 *   pnpm exec playwright install
 *   VIP_RUN_INTEGRATION=1 pnpm test -- tests/worklet-integration.test.js
 */

'use strict';

const { chromium } = require('playwright');
const http = require('http');

const PORT = process.env.PORT || 3000;
const INTEGRATION_OPT_IN = process.env.VIP_RUN_INTEGRATION === '1';

function probeServer(port) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/app/', method: 'HEAD', timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
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
        args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--autoplay-policy=no-user-gesture-required']
      });
      chromiumAvailable = true;
    } catch (err) {
      console.warn('[worklet-integration] Playwright Chromium unavailable — skipping live integration test:', err.message);
    }
  }, 20000);

  afterAll(async () => {
    if (browser) await browser.close();
  });

  test('AudioWorklets are loaded correctly in Orchestrator and ML Worker processes', async () => {
    if (!INTEGRATION_OPT_IN) {
      console.warn('[worklet-integration] VIP_RUN_INTEGRATION=1 not set — skipping live integration test.');
      return;
    }
    if (!serverReachable || !chromiumAvailable) {
      // Treat as passing: this is an opt-in integration test.
      return;
    }
    const page = await browser.newPage();
    const consoleMsgs = [];
    page.on('console', m => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => consoleMsgs.push(`[pageerror] ${e.message}`));

    try {
      await page.goto(`http://localhost:${PORT}/app/`);

      // Wait for orchestrator to attach
      await page.waitForFunction(() => window._vipOrch !== undefined, null, { timeout: 10000 });

      // Initializing AudioContext through a simulated click
      await page.click('body');

      // Wait for worklet to be loaded and marked as ready
      const isWorkletReady = await page.waitForFunction(() => {
        return window._vipOrch && window._vipOrch.workletReady === true;
      }, { timeout: 20000 });

      expect(isWorkletReady).toBeTruthy();
    } catch (err) {
      console.error('Worklet integration test failed. Recent browser console messages:');
      consoleMsgs.forEach(m => console.error(m));
      throw err;
    }

    const workletStatus = await page.evaluate(() => {
      const orch = window._vipOrch;
      if (!orch) return { missing: true };
      return {
        hasWorkletNode: !!orch.workletNode,
        hasPort: !!(orch.workletNode && orch.workletNode.port),
        hasMlWorker: !!orch.mlWorker,
        inputRingSAB: typeof SharedArrayBuffer !== 'undefined' && orch._inputRingSAB instanceof SharedArrayBuffer,
        maskRingSAB: typeof SharedArrayBuffer !== 'undefined' && orch._maskRingSAB instanceof SharedArrayBuffer
      };
    });

    expect(workletStatus.hasWorkletNode).toBe(true);
    expect(workletStatus.hasPort).toBe(true);
    expect(workletStatus.hasMlWorker).toBe(true);
    expect(workletStatus.inputRingSAB).toBe(true);
    expect(workletStatus.maskRingSAB).toBe(true);

  }, 30000);
});
