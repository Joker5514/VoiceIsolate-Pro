/**
 * Upload button on both upload pages: Stems (/) and Engineer (/app/), on
 * desktop Chrome and Android emulation (touch, 384x832, Android UA).
 *
 * Randy: "check the upload button on both pages and fix". Engineer on main:
 * the button opened the picker, but every pick ran handleFile() twice
 * (mobile-upload-fix.js bound its fallback change listener before app.js set
 * vipAppChangeBound, and only checked the flag at bind time), and one desktop
 * drop ran it three times (#uploadZone and its parent #dropZone both ingested,
 * plus the same fallback race on drop).
 *
 * Real browser via Playwright (Node environment, not jsdom) for real layout,
 * hit-testing and the native filechooser event.
 */
'use strict';
/* global window, document, addEventListener, DataTransfer, DragEvent, File, atob, globalThis */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
jest.setTimeout(240000);

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

const PAGES = {
  stems: { url: '/', button: '#browseBtn', zone: '#uploadZone' },
  engineer: { url: '/app/', button: '#fileBtn', zone: '#uploadZone' },
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

run('upload button on Stems and Engineer, desktop and Android emulation', () => {
  let server;
  let browser;
  let origin;
  let tmp;
  let good;
  let bad;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-upload-'));
    good = path.join(tmp, 'tone.wav'); fs.writeFileSync(good, wavBytes());
    bad = path.join(tmp, 'broken.mp4'); fs.writeFileSync(bad, Buffer.from('not media '.repeat(200)));
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

  async function openPage(pageName, deviceName) {
    const pg = PAGES[pageName];
    const dev = DEVICES[deviceName];
    const ctx = await browser.newContext(dev);
    await ctx.addInitScript(() => {
      // Ingests started: Stems counts FileIngestion's ingest.start; Engineer
      // counts handleFile() calls (its decode is deferred behind the library).
      window.__ingests = 0;
      addEventListener('vip:ingestion-debug', (e) => { if (e.detail?.stage === 'ingest.start' && !window._vipApp) window.__ingests += 1; });
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
    await page.goto(origin + pg.url, { waitUntil: 'load' });
    if (pageName === 'engineer') {
      await page.waitForFunction(() => window._vipApp?.__countWrapped && document.getElementById('fileInput')?.dataset.vipAppChangeBound === '1', null, { timeout: 60000 });
    } else {
      await page.waitForFunction(() => (globalThis.VIP_liveDiagnostics?.entries || []).some((e) => e.event === 'stems.boot'), null, { timeout: 60000 });
    }
    await page.evaluate(() => { try { window._vipApp?._dismissBootSplash?.(); } catch { /* ignore */ } document.getElementById('bootSplash')?.remove(); });
    await page.waitForTimeout(1500); // late compatibility layers (mobile-upload-fix polls)
    const button = page.locator(pg.button).first();
    await button.scrollIntoViewIfNeeded();
    const press = () => (dev.hasTouch ? button.tap({ timeout: 5000 }) : button.click({ timeout: 5000 }));
    const ingests = () => page.evaluate(() => window.__ingests);
    async function pick(file) {
      const before = choosers.length;
      await press();
      await page.waitForTimeout(800);
      const opened = choosers.length - before;
      const start = await ingests();
      if (opened > 0) await choosers[choosers.length - 1].setFiles(file);
      await page.waitForTimeout(2500);
      return { opened, ingests: (await ingests()) - start };
    }
    return { ctx, page, pg, dev, pick, ingests };
  }

  for (const pageName of Object.keys(PAGES)) {
    for (const deviceName of Object.keys(DEVICES)) {
      test(`${pageName} / ${deviceName}: hit-test, picker, one ingest per pick, re-pick, recovers after a failed ingest`, async () => {
        const { ctx, page, pg, pick } = await openPage(pageName, deviceName);
        try {
          const hit = await page.evaluate((sel) => {
            const b = document.querySelector(sel);
            const r = b.getBoundingClientRect();
            const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            const input = document.getElementById('fileInput');
            return {
              visible: r.width > 0 && r.height > 0,
              topIsButton: !!top && (top === b || b.contains(top)),
              top: top ? `${top.tagName}#${top.id}` : null,
              labelFor: b.getAttribute('for'),
              labelControl: b.control?.id || null,
              accept: (input.getAttribute('accept') || '').split(','),
            };
          }, pg.button);
          expect(hit.visible).toBe(true);
          expect(hit.top && hit.topIsButton ? 'button' : hit.top).toBe('button');
          expect(hit.labelFor).toBe('fileInput');
          expect(hit.labelControl).toBe('fileInput');
          for (const type of ['audio/*', 'video/*', 'video/mp4', '.mp4']) expect(hit.accept).toContain(type);

          expect(await pick(good)).toEqual({ opened: 1, ingests: 1 });
          // Same file again: the input value is reset, so change fires again.
          expect(await pick(good)).toEqual({ opened: 1, ingests: 1 });
          // A file that fails ingest must not leave the control disabled.
          expect((await pick(bad)).opened).toBe(1);
          expect(await page.evaluate(() => document.getElementById('fileInput').disabled)).toBe(false);
          expect(await pick(good)).toEqual({ opened: 1, ingests: 1 });
        } finally {
          await ctx.close();
        }
      });
    }
    test(`${pageName} / desktop: one drag-and-drop runs one ingest`, async () => {
      const { ctx, page, pg, ingests } = await openPage(pageName, 'desktop');
      try {
        const start = await ingests();
        await page.evaluate(({ sel, b64 }) => {
          const zone = document.querySelector(sel);
          const bin = atob(b64); const u = new Uint8Array(bin.length);
          for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i);
          const dt = new DataTransfer();
          dt.items.add(new File([u], 'dropped.wav', { type: 'audio/wav' }));
          const r = zone.getBoundingClientRect();
          const opts = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 10, clientY: r.top + 10 };
          for (const type of ['dragenter', 'dragover', 'drop']) zone.dispatchEvent(new DragEvent(type, opts));
        }, { sel: pg.zone, b64: wavBytes().toString('base64') });
        await page.waitForTimeout(2500);
        expect((await ingests()) - start).toBe(1);
      } finally {
        await ctx.close();
      }
    });
  }
});
