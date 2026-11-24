/**
 * Landing header geometry. The section nav must stay fully visible once the
 * diagnostics toggles sit in the toolbar. Runs in Node (not jsdom) so it can
 * drive headless Chrome.
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

describe('landing header geometry', () => {
  let server;
  let chrome;
  let origin;
  let send;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const clean = decodeURIComponent((req.url || '/').split('?')[0]);
      const fromSrc = clean === '/src' || clean.startsWith('/src/');
      const root = fromSrc ? path.join(ROOT, 'src') : path.join(ROOT, 'public');
      const rel = fromSrc ? clean.slice('/src'.length) : (clean === '/' ? '/index.html' : clean);
      const file = path.normalize(path.join(root, rel));
      if (!file.startsWith(root)) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      fs.readFile(file, (err, buf) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const ext = path.extname(file);
        const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const debugPort = 9600 + (server.address().port % 300);
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
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  async function measure(width) {
    await send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: width < 800,
    }, send.sessionId);
    // Measure the settled page, not whatever is on screen when navigate returns:
    // a per-call query tells the new document from the previous one, and the
    // workspace blocks (which add chrome inside the nav) must have mounted.
    const nonce = `w${width}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await send('Page.navigate', { url: `${origin}/?geom=${nonce}` }, send.sessionId);
    const expr = `(() => {
      if (location.search !== '?geom=${nonce}' || document.readyState !== 'complete') return null;
      const header = document.querySelector('.v3-header');
      const ready = header && document.querySelector('.v3-nav.vip-block') && document.getElementById('vip-debug-toggle') && document.getElementById('vip-diag-toggle') && header.querySelectorAll('.v3-nav a').length === 3;
      if (!ready) return null;
      const links = [...header.querySelectorAll('a')].map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.innerText || '').replace(/\\s+/g, ' ').trim(),
          scroll: el.scrollWidth,
          client: el.clientWidth,
          left: rect.left,
          right: rect.right,
        };
      });
      const boxes = [...header.querySelectorAll('a, button')].map((el) => {
        const rect = el.getBoundingClientRect();
        return { key: el.id || (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 24), rect };
      }).filter((box) => box.rect.width > 1 && box.rect.height > 1);
      const overlaps = [];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          const a = boxes[i].rect;
          const b = boxes[j].rect;
          const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ix > 0.5 && iy > 0.5) overlaps.push([boxes[i].key, boxes[j].key]);
        }
      }
      const toggles = ['vip-debug-toggle', 'vip-diag-toggle'].map((id) => {
        const el = document.getElementById(id);
        const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { id, label: el.getAttribute('aria-label'), h: rect.height, hit: !!(hit && (hit === el || el.contains(hit))) };
      });
      const nav = document.querySelector('.v3-nav');
      const status = document.querySelector('.v3-header__status');
      const headerRect = header.getBoundingClientRect();
      return {
        links, overlaps, toggles,
        nav: { scroll: nav.scrollWidth, client: nav.clientWidth },
        status: { display: getComputedStyle(status).display, scroll: status.scrollWidth, client: status.clientWidth },
        header: { scroll: header.scrollWidth, client: header.clientWidth, left: headerRect.left, right: headerRect.right },
        viewport: window.innerWidth,
      };
    })()`;
    const settle = `document.fonts.ready.then(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))))`;
    let data = null;
    let last = null;
    // A loaded full-suite run can take a while to boot the page: allow 20 s.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const evaluated = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, send.sessionId);
      const now = evaluated.result && evaluated.result.value ? evaluated.result.value : null;
      if (now) {
        await send('Runtime.evaluate', { expression: settle, awaitPromise: true }, send.sessionId);
        // Two identical measurements in a row: fonts loaded and layout stable.
        const key = JSON.stringify(now);
        if (key === last) { data = now; break; }
        last = key;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!data) throw new Error(`landing header did not mount and settle at ${width}px (${last ? "mounted, layout kept changing" : "never mounted"})`);
    return data;
  }

  test.each([769, 1024, 1180, 1280, 1440])('no header link is clipped at %ipx', async (width) => {
    const data = await measure(width);
    expect(data.header.scroll).toBeLessThanOrEqual(data.header.client + 1);
    expect(data.nav.scroll).toBeLessThanOrEqual(data.nav.client + 1);
    if (data.status.display !== 'none') {
      expect(data.status.scroll).toBeLessThanOrEqual(data.status.client + 1);
    }
    const engineer = data.links.find((link) => link.text.includes('Engineer'));
    expect(engineer).toBeDefined();
    expect(engineer.text).toContain('Engineer');
    expect(engineer.scroll).toBeLessThanOrEqual(engineer.client + 1);
    expect(engineer.right).toBeLessThanOrEqual(data.header.right + 0.5);
    for (const link of data.links) {
      expect(link.scroll).toBeLessThanOrEqual(link.client + 1);
      expect(link.left).toBeGreaterThanOrEqual(data.header.left - 0.5);
      expect(link.right).toBeLessThanOrEqual(Math.min(data.header.right, data.viewport) + 0.5);
    }
    expect(data.overlaps).toEqual([]);
    for (const toggle of data.toggles) {
      expect(toggle.hit).toBe(true);
      expect(toggle.label.length).toBeGreaterThan(0);
    }
  }, 45000);

  test.each([375, 390, 768])('toolbar toggles do not overlap header controls at %ipx', async (width) => {
    const data = await measure(width);
    expect(data.overlaps).toEqual([]);
    for (const toggle of data.toggles) {
      expect(toggle.hit).toBe(true);
      expect(toggle.h).toBeGreaterThanOrEqual(44);
    }
    for (const link of data.links) {
      expect(link.scroll).toBeLessThanOrEqual(link.client + 1);
    }
  }, 45000);

  test('a second click on DBG still reaches the toggle when the header wraps', async () => {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
    }, send.sessionId);
    await send('Page.navigate', { url: `${origin}/` }, send.sessionId);
    const expr = `(() => {
      const btn = document.getElementById('vip-debug-toggle');
      const panel = document.getElementById('vip-debug-panel');
      if (!btn || !panel) return null;
      const hitAt = () => {
        const rect = btn.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return !!(hit && (hit === btn || btn.contains(hit)));
      };
      btn.click();
      const openHit = hitAt();
      const openTop = parseFloat(panel.style.top || '0');
      const btnBottom = btn.getBoundingClientRect().bottom;
      btn.click();
      return {
        openHit,
        closed: panel.classList.contains('hidden'),
        expanded: btn.getAttribute('aria-expanded'),
        panelClearsButton: openTop >= btnBottom - 0.5,
      };
    })()`;
    let data = null;
    for (let i = 0; i < 40; i += 1) {
      const evaluated = await send('Runtime.evaluate', { expression: expr, returnByValue: true }, send.sessionId);
      data = evaluated.result && evaluated.result.value ? evaluated.result.value : null;
      if (data) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    expect(data).not.toBeNull();
    expect(data.openHit).toBe(true);
    expect(data.panelClearsButton).toBe(true);
    expect(data.closed).toBe(true);
    expect(data.expanded).toBe('false');
  }, 45000);
});
