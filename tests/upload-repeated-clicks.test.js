/**
 * Repeated clicks on the upload controls, Stems (/) and Engineer (/app/),
 * desktop Chrome and Android emulation (touch, 384x832, Android UA).
 *
 * Randy (Nov 24): "clicking the upload button only works some of the time" on
 * both pages. Each control gets 20+ clicks: re-picking the same file, cancel
 * then click again, quick double-clicks / double-taps, a rejected file picked
 * twice, and a failed ingest followed by a good one. Every click must open the
 * picker exactly once and every pick must reach the page once.
 *
 * On main this failed in two ways:
 *  - one double-click / double-tap asked Chrome for two pickers (Stems Browse,
 *    Engineer "Upload Audio or Video"): Stems' #uploadZone handler re-ran
 *    fileInput.click() for the label's own activation click, and nothing
 *    stopped a second activation while the first picker was open;
 *  - a pick the page refused kept the input's value, so choosing the same
 *    file again fired no change event and the click "did nothing".
 *
 * Real browser via Playwright (Node environment, not jsdom); a `filechooser`
 * event is one picker request from the renderer.
 */
'use strict';
/* global window, document, addEventListener, globalThis */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
jest.setTimeout(600000);

function chromeBinary() {
  if (process.env.VIP_CHROMIUM_PATH) return process.env.VIP_CHROMIUM_PATH;
  return ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }) || undefined;
}

function wavBytes(seconds = 1) {
  const sr = 48000; const n = sr * seconds; const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / sr)), 44 + i * 2);
  return b;
}

// 1x1 PNG: every upload page refuses images before ingest.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const CONTROLS = {
  'stems Browse': { url: '/', button: '#browseBtn', page: 'stems' },
  'engineer Browse': { url: '/app/', button: '#fileBtn', page: 'engineer' },
  'engineer Upload Audio or Video': { url: '/app/', button: '#heroCtaUpload', page: 'engineer' },
};
const DEVICES = {
  desktop: { viewport: { width: 1400, height: 900 } },
  android: {
    viewport: { width: 384, height: 832 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S928U) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  },
};

let playwright = null;
try { playwright = require('playwright'); } catch { playwright = null; }
const run = playwright && chromeBinary() ? describe : describe.skip;

run('upload controls survive repeated clicks (Stems + Engineer, desktop + Android)', () => {
  let server; let browser; let origin; let tmp; let good; let bad; let image;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-clicks-'));
    good = path.join(tmp, 'tone.wav'); fs.writeFileSync(good, wavBytes());
    bad = path.join(tmp, 'broken.mp4'); fs.writeFileSync(bad, Buffer.from('not media '.repeat(200)));
    image = path.join(tmp, 'cover.png'); fs.writeFileSync(image, PNG);
    const port = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); });
    });
    server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, NODE_ENV: 'development', PORT: String(port) }, stdio: 'ignore' });
    origin = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 200; i += 1) {
      try { const r = await fetch(`${origin}/app/`); if (r.ok) break; } catch { /* booting */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    browser = await playwright.chromium.launch({ executablePath: chromeBinary(), args: ['--no-sandbox', '--disable-gpu'] });
  });

  afterAll(async () => {
    try { await browser?.close(); } catch { /* ignore */ }
    try { server?.kill(); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  for (const [controlName, control] of Object.entries(CONTROLS)) {
    for (const [deviceName, dev] of Object.entries(DEVICES)) {
      test(`${controlName} / ${deviceName}: one picker per click, one ingest per pick, 22 clicks`, async () => {
        const ctx = await browser.newContext(dev);
        await ctx.addInitScript(() => {
          // Stems counts FileIngestion's ingest.start; Engineer counts handleFile().
          window.__ingests = 0;
          window.__changes = 0;
          addEventListener('vip:ingestion-debug', (e) => { if (e.detail?.stage === 'ingest.start' && !window._vipApp) window.__ingests += 1; });
          document.addEventListener('change', (e) => { if (e.target?.id === 'fileInput') window.__changes += 1; }, true);
          setInterval(() => {
            const app = window._vipApp;
            if (app && typeof app.handleFile === 'function' && !app.__countWrapped) {
              const original = app.handleFile.bind(app);
              app.handleFile = (...args) => { window.__ingests += 1; return original(...args); };
              app.__countWrapped = true;
            }
          }, 10);
        });
        const page = await ctx.newPage();
        const choosers = [];
        page.on('filechooser', (fc) => choosers.push(fc));
        try {
          await page.goto(origin + control.url, { waitUntil: 'load' });
          if (control.page === 'engineer') {
            await page.waitForFunction(() => window._vipApp?.__countWrapped && document.getElementById('fileInput')?.dataset.vipAppChangeBound === '1', null, { timeout: 60000 });
          } else {
            await page.waitForFunction(() => (globalThis.VIP_liveDiagnostics?.entries || []).some((e) => e.event === 'stems.boot'), null, { timeout: 60000 });
          }
          await page.evaluate(() => { try { window._vipApp?._dismissBootSplash?.(); } catch { /* ignore */ } document.getElementById('bootSplash')?.remove(); });
          await page.waitForTimeout(1500);

          const counters = () => page.evaluate(() => ({ ingests: window.__ingests, changes: window.__changes }));
          let clicks = 0;
          // Click where the user sees the control; fail loudly if something covers it.
          async function press({ double = false } = {}) {
            const at = await page.evaluate((sel) => {
              const b = document.querySelector(sel);
              b.scrollIntoView({ block: 'center', behavior: 'instant' });
              const r = b.getBoundingClientRect();
              const x = r.left + r.width / 2; const y = r.top + r.height / 2;
              const top = document.elementFromPoint(x, y);
              return { x, y, onButton: !!top && (top === b || b.contains(top)), top: top ? `${top.tagName}#${top.id}.${top.className}` : null };
            }, control.button);
            expect(at.onButton ? 'button' : at.top).toBe('button');
            const n = double ? 2 : 1;
            for (let i = 0; i < n; i += 1) {
              if (i) await page.waitForTimeout(90);
              if (dev.hasTouch) await page.touchscreen.tap(at.x, at.y);
              else await page.mouse.click(at.x, at.y);
              clicks += 1;
            }
          }
          async function attempt(file, opts = {}) {
            const before = choosers.length;
            const start = await counters();
            await press(opts);
            await page.waitForTimeout(600);
            const opened = choosers.length - before;
            if (opened > 0) {
              const chooser = choosers[choosers.length - 1];
              if (file === 'cancel') await page.evaluate(() => document.getElementById('fileInput').dispatchEvent(new Event('cancel')));
              else await chooser.setFiles(file);
            }
            const want = file === 'cancel' ? 0 : 1;
            for (let i = 0; i < 25; i += 1) {
              const now = await counters();
              if (now.changes - start.changes >= want && (file !== good || now.ingests - start.ingests >= 1)) break;
              await page.waitForTimeout(100);
            }
            await page.waitForTimeout(file === good ? 1500 : 800); // let the ingest settle before the next click
            const end = await counters();
            return { opened, changes: end.changes - start.changes, ingests: end.ingests - start.ingests };
          }

          // Same file six times in a row.
          for (let i = 0; i < 6; i += 1) expect(await attempt(good)).toEqual({ opened: 1, changes: 1, ingests: 1 });
          // Cancel the picker, then click again.
          for (let i = 0; i < 3; i += 1) {
            expect(await attempt('cancel')).toEqual({ opened: 1, changes: 0, ingests: 0 });
            expect(await attempt(good)).toEqual({ opened: 1, changes: 1, ingests: 1 });
          }
          // Quick double-click / double-tap: still one picker, one ingest.
          for (let i = 0; i < 3; i += 1) expect(await attempt(good, { double: true })).toEqual({ opened: 1, changes: 1, ingests: 1 });
          // A refused file picked twice must reach the page both times.
          expect((await attempt(image)).changes).toBe(1);
          expect((await attempt(image)).changes).toBe(1);
          // A failed ingest, then a good file.
          expect((await attempt(bad)).opened).toBe(1);
          expect(await attempt(good)).toEqual({ opened: 1, changes: 1, ingests: 1 });
          expect(clicks).toBeGreaterThanOrEqual(20);
        } finally {
          await ctx.close();
        }
      });
    }
  }
});
