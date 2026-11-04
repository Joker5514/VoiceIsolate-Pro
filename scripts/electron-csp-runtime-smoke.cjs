'use strict';

/**
 * Electron CSP runtime smoke — `pnpm test:electron-csp-runtime`.
 *
 * Proves, in a real Electron runtime rather than by reading source, that
 * the vip:// protocol serves the VIP-025 CSP with the legacy exception
 * scoped exactly as `electron/vip-csp.cjs` claims:
 *   - landing (vip://app/index.html) gets a strict script-src;
 *   - the Engineer shell (vip://app/app/index.html) gets the legacy
 *     exception (it still contains inline <script> blocks);
 *   - an encoded traversal that resolves to landing content
 *     (vip://app/app/..%2findex.html) gets the STRICT policy — the
 *     regression test for the normalizeScopePath fix;
 *   - a real worker starts under the vip:// policy, and a real
 *     AudioWorklet module loads under it.
 *
 * Launches Electron in dev mode (like electron-security-smoke) and then
 * navigates to vip:// URLs: the protocol handler is registered in the
 * main process regardless of the initial dev URL, and the static root
 * is the local build/ directory. This is NOT a packaged build — the
 * packaged-runtime boxes (VIP-025 boxes 1 and 4) stay open until a
 * Windows NSIS build is verified; the CSP module served here is the
 * same module the packaged app bundles.
 *
 * Needs the Electron binary and a display; on Linux run under
 * `xvfb-run -a`.
 */
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { _electron } = require('playwright');

const ROOT = path.join(__dirname, '..');
const fails = [];
const check = (ok, name, evidence) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : `: ${JSON.stringify(evidence)}`}`);
  if (!ok) fails.push(name);
};

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(`${url}/`, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`server did not start (${url})`));
        else setTimeout(ping, 250);
      });
      req.setTimeout(1500, () => req.destroy(new Error('probe timeout')));
    };
    ping();
  });
}

const scriptSrcOf = (headers) => {
  const csp = headers['content-security-policy'] || '';
  const part = csp.split(';').find((p) => p.trim().startsWith('script-src'));
  return part ? part.trim() : '';
};

(async () => {
  const port = await getFreePort();
  const devUrl = `http://localhost:${port}`;
  const env = { ...process.env, PORT: String(port) };
  if (env.NODE_ENV === 'test') env.NODE_ENV = 'development';
  delete env.BLOB_READ_WRITE_TOKEN;
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  let app;
  try {
    await waitForServer(devUrl);
    app = await _electron.launch({
      args: ['.', '--no-sandbox'],
      cwd: ROOT,
      env: { ...process.env, VIP_ELECTRON_DEV: '1', VIP_DEV_URL: devUrl },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState('load');
    const client = await win.context().newCDPSession(win);
    await client.send('Network.enable');
    const responses = new Map();
    client.on('Network.responseReceived', (e) => {
      responses.set(e.response.url, e.response.headers);
    });

    // Landing: strict script-src.
    await win.goto('vip://app/index.html');
    await win.waitForLoadState('load');
    const landing = scriptSrcOf(responses.get('vip://app/index.html') || {});
    check(!landing.includes("'unsafe-inline'"), 'vip:// landing serves strict script-src', landing);

    // Engineer shell: legacy exception (inline scripts still present).
    await win.goto('vip://app/app/index.html');
    await win.waitForLoadState('load');
    const engineer = scriptSrcOf(responses.get('vip://app/app/index.html') || {});
    check(engineer.includes("'unsafe-inline'"), 'vip:// Engineer shell serves legacy script-src', engineer);

    // Traversal: resolves to landing content, must carry the STRICT policy.
    await win.goto('vip://app/app/..%2findex.html');
    await win.waitForLoadState('load');
    const traversalUrl = [...responses.keys()].find((u) => u.includes('..%2f'));
    const traversal = scriptSrcOf(responses.get(traversalUrl) || {});
    check(traversalUrl !== undefined && !traversal.includes("'unsafe-inline'"),
      'vip:// traversal to landing serves strict script-src', { traversalUrl, traversal });

    // Preload bridge is present on vip:// pages too.
    check(await win.evaluate(() => typeof window.vipDesktop) === 'object', 'window.vipDesktop exposed on vip:// page');

    // A real worker starts under the vip:// policy (no CSP violation).
    const workerResult = await win.evaluate(async () => {
      const violations = [];
      const onViolation = (e) => violations.push(e.violatedDirective);
      document.addEventListener('securitypolicyviolation', onViolation);
      try {
        const w = new Worker('/app/ml-worker.js');
        await new Promise((resolve) => setTimeout(resolve, 1500));
        w.terminate();
      } catch (e) {
        return { error: String(e), violations };
      } finally {
        document.removeEventListener('securitypolicyviolation', onViolation);
      }
      return { error: null, violations };
    });
    check(workerResult.error === null && workerResult.violations.length === 0,
      'worker starts under vip:// CSP without violations', workerResult);

    // A real AudioWorklet module loads under the vip:// policy.
    const workletResult = await win.evaluate(async () => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        await ctx.audioWorklet.addModule('/app/dsp-processor.js');
        await ctx.close();
        return { error: null };
      } catch (e) {
        return { error: String(e) };
      }
    });
    check(workletResult.error === null, 'AudioWorklet module loads under vip:// CSP', workletResult);
  } catch (err) {
    console.error(err);
    fails.push(String(err).split('\n')[0]);
  } finally {
    if (app) await app.close().catch(() => {});
    server.kill('SIGTERM');
  }
  if (fails.length) {
    console.log(`\nFAILED ${fails.length}`);
    process.exit(1);
  }
  console.log('\nelectron-csp-runtime: all checks passed');
})();
