/**
 * Debug panel RUN AUDIT hit-test (round 13). Randy: the RUN AUDIT button was
 * covered and no numeric audit score showed. Live app on e9808d4: the panel
 * sits at z-index 9000, under #toastRegion (9999; its toasts take pointer
 * events) and #processingOverlay (99999, full screen, shown during Process
 * and post-Process analysis), so elementFromPoint at the button returned a
 * toast span or the overlay card. The button also only toasted "check
 * console". Runs in Node (not jsdom) to drive headless Chrome for real layout.
 */
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { resolveExecutable } = require('../scripts/lib/launch-chromium.cjs');

const ROOT = path.join(__dirname, '..');

function chromeBinary() {
  const fromEnv = resolveExecutable();
  if (fromEnv) return fromEnv;
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((file) => {
    try { return fs.statSync(file).isFile(); } catch { return false; }
  }) || null;
}

describe('debug panel RUN AUDIT', () => {
  let server;
  let chrome;
  let origin;
  let send;

  beforeAll(async () => {
    // The real app server (COOP/COEP headers, /src mapping): the audit's
    // AudioContext / worker checks need what production serves.
    const port = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    });
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'development', PORT: String(port) }, stdio: 'ignore' });
    origin = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i += 1) {
      try { const r = await fetch(`${origin}/app/`); if (r.ok) break; } catch { /* booting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const debugPort = 9300 + (port % 290);
    const binary = chromeBinary();
    if (!binary) throw new Error('No Chrome binary. Set VIP_CHROMIUM_PATH to the executable.');
    let spawnError = null;
    chrome = spawn(binary, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      `--remote-debugging-port=${debugPort}`, 'about:blank',
    ], { stdio: 'ignore' });
    chrome.on('error', (err) => { spawnError = err; });
    let version;
    for (let i = 0; i < 50; i += 1) {
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        if (res.ok) {
          version = await res.json();
          break;
        }
      } catch { /* chrome is still booting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (spawnError) throw new Error(`Chrome failed to start (${binary}): ${spawnError.message}`);
    if (!version) throw new Error(`headless Chrome did not open a debug port (${binary})`);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
    send = (method, params = {}, sessionId) => {
      const id = ++seq;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(payload));
      });
    };
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const attached = await send('Target.attachToTarget', { targetId, flatten: true });
    send.sessionId = attached.sessionId;
    send.ws = ws;
    await send('Page.enable', {}, send.sessionId);
    await send('Runtime.enable', {}, send.sessionId);
  }, 30000);

  afterAll(async () => {
    if (send && send.ws) send.ws.close();
    if (chrome) chrome.kill('SIGKILL');
    if (server) server.kill('SIGKILL');
  });

  async function evalUntil(expr, timeoutMs = 20000) {
    const t0 = Date.now();
    for (;;) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, send.sessionId);
      const v = r.result && r.result.value;
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) return null;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  async function openApp(width, height) {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: width < 800,
    }, send.sessionId);
    await send('Page.navigate', { url: `${origin}/app/` }, send.sessionId);
    const ok = await evalUntil(`(() => {
      const btn = document.getElementById('dbgRunAudit');
      const app = window._vipApp;
      if (!btn || !app || typeof app.showNotification !== 'function' || typeof app.showProcessingOverlay !== 'function') return false;
      const s = document.getElementById('bootSplash'); if (s) { s.style.display = 'none'; }
      const p = document.getElementById('vip-debug-panel');
      if (p.classList.contains('hidden')) document.getElementById('vip-debug-toggle').click();
      return true;
    })()`, 25000);
    if (!ok) {
      const diag = await send('Runtime.evaluate', { expression: `JSON.stringify({ href: location.href, btn: !!document.getElementById('dbgRunAudit'), app: typeof window._vipApp, title: document.title })`, returnByValue: true }, send.sessionId);
      throw new Error(`app did not mount the debug panel at ${width}px: ${diag.result && diag.result.value}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }

  const HIT = `(() => {
    const btn = document.getElementById('dbgRunAudit');
    const r = btn.getBoundingClientRect();
    const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 3, r.top + 3], [r.right - 3, r.bottom - 3]];
    return { visible: r.width > 0 && r.height > 0 && r.bottom <= innerHeight && r.right <= innerWidth,
      hits: pts.map(([x, y]) => { const el = document.elementFromPoint(x, y); return !!el && (el === btn || btn.contains(el)) ? 'button' : (el ? (el.id || el.className || el.tagName) : 'none'); }) };
  })()`;

  test.each([[1280, 720], [1600, 1000], [390, 844]])('RUN AUDIT is the hit target over toasts and the processing overlay at %ix%i', async (w, h) => {
    await openApp(w, h);
    await evalUntil(`(() => {
      const app = window._vipApp;
      for (let i = 0; i < 4; i++) app.showNotification('Kept Whisper Boost; calibration suggests Voice Clarity (quiet, -40.8 dBFS) ' + i, 'info', 60000);
      app.showProcessingOverlay('Analyzing…', 10, 'analyzing', null);
      return true;
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const res = await evalUntil(HIT);
    expect(res.visible).toBe(true);
    expect(res.hits).toEqual(['button', 'button', 'button']);
  }, 60000);

  test('RUN AUDIT shows a numeric score', async () => {
    await openApp(1280, 720);
    await evalUntil(`(() => { try { window._vipApp.hideProcessingOverlay(); } catch {} document.getElementById('dbgRunAudit').click(); return true; })()`);
    const text = await evalUntil(`(() => { const t = document.getElementById('dbgToast')?.textContent || ''; return t.startsWith('Audit ') && t.includes(' pass · ') ? t : null; })()`, 30000);
    if (!text) {
      const d = await send('Runtime.evaluate', { expression: `JSON.stringify({ toast: document.getElementById('dbgToast')?.textContent, fn: typeof window.VIP_runAudit, res: !!window.VIP_AUDIT_RESULTS })`, returnByValue: true }, send.sessionId);
      throw new Error(`no score: ${d.result && d.result.value}`);
    }
    expect(text).toMatch(/^Audit (\d+)\/(\d+) pass · \d+ fail · \d+ warn$/);
    const score = await evalUntil(`(() => { const r = window.VIP_AUDIT_RESULTS; return r ? { pass: r.passCount, total: r.results.length } : null; })()`);
    expect(text.startsWith(`Audit ${score.pass}/${score.total} pass`)).toBe(true);
  }, 60000);
});
