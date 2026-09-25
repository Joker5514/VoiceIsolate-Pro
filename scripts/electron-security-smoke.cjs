'use strict';

/**
 * Electron runtime security smoke — `pnpm test:electron-security`.
 *
 * Launches the real Electron main process (dev mode against a self-hosted
 * server) and proves, at runtime rather than by reading source:
 *   - the sandboxed preload loads and exposes `window.vipDesktop`
 *   - IPC answers the app's own document
 *   - model-cache IPC refuses path traversal
 *   - the main window cannot navigate off the app origin
 *   - window.open never hands a non-web scheme to the OS
 *
 * Needs the Electron binary (`pnpm setup:electron`) and a display; on Linux
 * run under `xvfb-run -a`. prod:verify runs it only with `--desktop`.
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
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error(`server did not start (${url})`));
      else setTimeout(ping, 250);
    };
    const ping = () => {
      const req = http.get(`${url}/`, (res) => { res.resume(); resolve(); });
      req.on('error', retry);
      // A listener that accepts but never answers must not outlive the deadline.
      req.setTimeout(1500, () => req.destroy(new Error('probe timeout')));
    };
    ping();
  });
}

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
    const preloadErrors = [];
    win.on('console', (m) => { if (/preload/i.test(m.text())) preloadErrors.push(m.text()); });
    await win.reload();
    await win.waitForLoadState('load');

    check(preloadErrors.length === 0, 'sandboxed preload loads without errors', preloadErrors);
    check(await win.evaluate(() => typeof window.vipDesktop) === 'object', 'window.vipDesktop is exposed');
    const domain = await win.evaluate(() => window.vipDesktop.firebaseAuthDomain);
    check(domain === 'voiceisolate-pro.firebaseapp.com', 'preload receives the main-process auth domain', domain);
    const platform = await win.evaluate(() => window.vipDesktop.platform());
    check(platform === process.platform, 'IPC answers the app document', platform);
    const traversal = await win.evaluate(() => window.vipDesktop.readModelCache('../../../../etc/passwd'));
    check(traversal === null, 'model-cache IPC refuses path traversal', traversal);
    const absolute = await win.evaluate(() => window.vipDesktop.writeModelCache({ relativePath: '/tmp/vip-escape', buffer: new ArrayBuffer(1) }));
    check(absolute && absolute.ok === false, 'model-cache IPC refuses absolute paths', absolute);

    await app.evaluate(({ shell }) => {
      globalThis.__vipOpened = [];
      shell.openExternal = async (url) => { globalThis.__vipOpened.push(url); };
    });
    await win.evaluate(() => { location.href = 'https://example.com/'; });
    await win.waitForTimeout(1500);
    check(new URL(win.url()).origin === devUrl, 'main window stays on the app origin', win.url());
    await win.evaluate(() => { window.open('file:///etc/passwd'); window.open('https://example.org/'); });
    await win.waitForTimeout(800);
    const opened = await app.evaluate(() => globalThis.__vipOpened);
    check(!opened.some((u) => !/^https?:|^mailto:/.test(u)), 'only web/mail links reach the OS', opened);
    check(opened.includes('https://example.org/'), 'web links still open in the system browser', opened);
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
  console.log('\nelectron-security: all checks passed');
})();
