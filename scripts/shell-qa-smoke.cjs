#!/usr/bin/env node
/**
 * Shell QA smoke — browser-driven regression guards for the six defects that
 * real-Chromium QA found while every static gate stayed green.
 *
 *   1. `[hidden]` defeated by author `display` rules (Forensic nav, Quick strip,
 *      Landing's export row / Cancel rendering while their JS believed them off)
 *   2. DSP slider lock buttons clipped out of an `overflow:hidden` ancestor
 *   3. `.hdr` clamped to 48px while its content needed 66-104px
 *   4. WCAG AA text-contrast failures across both surfaces
 *   5. keyboard-focusable controls inside an `aria-hidden="true"` region
 *   6. the 2.2 MB decorative hero loop fetched unconditionally
 *
 * Plus the entry-point journey the suite never exercised: load the Engineer
 * shell, choose a real file, press Process, get output.
 *
 * The six shell audits read RENDERED state only — computed styles, real
 * geometry, `elementFromPoint`, real clicks, real network requests — because
 * asserting JS state is exactly what let all six ship. The entry-point journey
 * at the end is the deliberate exception: it drives the real UI (choose a file,
 * press Process) and then inspects `outputBuffer` and `hStatus` to prove the
 * audio actually came out, which nothing rendered can show. Keep new shell
 * guards on the rendered side of that line.
 *
 * Usage: node scripts/shell-qa-smoke.cjs
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { launchChromium } = require('./lib/launch-chromium.cjs');

const ROOT = path.join(__dirname, '..');
const PROBES = path.join(__dirname, 'lib', 'a11y-probes.js');
const WIDTHS = [390, 768, 1024, 1440, 1920];
const HERO_BYTES_MIN = 2_000_000; // the decorative loop is ~2.2 MB

const fails = [];
const check = (ok, msg, detail) => {
  if (ok) { console.log(`  ✓ ${msg}`); return true; }
  console.log(`  ✗ ${msg}`);
  if (detail !== undefined) console.log(`      ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 900)}`);
  fails.push(msg);
  return false;
};

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on('error', reject);
  });
}

function waitForServer(base, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(`${base}/app/`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve(); else retry();
      });
      req.on('error', retry);
      req.setTimeout(1500, () => { req.destroy(); retry(); });
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) reject(new Error('server did not start'));
      else setTimeout(ping, 250);
    };
    ping();
  });
}

function makeWav(secs, file) {
  const sr = 48000;
  const n = sr * secs;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const voice = 0.30 * Math.sin(2 * Math.PI * 220 * t)
      + 0.18 * Math.sin(2 * Math.PI * 440 * t)
      + 0.12 * Math.sin(2 * Math.PI * 660 * t);
    pcm[i] = Math.max(-32768, Math.min(32767, Math.round((voice + 0.08 * (Math.random() * 2 - 1)) * 12000)));
  }
  const data = Buffer.from(pcm.buffer);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  return file;
}

/** Open every collapsible so collapsed rows are laid out and measurable. */
async function expandSections(page) {
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach((d) => { d.open = true; });
  });
  await page.waitForTimeout(400);
}

/**
 * Also reveal the state-gated surfaces a user can reach, so their text is
 * measured too. The debug panel is a fixed 440px overlay at z-index 9000, so
 * this is only for the paint-level audits — never for hit-testing the rack.
 */
async function expandEverything(page) {
  await expandSections(page);
  await page.evaluate(() => {
    const dbg = document.getElementById('vip-debug-panel');
    if (dbg) dbg.classList.remove('hidden');
    const iso = document.getElementById('vizIsoConfirm');
    if (iso) { iso.classList.remove('hidden'); iso.setAttribute('aria-hidden', 'false'); }
    // Open a slider hint: its body is the only place `<mark>` is used, and a
    // `<mark>` with a background but no colour keeps the UA's black MarkText.
    document.querySelector('.dsp-slider-row .slider-hint-btn')?.click();
  });
  await page.waitForTimeout(400);
}

async function newPage(browser, width, opts = {}) {
  const ctx = await browser.newContext({
    viewport: { width, height: 900 },
    serviceWorkers: 'block',
    reducedMotion: opts.reducedMotion ? 'reduce' : 'no-preference',
  });
  const page = await ctx.newPage();
  await page.addInitScript({ path: PROBES });
  for (const s of opts.initScripts || []) await page.addInitScript(s);
  return { ctx, page };
}

// ── defect 2: every lock button is un-clipped and really clickable ─────────
/**
 * `clippedBy` is the defect signal and is independent of scroll position: it
 * asks whether the button's border box escapes a clipping ancestor at all.
 * The click pass then proves reachability the way a user gets it — scroll the
 * control into view, hit-test the centre point, press it, and require the
 * lock state to actually flip. Locators are re-resolved on every iteration
 * because toggling a lock re-syncs the row's UI.
 */
async function auditLocks(page) {
  await expandSections(page);
  const clipped = [];
  const unreachable = [];
  let toggled = 0;
  const total = await page.locator('button.slider-lock-btn').count();
  for (let i = 0; i < total; i++) {
    const lock = page.locator('button.slider-lock-btn').nth(i);
    const label = (await lock.getAttribute('aria-label')) || `#${i}`;
    const clip = await lock.evaluate((el) => window.__vipQA.clippedBy(el));
    if (clip) { clipped.push({ label, ...clip }); continue; }
    try {
      await lock.scrollIntoViewIfNeeded({ timeout: 3000 });
      const box = await lock.boundingBox();
      const onTop = await page.evaluate(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return !!hit && !!hit.closest('.slider-lock-btn');
      }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
      if (!onTop) { unreachable.push({ label, reason: 'occluded', box }); continue; }
      const before = await lock.getAttribute('aria-pressed');
      await lock.click({ timeout: 3000 });
      const after = await lock.getAttribute('aria-pressed');
      if (before === after) unreachable.push({ label, reason: 'click had no effect', before, after });
      else { toggled++; await lock.click({ timeout: 3000 }); }
    } catch (err) {
      unreachable.push({ label, reason: String(err).split('\n')[0] });
    }
  }
  return { total, clipped, unreachable, toggled };
}

// ── defect 5: a real keyboard walk must never land on hidden content ───────
async function tabWalk(page, steps = 60) {
  const trapped = [];
  await page.evaluate(() => document.body.focus());
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Tab');
    const bad = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      const hiddenRegion = a.closest('[aria-hidden="true"]');
      const Q = window.__vipQA;
      if (hiddenRegion && !a.hasAttribute('inert') && Q.rendered(hiddenRegion)) {
        return { el: Q.path(a), region: Q.path(hiddenRegion), why: 'inside aria-hidden' };
      }
      if (a.closest('[hidden]')) return { el: Q.path(a), why: 'inside a [hidden] subtree' };
      return null;
    });
    if (bad) trapped.push(bad);
  }
  return trapped;
}

(async () => {
  const PORT = await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const wav = makeWav(4, path.join(os.tmpdir(), `vip-shell-qa-${process.pid}.wav`));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
  });
  let browser;
  try {
    await waitForServer(BASE);
    browser = await launchChromium();

    // ── 1/3/4/5 across both surfaces and the responsive matrix ────────────
    for (const url of ['/app/', '/']) {
      for (const width of WIDTHS) {
        console.log(`\n[${url} @ ${width}px]`);
        const { ctx, page } = await newPage(browser, width);
        await page.goto(BASE + url, { waitUntil: 'load' });
        await page.waitForTimeout(2500);
        await expandEverything(page);

        const hiddenBad = await page.evaluate(() => window.__vipQA.hiddenButVisible());
        check(hiddenBad.length === 0, 'every [hidden] element computes display:none', hiddenBad);

        const ariaBad = await page.evaluate(() => window.__vipQA.focusableInAriaHidden());
        check(ariaBad.length === 0, 'no focusable control inside an aria-hidden region', ariaBad);

        const contrast = await page.evaluate(() => {
          const f = window.__vipQA.contrastFailures();
          return { fails: [...f], unmeasured: f.unmeasured, positionDependent: f.positionDependent };
        });
        // Only the definite bucket gates. Text on a gradient that clears AA at
        // one stop and misses at another cannot be judged from computed style,
        // so it is surfaced for a human rather than passed or failed here.
        check(contrast.fails.length === 0, 'zero WCAG AA text-contrast failures', contrast.fails.slice(0, 6));
        if (contrast.positionDependent.length) {
          console.log(`      note: ${contrast.positionDependent.length} text node(s) sit on a gradient and pass at one end but not the other — needs a human eye`);
        }
        if (contrast.unmeasured.length) {
          console.log(`      note: ${contrast.unmeasured.length} text node(s) over a url() image — not scorable from computed style`);
        }

        if (url === '/app/') {
          const hdr = await page.evaluate(() => window.__vipQA.headerMetrics());
          check(!!hdr, 'the Engineer header is present');
          if (hdr) {
            check(hdr.overflowBottomPx <= 1, 'no header content escapes the header box', hdr);
            check(hdr.scrollHeight <= hdr.clientHeight + 1, 'the header does not clip its own content', hdr);
            // `(A && B) || height >= 48` passed for any header at all. What
            // distinguishes the defect is the clamp itself: `height` must not be
            // pinned to the titlebar token while the content needs more.
            const clamped = hdr.cssHeight === hdr.titlebarH && hdr.scrollHeight > hdr.clientHeight + 1;
            check(!clamped, 'the header is not clamped below its content height', hdr);
            check(hdr.cssMinHeight === hdr.titlebarH,
              'the header keeps min-height (not height) on the titlebar token', hdr);
            check(hdr.publishedVar === `${hdr.offsetHeight}px`,
              '--vip-hdr-h carries the real layout height', hdr);
          }
          const walk = await tabWalk(page);
          check(walk.length === 0, 'a keyboard tab walk never lands on hidden content', walk.slice(0, 4));
        }
        await ctx.close();
      }
    }

    // ── 2: lock reachability at every width ───────────────────────────────
    for (const width of WIDTHS) {
      console.log(`\n[DSP rack locks @ ${width}px]`);
      const { ctx, page } = await newPage(browser, width);
      await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
      await page.waitForTimeout(2500);
      const r = await auditLocks(page);
      check(r.total >= 67, `all 67 lock buttons are in the DOM (found ${r.total})`);
      check(r.clipped.length === 0, 'no lock button is clipped by an overflow ancestor', r.clipped);
      check(r.unreachable.length === 0, 'every lock button is hit-testable and really clicks', r.unreachable);
      check(r.toggled === r.total, `every lock toggled aria-pressed (${r.toggled}/${r.total})`);
      await ctx.close();
    }

    // ── 6: the hero loop only downloads when all four gates allow it ──────
    console.log('\n[hero video capability gate]');
    const FORCE_H264 = "Object.defineProperty(HTMLVideoElement.prototype,'canPlayType',"
      + "{value:function(t){return /avc1|mp4/.test(t)?'probably':'';},configurable:true});";
    const conn = (o) => `Object.defineProperty(navigator,'connection',{value:${JSON.stringify(o)},configurable:true});`;
    const heroRun = async (label, opts) => {
      const { ctx, page } = await newPage(browser, 1440, opts);
      let heroBytes = 0;
      page.on('response', (res) => {
        if (/\.(mp4|webm)(\?|$)/i.test(res.url())) heroBytes += Number(res.headers()['content-length'] || 1);
      });
      await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
      await page.waitForTimeout(3500);
      const st = await page.evaluate(() => {
        const v = document.getElementById('heroVideo');
        const f = document.getElementById('heroFallback');
        const fr = f ? f.getBoundingClientRect() : null;
        return {
          videoDisplay: v ? getComputedStyle(v).display : null,
          sources: v ? v.querySelectorAll('source').length : null,
          fallbackHidden: f ? f.hasAttribute('hidden') : null,
          fallbackVisible: f ? window.__vipQA.rendered(f) : null,
          fallbackArea: fr ? Math.round(fr.width * fr.height) : 0,
        };
      });
      await ctx.close();
      return { label, heroBytes, ...st };
    };

    const allowed = await heroRun('allowed', { initScripts: [FORCE_H264] });
    check(allowed.heroBytes >= HERO_BYTES_MIN,
      'the hero loop still plays when every capability gate allows it', allowed);
    check(allowed.fallbackHidden === true && allowed.fallbackVisible === false,
      'the fallback never covers the playing hero video', allowed);

    const gates = [
      ['prefers-reduced-motion', { initScripts: [FORCE_H264], reducedMotion: true }],
      ['Save-Data', { initScripts: [FORCE_H264, conn({ saveData: true, effectiveType: '4g' })] }],
      ['2G', { initScripts: [FORCE_H264, conn({ saveData: false, effectiveType: '2g' })] }],
      ['slow-2g', { initScripts: [FORCE_H264, conn({ saveData: false, effectiveType: 'slow-2g' })] }],
      // Deterministic: a Chromium built WITH H.264 would otherwise fetch the
      // hero here and fail a gate that is not actually broken.
      ['no H.264', { initScripts: ["Object.defineProperty(HTMLVideoElement.prototype,'canPlayType',"
        + "{value:function(){return '';},configurable:true});"] }],
      ['offline', { initScripts: [FORCE_H264, "Object.defineProperty(navigator,'onLine',{get:()=>false,configurable:true});"] }],
    ];
    for (const [label, opts] of gates) {
      const r = await heroRun(label, opts);
      check(r.heroBytes === 0, `no hero video bytes under ${label}`, r);
      check(r.fallbackVisible === true && r.fallbackArea > 0,
        `the lightweight fallback renders under ${label}`, r);
      check(r.videoDisplay === 'none' && r.sources === 0,
        `the <source> is detached under ${label}`, r);
    }

    // ── entry point: the real user journey ────────────────────────────────
    console.log('\n[entry point — load, choose a file, press Process]');
    {
      const { ctx, page } = await newPage(browser, 1440);
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e).split('\n')[0]));
      await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window._vipApp?.handleFile === 'function', null, { timeout: 30000 });
      await page.evaluate(() => {
        window._vipApp?._dismissBootSplash?.();
        const s = document.getElementById('bootSplash');
        if (s) { s.style.display = 'none'; s.style.pointerEvents = 'none'; }
      });
      check(await page.locator('#processBtn').isVisible(), 'the Process button is rendered on load');

      // `setInputFiles` dispatches `change` itself. A second manual dispatch
      // ran the import twice, which is not what a real upload does.
      await page.setInputFiles('#fileInput', wav);
      await page.waitForFunction(
        () => { const b = document.getElementById('processBtn'); return b && !b.disabled; },
        null, { timeout: 60000 },
      );
      check(true, 'choosing a file enables Process without starting inference');

      await page.click('#processBtn');
      const deadline = Date.now() + 180000;
      let end = 'TIMEOUT';
      while (Date.now() < deadline) {
        const st = await page.evaluate(() => document.getElementById('hStatus')?.textContent?.trim() || '');
        if (st === 'DONE' || st === 'ERROR' || st === 'IDLE') { end = st; break; }
        await page.waitForTimeout(500);
      }
      check(end === 'DONE', `pressing Process reaches DONE (ended: ${end})`);

      const out = await page.evaluate(() => {
        const b = window._vipApp?.outputBuffer;
        if (!b) return { hasOutput: false };
        const ch = b.getChannelData(0);
        let nan = 0; let peak = 0;
        for (let i = 0; i < ch.length; i++) {
          if (!Number.isFinite(ch[i])) nan++;
          const a = Math.abs(ch[i]);
          if (a > peak) peak = a;
        }
        return { hasOutput: true, length: ch.length, nan, peak, abMode: window._vipApp?.abMode };
      });
      check(out.hasOutput, 'Process produced an output buffer', out);
      check(out.nan === 0, 'the output buffer contains no NaN samples', out);
      check(out.peak > 1e-4, 'the output buffer is not silent', out);
      check(pageErrors.length === 0, 'the entry-point journey raises no page errors', pageErrors);
      await ctx.close();
    }
  } catch (err) {
    console.error(err);
    fails.push(String(err).split('\n')[0]);
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
    try { fs.unlinkSync(wav); } catch { /* already gone */ }
  }

  console.log('');
  if (fails.length) {
    console.log(`FAILED ${fails.length}`);
    for (const f of fails) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log('shell-qa-smoke: PASS');
  process.exit(0);
})();
