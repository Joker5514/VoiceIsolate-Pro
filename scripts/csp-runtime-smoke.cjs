#!/usr/bin/env node
'use strict';

/**
 * VIP-024 — browser CSP runtime verification.
 *
 * The other browser smokes already run against server.js, which applies
 * the real securityHeaders middleware — so their passes are also passes
 * under the dev-server CSP. This smoke pins the policy itself in a real
 * Chromium: the headers actually served, the strict-vs-legacy scoping,
 * and proof the policy bites (not just that nothing broke):
 *
 *   - / (landing) serves strict CSP: script-src has no 'unsafe-inline'.
 *   - /app/ (legacy Engineer shell) serves the scoped 'unsafe-inline'
 *     exception documented in server/securityHeaders.js — and only
 *     there. If the migration finishes and the exception is removed,
 *     this check must be updated, not deleted.
 *   - No CSP-violation console messages on load of either page.
 *   - An injected inline script on the strict path is blocked (probe
 *     stays undefined AND a CSP console error appears).
 *   - A blob: worker can still be created (worker-src 'self' blob:).
 *   - A fetch to a non-listed third-party origin is refused by
 *     connect-src (asserted on the CSP console error, not on the
 *     rejection alone — the sandbox network could reject it anyway).
 *
 * The production (Vercel) CSP deliberately extends this policy with
 * Firebase/Blob/Drive/RevenueCat origins; that config is pinned
 * statically by tests/deployment-config.test.js. This smoke verifies
 * the dev-server policy that the browser tier actually serves.
 * Firefox/WebKit are not run here (no such browsers in this VM);
 * Chromium is the browser available, and the policy is server-sent,
 * so its directives are browser-independent.
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const { launchChromium } = require('./lib/launch-chromium.cjs');

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
  const cspOf = (headers) => {
    const h = headers['content-security-policy'] || headers['Content-Security-Policy'];
    return typeof h === 'string' ? h : '';
  };
  const scriptSrcOf = (csp) => {
    const m = csp.match(/script-src[^;]*/);
    return m ? m[0] : '';
  };

  try {
    await waitForServer(BASE);
    const browser = await launchChromium({ args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    const consoleTexts = [];
    page.on('console', (m) => consoleTexts.push(m.text()));
    page.on('pageerror', (e) => consoleTexts.push(String(e)));
    const cspViolations = () => consoleTexts.filter((t) => /Content Security Policy|Refused to (load|execute|connect|apply)/.test(t));

    // Strict path: landing.
    const landingResp = await page.goto(`${BASE}/`, { waitUntil: 'load' });
    const landingCsp = cspOf(landingResp.headers());
    check(landingCsp.includes("default-src 'self'"), `landing serves CSP (${landingCsp.slice(0, 80)}…)`);
    check(!scriptSrcOf(landingCsp).includes("'unsafe-inline'"), 'landing script-src has no unsafe-inline (strict)');
    check(landingCsp.includes("worker-src 'self' blob:"), 'landing worker-src allows self + blob');
    check(landingCsp.includes("object-src 'none'"), "landing object-src 'none'");
    await page.waitForTimeout(1000);
    check(cspViolations().length === 0, `no CSP violations on landing load (${cspViolations().length})`);

    // The policy must bite: inline injection on the strict path.
    consoleTexts.length = 0;
    const probe = await page.evaluate(() => {
      window.__cspProbe = undefined;
      const s = document.createElement('script');
      s.textContent = 'window.__cspProbe = 1;';
      document.body.appendChild(s);
      return window.__cspProbe;
    });
    await page.waitForTimeout(500);
    check(probe === undefined, 'inline script blocked on strict path (probe stayed undefined)');
    check(cspViolations().length > 0, 'inline injection produced a CSP violation report');

    // Blob worker still allowed under the policy.
    consoleTexts.length = 0;
    const blobOk = await page.evaluate(async () => {
      const blob = new Blob(['postMessage(42);'], { type: 'application/javascript' });
      const w = new Worker(URL.createObjectURL(blob));
      const v = await new Promise((resolve) => { w.onmessage = (e) => resolve(e.data); });
      w.terminate();
      return v;
    });
    check(blobOk === 42, 'blob: worker runs under CSP');
    check(cspViolations().length === 0, 'no CSP violations from blob worker');

    // Third-party connect refused by connect-src (asserted on the CSP
    // report, not the rejection alone).
    consoleTexts.length = 0;
    await page.evaluate(async () => {
      try { await fetch('https://example.com/'); } catch { /* expected */ }
    });
    await page.waitForTimeout(500);
    check(cspViolations().some((t) => /connect-src/.test(t)), 'third-party fetch refused by connect-src');

    // Legacy path: Engineer shell keeps its scoped exception, and only it.
    consoleTexts.length = 0;
    const appResp = await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
    const appCsp = cspOf(appResp.headers());
    check(scriptSrcOf(appCsp).includes("'unsafe-inline'"), 'engineer path keeps scoped unsafe-inline exception (legacy shell)');
    await page.waitForTimeout(1000);
    const canvasPresent = await page.locator('#engineerWaveCanvas').count();
    check(canvasPresent > 0, 'engineer shell loads under its CSP (wave canvas present)');
    check(cspViolations().length === 0, `no CSP violations on engineer load (${cspViolations().length})`);

    await browser.close();
  } finally {
    server.kill();
  }
  if (fail.length) {
    console.error(`\nCSP runtime smoke: ${fail.length} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log('\nCSP runtime smoke: ALL CHECKS PASSED');
})().catch((e) => {
  // The try/finally above kills the server on every path where one exists.
  console.error(e);
  process.exit(1);
});
