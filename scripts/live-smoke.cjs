#!/usr/bin/env node
/**
 * Live integration smoke test.
 *
 * Boots the dev server (server.js), launches headless Chromium via
 * Playwright, drives the actual app at http://localhost:<port>/app/ with
 * a synthetic voice-like input, runs `app.runPipeline()` end-to-end, and
 * asserts numeric properties of the output that catch garbling regressions
 * (NaN, dead silence, clipping, frame-to-frame partial instability).
 *
 * Usage:
 *   pnpm test:live
 *   PORT=3001 pnpm test:live
 *   LIVE_HEADLESS=false pnpm test:live   # show the browser
 *
 * Prerequisites:
 *   - pnpm install   (brings in playwright)
 *   - npx playwright install chromium
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HEADLESS = process.env.LIVE_HEADLESS !== 'false';
const SERVER_BOOT_TIMEOUT_MS = 20000;
const PIPELINE_TIMEOUT_MS = 60000;

// ── Playwright ──────────────────────────────────────────────────────────
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (e) {
  console.error('[test:live] playwright is not installed. Run `pnpm install` first.');
  process.exit(2);
}

// ── Spawn dev server ─────────────────────────────────────────────────────
const serverProc = spawn(process.execPath, ['server.js'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
serverProc.stdout.on('data', d => { serverLog += d.toString(); });
serverProc.stderr.on('data', d => { serverLog += d.toString(); });

let cleaned = false;
function cleanup(code) {
  if (cleaned) return;
  cleaned = true;
  try { serverProc.kill('SIGTERM'); } catch (_) { /* noop */ }
  // Force-kill if it doesn't exit promptly.
  setTimeout(() => { try { serverProc.kill('SIGKILL'); } catch (_) { /* noop */ } }, 2000).unref();
  process.exit(code);
}
process.on('SIGINT',  () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));

// ── Wait for server health ───────────────────────────────────────────────
async function waitForServer() {
  const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const req = http.get({ host: '127.0.0.1', port: PORT, path: '/app/', timeout: 1000 }, res => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

// ── In-page test routine (runs inside Chromium) ──────────────────────────
async function runInPage(page) {
  return page.evaluate(async () => {
    const app = window._vipApp;
    if (!app) return { error: '_vipApp missing' };

    const sr = 48000;
    const len = sr * 3;
    if (!app.ctx) {
      app.ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: sr });
    }
    const buf = app.ctx.createBuffer(1, len, sr);
    const ch = buf.getChannelData(0);
    const f0 = 220;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const voice =
        0.30 * Math.sin(2 * Math.PI * f0 * t) +
        0.18 * Math.sin(2 * Math.PI * 2 * f0 * t) +
        0.12 * Math.sin(2 * Math.PI * 3 * f0 * t);
      const noise = 0.10 * (Math.random() * 2 - 1);
      ch[i] = voice + noise;
    }
    app.inputBuffer = buf;

    // No-op the progress UI so it doesn't await rAF on a hidden tab.
    app.pip = async () => {};
    // Stub mobile DOM cells the pipeline touches but headless doesn't render.
    const stub = document.createElement('button');
    stub.style.display = 'none';
    document.body.appendChild(stub);
    ['mobileProcessBtn', 'mobileReprocessBtn', 'mobileStopBtn'].forEach(k => {
      if (!app.dom[k]) app.dom[k] = stub;
    });

    const t0 = performance.now();
    await app.runPipeline();
    const elapsed = performance.now() - t0;

    if (!app.outputBuffer) return { error: 'no outputBuffer after runPipeline' };
    const outCh = app.outputBuffer.getChannelData(0);

    let nan = 0, peak = 0, sumSq = 0;
    for (let i = 0; i < outCh.length; i++) {
      const v = outCh[i];
      if (!Number.isFinite(v)) nan++;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / outCh.length);

    // Frame-to-frame magnitude variance at the input partials. Steady-state
    // input → steady-state output magnitudes; high CoV here would indicate
    // shimmer / "garble" regressions in the spectral path.
    const FFT = 1024, HOP = 256;
    const frames = Math.floor((outCh.length - FFT) / HOP) + 1;
    const w = new Float32Array(FFT);
    for (let i = 0; i < FFT; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / FFT));
    const re = new Float32Array(FFT), im = new Float32Array(FFT);
    function fft(reA, imA) {
      const N = reA.length;
      for (let i = 1, j = 0; i < N; i++) {
        let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
        if (i < j) { let t = reA[i]; reA[i] = reA[j]; reA[j] = t; t = imA[i]; imA[i] = imA[j]; imA[j] = t; }
      }
      for (let l = 2; l <= N; l <<= 1) {
        const half = l >> 1, ang = -2 * Math.PI / l;
        const wR = Math.cos(ang), wI = Math.sin(ang);
        for (let i = 0; i < N; i += l) {
          let cR = 1, cI = 0;
          for (let k = 0; k < half; k++) {
            const tR = cR * reA[i+k+half] - cI * imA[i+k+half];
            const tI = cR * imA[i+k+half] + cI * reA[i+k+half];
            reA[i+k+half] = reA[i+k] - tR; imA[i+k+half] = imA[i+k] - tI;
            reA[i+k] += tR; imA[i+k] += tI;
            const nR = cR * wR - cI * wI; cI = cR * wI + cI * wR; cR = nR;
          }
        }
      }
    }
    const targetFreqs = [220, 440, 660];
    const targetBins = targetFreqs.map(f => Math.round(f * FFT / sr));
    const trajectories = targetBins.map(() => []);
    for (let f = 0; f < frames; f++) {
      const off = f * HOP;
      for (let i = 0; i < FFT; i++) { re[i] = outCh[off + i] * w[i]; im[i] = 0; }
      fft(re, im);
      for (let t = 0; t < targetBins.length; t++) {
        const k = targetBins[t];
        trajectories[t].push(Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      }
    }
    const cov = trajectories.map(traj => {
      if (traj.length < 2) return 0;
      const mean = traj.reduce((a, b) => a + b, 0) / traj.length;
      if (mean < 1e-6) return 0;
      let v = 0; for (const x of traj) v += (x - mean) * (x - mean);
      return Math.sqrt(v / traj.length) / mean;
    });

    return {
      sampleRate: sr,
      lengthSamples: outCh.length,
      runMs: Math.round(elapsed),
      nanCount: nan,
      peak,
      rms,
      partials: targetFreqs.map((freq, i) => ({
        freq,
        meanMag: trajectories[i].reduce((a, b) => a + b, 0) / trajectories[i].length,
        cov: cov[i],
      })),
    };
  });
}

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  console.log(`[test:live] starting dev server on port ${PORT}…`);
  if (!(await waitForServer())) {
    console.error('[test:live] dev server did not start within timeout.');
    console.error(serverLog);
    cleanup(1);
    return;
  }
  console.log('[test:live] server ready · launching Chromium…');

  let browser;
  try {
    browser = await chromium.launch({
      headless: HEADLESS,
      args: [
        '--no-sandbox',
        '--enable-features=SharedArrayBuffer',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
  } catch (e) {
    console.error('[test:live] failed to launch Chromium:', e.message);
    console.error('Run: npx playwright install chromium');
    cleanup(2);
    return;
  }

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const consoleMsgs = [];
  page.on('console',  m => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', e => consoleMsgs.push(`[pageerror] ${e.message}`));

  let result;
  try {
    await page.goto(`http://127.0.0.1:${PORT}/app/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window._vipApp, null, { timeout: 15000 });
    result = await Promise.race([
      runInPage(page),
      new Promise((_, reject) => setTimeout(() => reject(new Error('pipeline timeout')), PIPELINE_TIMEOUT_MS)),
    ]);
  } catch (e) {
    console.error('[test:live] error:', e.message);
    console.error('--- recent browser console ---');
    for (const m of consoleMsgs.slice(-30)) console.error(m);
    await browser.close().catch(() => {});
    cleanup(1);
    return;
  }
  await browser.close();

  console.log('\n=== pipeline result ===');
  console.log(JSON.stringify(result, null, 2));

  // Pass/fail criteria.
  const partialCovOk = result.partials && result.partials.every(p => p.cov < 0.6);
  const ok =
    result &&
    !result.error &&
    result.nanCount === 0 &&
    result.peak > 0 && result.peak <= 1.001 &&
    result.rms > 0.01 &&
    partialCovOk;

  console.log(`\n[test:live] ${ok ? 'PASS ✓' : 'FAIL ✗'}`);
  if (!ok) {
    console.error('--- recent browser console ---');
    for (const m of consoleMsgs.slice(-30)) console.error(m);
  }
  cleanup(ok ? 0 : 1);
})().catch(e => {
  console.error('[test:live] unexpected error:', e);
  cleanup(1);
});
