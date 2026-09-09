/** Real local ONNX/browser regression. Uses installed Playwright; no browser download. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.QUICK_CLEAN_URL || 'http://localhost:3000';
const output = process.env.QUICK_CLEAN_OUTPUT || path.join(__dirname, '../output/playwright/quick-clean');
fs.mkdirSync(output, { recursive: true });
const report = { checks: [], errors: [], consoleErrors: [], requests: [] };
const check = (name, evidence) => { report.checks.push({ status: 'PASS', name, evidence }); console.log(`PASS ${name}: ${JSON.stringify(evidence)}`); };

function fixture() {
  const sr = 48000, length = sr * 3;
  const wav = Buffer.alloc(44 + length * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sr, 24); wav.writeUInt32LE(sr * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(length * 2, 40);
  let seed = 42;
  for (let i = 0; i < length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const sample = 0.2 * Math.sin(i * 2 * Math.PI * 220 / sr) + 0.08 * (seed / 4294967296 - 0.5);
    wav.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }
  return { name: 'quick-clean-fixture.wav', mimeType: 'audio/wav', buffer: wav };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', (err) => report.errors.push(err.message));
  page.on('console', (msg) => { if (msg.type() === 'error') report.consoleErrors.push(msg.text()); });
  page.on('request', (req) => report.requests.push({ url: req.url(), method: req.method() }));
  await page.addInitScript(() => {
    window.__quickCleanMessages = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...rest) {
        window.__quickCleanMessages.push({ type: message?.type, modelIds: message?.modelIds, sampleRate: message?.sampleRate });
        return super.postMessage(message, ...rest);
      }
    };
  });
  try {
    const response = await page.goto(base);
    assert.equal(response.status(), 200);
    assert.match(response.headers()['permissions-policy'], /microphone=\(\)/);
    assert(!response.headers()['content-security-policy'].includes("script-src 'self' 'unsafe-inline'"));
    await page.waitForFunction(() => !document.querySelector('#modelSelect').disabled);
    check('Landing loads with local runtime and security headers', await page.locator('#quickCleanPreflight').innerText());
    const options = await page.locator('#modelSelect option').evaluateAll((items) => items.map((item) => ({ value: item.value, text: item.textContent, disabled: item.disabled })));
    assert.equal(options.length, 3); assert(options.every((option) => !option.disabled));
    check('Only three shipped outcomes enabled', options);
    const duplicates = await page.locator('[id]').evaluateAll((items) => { const ids = items.map((item) => item.id); return ids.filter((id, index) => ids.indexOf(id) !== index); });
    assert.deepEqual(duplicates, []);
    check('No duplicate DOM IDs', duplicates);
    await page.setInputFiles('#fileInput', { name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('not audio') });
    await page.waitForFunction(() => document.querySelector('#uploadPanel').dataset.state === 'error');
    check('Invalid input reports recovery', await page.locator('#quickCleanStatus').innerText());
    await page.setInputFiles('#fileInput', fixture());
    await page.waitForFunction(() => document.querySelector('#uploadPanel').dataset.state === 'ready' && !document.querySelector('#processBtn').disabled);
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.__quickCleanMessages.filter((msg) => msg.type === 'process' || msg.type === 'warmup').length), 0);
    check('Import does not start inference or model warmup', true);
    await page.locator('#processBtn').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => ['processed', 'error'].includes(document.querySelector('#uploadPanel').dataset.state), null, { timeout: 180000 });
    assert.equal(await page.locator('#uploadPanel').getAttribute('data-state'), 'processed', await page.locator('#quickCleanStatus').innerText());
    const processing = await page.evaluate(() => window.__quickCleanMessages.filter((msg) => msg.type === 'process'));
    assert.equal(processing.length, 1); assert.equal(processing[0].sampleRate, 48000);
    check('Explicit keyboard Process produces real local stems', processing);
    await page.locator('#playBtn').click();
    await page.locator('#voiceLevelSlider').fill('85');
    await page.locator('#noiseReductionSlider').fill('70');
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.__quickCleanMessages.filter((msg) => msg.type === 'process').length), 1);
    check('Live-Mix controls do not rerun inference', await page.locator('#noiseReductionVal').innerText());
    await page.locator('#pauseBtn').click();
    await page.locator('#prepareComparisonBtn').click();
    await page.waitForFunction(() => !document.querySelector('#compareOriginalBtn').disabled || document.querySelector('#comparisonStatus').textContent.includes('unavailable'), null, { timeout: 150000 });
    assert.equal(await page.locator('#compareOriginalBtn').isDisabled(), false, await page.locator('#comparisonStatus').innerText());
    await page.locator('#compareOriginalBtn').click();
    assert.equal(await page.locator('#compareOriginalBtn').getAttribute('aria-pressed'), 'true');
    await page.locator('#compareCleanedBtn').click();
    assert.equal(await page.locator('#compareCleanedBtn').getAttribute('aria-pressed'), 'true');
    check('Matched A/B renders and switches', await page.locator('#comparisonStatus').innerText());
    await page.locator('#pauseBtn').click();
    await page.locator('#volumeSlider').fill('60');
    assert.equal(await page.locator('#compareOriginalBtn').isDisabled(), true);
    check('Changing mix invalidates stale A/B snapshot', true);
    const downloadEvent = page.waitForEvent('download', { timeout: 150000 });
    await page.locator('#downloadBtn').click();
    const download = await downloadEvent;
    await download.saveAs(path.join(output, download.suggestedFilename()));
    const bytes = fs.readFileSync(path.join(output, download.suggestedFilename()));
    assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
    assert.equal(bytes.readUInt32LE(24), 48000);
    assert.equal(bytes.readUInt16LE(22), 1);
    assert.equal(bytes.readUInt32LE(40), 3 * 48000 * 2);
    assert.equal(await page.locator('#uploadPanel').getAttribute('data-state'), 'exported');
    check('Local WAV export has correct rate/channels/duration', { bytes: bytes.length, sampleRate: 48000, channels: 1, seconds: 3 });
    const rendered = await page.evaluate(async () => {
      const buffer = await window.__vipDiagnostics.mixer.renderMix();
      return Array.from(buffer.getChannelData(0), (sample) => Math.trunc(Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767)));
    });
    let maxDelta = 0;
    for (let i = 0; i < rendered.length; i++) maxDelta = Math.max(maxDelta, Math.abs(rendered[i] - bytes.readInt16LE(44 + i * 2)));
    assert(maxDelta <= 1, `WAV differs from rendered mix by ${maxDelta} PCM units`);
    check('Exported PCM matches Voice/Background/Output mix', { maxDelta });
    await context.setOffline(true);
    await page.selectOption('#modelSelect', 'rnnoise');
    await page.waitForFunction(() => document.querySelector('#quickCleanPreflight').textContent.includes('Offline:'));
    check('Offline preflight explains model-cache requirement', await page.locator('#quickCleanPreflight').innerText());
    await context.setOffline(false);
    // An uncached different chain permits immediate cancellation and a real retry.
    await page.selectOption('#modelSelect', 'max_isolation');
    await page.waitForFunction(() => !document.querySelector('#processBtn').disabled);
    await page.locator('#processBtn').click();
    await page.locator('#cancelProcessBtn').click();
    await page.waitForFunction(() => !document.querySelector('#processBtn').disabled);
    check('Cancellation restores actionable state', await page.locator('#quickCleanStatus').innerText());
    await page.locator('#processBtn').click();
    await page.waitForFunction(() => ['processed', 'error'].includes(document.querySelector('#uploadPanel').dataset.state), null, { timeout: 180000 });
    assert.equal(await page.locator('#uploadPanel').getAttribute('data-state'), 'processed', await page.locator('#quickCleanStatus').innerText());
    check('Retry completes maximum-isolation chain', true);
    await page.screenshot({ path: path.join(output, 'landing-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert(overflow <= 1, `Mobile horizontal overflow: ${overflow}px`);
    await page.screenshot({ path: path.join(output, 'landing-mobile.png'), fullPage: true });
    check('Narrow mobile reflow with reduced motion', { width: 390, overflow });
    assert.equal(report.requests.filter((req) => ['POST', 'PUT', 'PATCH'].includes(req.method)).length, 0);
    check('No outbound writes during local import/process/review/export', true);
    const landingErrors = [...report.errors];
    assert.deepEqual(landingErrors, []);
    check('Landing has no uncaught page errors', landingErrors);
    await page.goto(`${base}/app/`);
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('#processBtn').count(), 1);
    await page.screenshot({ path: path.join(output, 'engineer-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(output, 'engineer-desktop.png'), fullPage: true });
    check('Engineer shell still loads at both viewport sizes', { processButtons: 1, newPageErrors: report.errors.slice(landingErrors.length) });
  } catch (err) {
    report.checks.push({ status: 'FAIL', name: 'Browser workflow', evidence: err.stack });
    console.error(err);
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
