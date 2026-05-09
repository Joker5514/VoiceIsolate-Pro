const { chromium } = require('playwright');

const PORT = process.env.PORT || 3000;

describe('Worklet Integration Verification', () => {
  let browser;

  beforeAll(async () => {
    browser = await chromium.launch({
      args: ['--no-sandbox', '--enable-features=SharedArrayBuffer', '--autoplay-policy=no-user-gesture-required']
    });
  }, 15000);

  afterAll(async () => {
    if (browser) await browser.close();
  });

  test('AudioWorklets are loaded correctly in Orchestrator and ML Worker processes', async () => {
    const page = await browser.newPage();

    await page.goto(`http://127.0.0.1:${PORT}/app/`);

    // Wait for orchestrator to attach
    await page.waitForFunction(() => window._vipOrch !== undefined);

    // Initializing AudioContext through a simulated click
    await page.click('body');

    // Wait for worklet to be loaded and marked as ready
    const isWorkletReady = await page.waitForFunction(() => {
      return window._vipOrch && window._vipOrch.workletReady === true;
    }, { timeout: 15000 });

    expect(isWorkletReady).toBeTruthy();

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
