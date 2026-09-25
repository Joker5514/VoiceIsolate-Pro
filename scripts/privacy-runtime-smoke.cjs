'use strict';

/**
 * Runtime privacy verification — `pnpm test:privacy-runtime`.
 *
 * Static checks (`pnpm check:privacy`) prove the source has no cloud-audio
 * call sites. This proves the running app does not send audio anywhere: it
 * drives real Chromium through upload → Process → export on Landing and
 * upload → Process on the Engineer Console, and records every network
 * surface a page, dedicated worker or service worker can use:
 *
 *   - a browser-level recording proxy that every HTTP request, WebSocket
 *     upgrade and CONNECT tunnel from any context (page, dedicated worker,
 *     shared/service worker) must traverse — loopback included
 *   - context-level requests (fetch, XHR, workers, service worker, subresources)
 *   - page WebSocket connections
 *   - navigator.sendBeacon, RTCPeerConnection, WebSocket constructor calls
 *     (RTCPeerConnection and sendBeacon do not exist in workers)
 *
 * The trust boundary it enforces: while no user-initiated file-transfer
 * feature (e.g. Google Drive, ADR-002) is used, the app may only GET/HEAD
 * static assets from its own origin. Any request that carries a body, any
 * cross-origin request, any non-static path or data-bearing query string, any
 * socket/tunnel/beacon/peer connection is a failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { launchChromium } = require('./lib/launch-chromium.cjs');

const ROOT = path.join(__dirname, '..');
/** Static asset types the app legitimately loads; anything else is an API call. */
const STATIC_EXT = /\.(?:html|js|mjs|cjs|css|json|webmanifest|wasm|onnx|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|mp4|webm|txt|map)$/i;
/** Cache-busting query strings (e.g. `?v=25.0.2`) are the only queries allowed. */
const MAX_QUERY_LENGTH = 40;
const fails = [];

function check(ok, name, evidence) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok || evidence === undefined ? '' : `: ${JSON.stringify(evidence).slice(0, 600)}`}`);
  if (!ok) fails.push(name);
}

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
      const req = http.get(`${url}/`, (res) => { res.resume(); if (res.statusCode < 500) resolve(); else retry(); });
      req.on('error', retry);
      req.setTimeout(1500, () => req.destroy(new Error('probe timeout')));
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error(`server did not start (${url})`));
      else setTimeout(ping, 250);
    };
    ping();
  });
}

/** Deterministic 16-bit mono WAV: a tone plus seeded noise. */
function makeWav(seconds, file) {
  const sr = 48000;
  const n = sr * seconds;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  let seed = 7;
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const s = 0.25 * Math.sin(2 * Math.PI * 180 * i / sr) + 0.05 * (seed / 4294967296 - 0.5);
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
  return file;
}

/** Wraps every in-page egress API a page or its script could reach. */
function instrumentEgress() {
  const log = [];
  Object.defineProperty(window, '__vipEgress', { value: log });
  const note = (api, target) => log.push({ api, target: String(target).slice(0, 200) });
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => { note('sendBeacon', url); return beacon(url, data); };
  }
  if (window.WebSocket) {
    const NativeWS = window.WebSocket;
    window.WebSocket = class extends NativeWS {
      constructor(url, protocols) { note('WebSocket', url); super(url, protocols); }
    };
  }
  if (window.RTCPeerConnection) {
    const NativePC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePC {
      constructor(config) { note('RTCPeerConnection', JSON.stringify(config || {})); super(config); }
    };
  }
}

/**
 * Forwarding HTTP proxy. Chromium sends every request from every context
 * through it (`bypass: '<-loopback>'` removes the implicit localhost bypass),
 * so worker and service-worker traffic cannot slip past the recorder. Upgrades
 * (WebSocket) and CONNECT tunnels are recorded and refused.
 */
function startRecordingProxy(log) {
  const server = http.createServer((req, res) => {
    let bodyBytes = 0;
    req.on('data', (chunk) => { bodyBytes += chunk.length; });
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    const upstream = http.request({
      host: target.hostname, port: target.port, path: target.pathname + target.search,
      method: req.method, headers: req.headers,
    }, (up) => { res.writeHead(up.statusCode, up.headers); up.pipe(res); });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
    req.on('end', () => log.push({ kind: 'http', method: req.method, url: req.url, bodyBytes }));
  });
  server.on('upgrade', (req, socket) => { log.push({ kind: 'upgrade', url: req.url }); socket.destroy(); });
  server.on('connect', (req, socket) => { log.push({ kind: 'connect', url: req.url }); socket.destroy(); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function isStaticAsset(url) {
  const u = new URL(url);
  const pathOk = u.pathname.endsWith('/') || STATIC_EXT.test(u.pathname);
  return pathOk && u.search.length <= MAX_QUERY_LENGTH;
}

function attachRecorders(context, page, base, record) {
  const origin = new URL(base).origin;
  context.on('request', (req) => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    const body = req.postDataBuffer();
    record.requests.push({
      url: url.slice(0, 300),
      staticAsset: isStaticAsset(url),
      method: req.method(),
      type: req.resourceType(),
      bodyBytes: body ? body.length : 0,
      sameOrigin: new URL(url).origin === origin,
      serviceWorker: Boolean(req.serviceWorker?.()),
    });
  });
  page.on('websocket', (ws) => record.sockets.push(ws.url()));
  page.on('pageerror', (e) => record.pageErrors.push(String(e).split('\n')[0]));
}

function assertBoundary(label, record, egress) {
  const writes = record.requests.filter((r) => !['GET', 'HEAD'].includes(r.method) || r.bodyBytes > 0);
  check(writes.length === 0, `${label}: no request carries a body or uses a write method`, writes);
  const foreign = record.requests.filter((r) => !r.sameOrigin);
  check(foreign.length === 0, `${label}: every request stays on the app origin`, foreign);
  const dynamic = record.requests.filter((r) => r.sameOrigin && !r.staticAsset);
  check(dynamic.length === 0, `${label}: same-origin requests are static assets with no data-bearing query`, dynamic);
  check(record.sockets.length === 0, `${label}: no WebSocket connection opens`, record.sockets);
  const origin = new URL(record.base).origin;
  const proxied = record.proxy.filter((e) => e.kind !== 'http'
    || !['GET', 'HEAD'].includes(e.method) || e.bodyBytes > 0
    || new URL(e.url).origin !== origin || !isStaticAsset(e.url));
  check(proxied.length === 0, `${label}: browser-level proxy saw only static same-origin GETs (all contexts)`, proxied);
  check(record.proxy.length > 0, `${label}: browser-level proxy observed traffic`, record.proxy.length);
  check(egress.length === 0, `${label}: no sendBeacon / WebSocket / RTCPeerConnection call`, egress);
  check(record.requests.length > 0, `${label}: network recorder observed traffic`, record.requests.length);
}

async function landingJourney(browser, base, wav, proxyLog) {
  proxyLog.length = 0;
  const record = { base, proxy: proxyLog, requests: [], sockets: [], pageErrors: [] };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  await context.addInitScript(instrumentEgress);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  attachRecorders(context, page, base, record);

  await page.goto(`${base}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.querySelector('#modelSelect')?.disabled);
  await page.setInputFiles('#fileInput', wav);
  await page.waitForFunction(() => document.querySelector('#uploadPanel')?.dataset.state === 'ready'
    && !document.querySelector('#processBtn').disabled, null, { timeout: 60000 });
  await page.click('#processBtn');
  await page.waitForFunction(() => ['processed', 'error'].includes(document.querySelector('#uploadPanel')?.dataset.state),
    null, { timeout: 180000 });
  const state = await page.locator('#uploadPanel').getAttribute('data-state');
  check(state === 'processed', 'Landing: Process completes locally', state);
  // Let idle-callback analysis and speaker detection run inside the window.
  await page.waitForTimeout(2500);
  const download = page.waitForEvent('download', { timeout: 120000 });
  await page.click('#downloadBtn');
  const file = await download;
  check(Boolean(file.suggestedFilename()), 'Landing: export produces a local download', file.suggestedFilename());

  const egress = await page.evaluate(() => window.__vipEgress || []);
  assertBoundary('Landing', record, egress);
  check(record.pageErrors.length === 0, 'Landing: no page errors', record.pageErrors);
  await context.close();
}

async function engineerJourney(browser, base, wav, proxyLog) {
  proxyLog.length = 0;
  const record = { base, proxy: proxyLog, requests: [], sockets: [], pageErrors: [] };
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(instrumentEgress);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  attachRecorders(context, page, base, record);

  await page.goto(`${base}/app/`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window._vipApp?.handleFile === 'function', null, { timeout: 30000 });
  await page.evaluate(() => {
    window._vipApp?._dismissBootSplash?.();
    const s = document.getElementById('bootSplash');
    if (s) { s.style.display = 'none'; s.style.pointerEvents = 'none'; }
  });
  await page.setInputFiles('#fileInput', wav);
  await page.waitForFunction(() => { const b = document.getElementById('processBtn'); return b && !b.disabled; },
    null, { timeout: 60000 });
  await page.click('#processBtn');
  const deadline = Date.now() + 180000;
  let end = 'TIMEOUT';
  while (Date.now() < deadline) {
    const st = await page.evaluate(() => document.getElementById('hStatus')?.textContent?.trim() || '');
    if (st === 'DONE' || st === 'ERROR') { end = st; break; }
    await page.waitForTimeout(500);
  }
  check(end === 'DONE', 'Engineer: Process completes locally', end);
  // Auto-analysis runs on an idle callback after the pipeline finishes.
  await page.waitForTimeout(3000);

  const egress = await page.evaluate(() => window.__vipEgress || []);
  assertBoundary('Engineer', record, egress);
  check(record.pageErrors.length === 0, 'Engineer: no page errors', record.pageErrors);
  await context.close();
}

(async () => {
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  const wav = makeWav(4, path.join(os.tmpdir(), `vip-privacy-${process.pid}.wav`));
  const env = { ...process.env, PORT: String(port) };
  if (env.NODE_ENV === 'test') env.NODE_ENV = 'development';
  // server.js would otherwise sync local models to Vercel Blob on startup;
  // that is server-side model hosting, not app traffic, and not under test.
  delete env.BLOB_READ_WRITE_TOKEN;
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: 'ignore' });
  let browser;
  let proxy;
  try {
    await waitForServer(base);
    const proxyLog = [];
    proxy = await startRecordingProxy(proxyLog);
    browser = await launchChromium({
      headless: true,
      // Silence Chromium's own background traffic (time sync, sign-in, GCM,
      // safe browsing, variations, autofill, component updates) so everything
      // the proxy sees comes from the app. A blank page with these flags makes
      // zero proxied requests; without them it made eight to Google hosts.
      args: [
        '--no-sandbox',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-domain-reliability',
        '--no-pings',
        '--no-first-run',
        '--disable-default-apps',
        '--disable-client-side-phishing-detection',
        '--safebrowsing-disable-auto-update',
        '--disable-field-trial-config',
        '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,'
          + 'CertificateTransparencyComponentUpdater,NetworkTimeServiceQuerying,SafeBrowsing,Translate,PushMessaging',
        // Point browser-internal Google endpoints at a closed loopback port; the
        // proxy check would flag any of them, so a silent run proves they stayed off.
        ...['google-base-url', 'gaia-url', 'variations-server-url', 'gcm-checkin-url',
          'gcm-mcs-endpoint', 'gcm-registration-url'].map((flag) => `--${flag}=http://127.0.0.1:9`),
      ],
      proxy: { server: `http://127.0.0.1:${proxy.address().port}`, bypass: '<-loopback>' },
    });
    console.log('[privacy] Landing: upload → Process → export');
    await landingJourney(browser, base, wav, proxyLog);
    console.log('[privacy] Engineer: upload → Process → auto-analysis');
    await engineerJourney(browser, base, wav, proxyLog);
  } catch (err) {
    console.error(err);
    fails.push(String(err).split('\n')[0]);
  } finally {
    if (browser) await browser.close().catch(() => {});
    proxy?.close();
    server.kill('SIGTERM');
    try { fs.unlinkSync(wav); } catch { /* already gone */ }
  }
  if (fails.length) {
    console.log(`\nFAILED ${fails.length}`);
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('\nprivacy-runtime: all checks passed');
})();
