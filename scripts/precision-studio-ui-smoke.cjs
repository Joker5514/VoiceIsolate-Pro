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

    // Cancellation latency is bounded by the yield budget, not by the chunk
    // count: processInChunks yields on elapsed work, so each chunk has to do
    // real work for the loop to reach a yield at all. 600 chunks × ~2 ms is
    // ~1.2 s of work that a cancel must cut short almost immediately.
    const responsiveness = await page.evaluate(async () => {
      const { processInChunks } = await import('/src/pipeline/ui-yield.js');
      const controller = new AbortController();
      const startedAt = performance.now();
      let chunks = 0;
      setTimeout(() => controller.abort('responsiveness-smoke'), 0);
      try {
        await processInChunks({
          total: 48_000 * 600,
          chunkSize: 48_000,
          signal: controller.signal,
          runChunk: () => {
            chunks += 1;
            const until = performance.now() + 2;
            while (performance.now() < until) { /* stand in for real DSP */ }
          },
        });
        return { cancelled: false, elapsedMs: performance.now() - startedAt, chunks };
      } catch (error) {
        return {
          cancelled: error?.name === 'AbortError',
          elapsedMs: performance.now() - startedAt,
          chunks,
        };
      }
    });
    check(
      responsiveness.cancelled
        && responsiveness.elapsedMs < 250
        && responsiveness.chunks <= 40,
      `cooperative cancellation <250 ms (${responsiveness.elapsedMs.toFixed(1)} ms, ${responsiveness.chunks} chunk)`,
    );

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

    // Focusable content must never sit inside aria-hidden="true": it stays
    // keyboard-reachable while being erased from the accessibility tree. This
    // belongs in the browser rather than over the markup, because the shell has
    // several legitimate aria-hidden containers that CSS hides.
    //
    // The test is real focusability, not visibility. `checkVisibility()` with
    // default options ignores `visibility: hidden` and `opacity: 0`, so it
    // reports the idle processing overlay's Cancel button as visible even
    // though focus() cannot reach it. Moving focus and reading activeElement is
    // exactly the property that makes this an a11y defect, and it does not
    // depend on which checkVisibility options a Chromium version supports.
    const ariaHiddenFocusable = await page.evaluate(() => {
      // Covers the element types that are focusable without an explicit
      // tabindex, plus the host itself: `aria-hidden` sitting directly on a
      // control is the same defect as one on a wrapper.
      const FOCUSABLE = 'a[href], area[href], button, input, select, textarea,'
        + ' summary, iframe, [contenteditable], [tabindex]';
      const restore = document.activeElement;
      const out = [];
      for (const host of document.querySelectorAll('[aria-hidden="true"]')) {
        const candidates = [host, ...host.querySelectorAll(FOCUSABLE)];
        for (const el of candidates) {
          if (el === host && !el.matches(FOCUSABLE)) continue;
          if (el.hasAttribute('disabled')) continue;
          const ti = el.getAttribute('tabindex');
          if (ti !== null && Number(ti) < 0) continue;
          try { el.focus({ preventScroll: true }); } catch { continue; }
          if (document.activeElement === el) {
            const where = el === host ? 'itself' : `inside #${host.id || host.className}`;
            out.push(`${el.tagName.toLowerCase()}#${el.id || ''} ${where}`);
          }
        }
      }
      try { restore && restore.focus && restore.focus({ preventScroll: true }); } catch { /* ignore */ }
      return out;
    });
    check(
      ariaHiddenFocusable.length === 0,
      `no focusable element inside aria-hidden (${ariaHiddenFocusable.slice(0, 3).join(' | ')})`,
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: 'load' });
    // engineer-console.js installs the field nav two rAFs after DOMContentLoaded
    // (so first paint lands before the reparent). A fixed sleep races that under
    // CPU contention — it failed once on a loaded machine and passed 3/3 idle.
    // Wait for the element itself; the assertion below is unchanged, so this
    // makes the check reliable without weakening what it proves.
    let fieldNavPresent = true;
    try {
      await page.waitForSelector('#psFieldNav', { state: 'attached', timeout: 15000 });
    } catch {
      fieldNavPresent = false;
    }
    check(fieldNavPresent && await page.locator('#psFieldNav').count() === 1, 'field nav present');

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
