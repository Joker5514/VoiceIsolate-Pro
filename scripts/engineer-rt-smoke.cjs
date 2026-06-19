#!/usr/bin/env node
/**
 * Engineer Mode real-time slider smoke test.
 *
 * Boots server.js, opens the actual /app/ Engineer Mode page in headless
 * Chromium, and verifies that the rt:true sliders now apply in REAL TIME via
 * the Live-Mix bridge (src/pipeline/EngineerModeBridge.js) — i.e. moving a
 * slider during playback changes a live AudioParam, with no Reprocess and no
 * ML re-run. This is the regression guard for the orchestrator-removal fix.
 *
 * Usage: node scripts/engineer-rt-smoke.cjs   (PORT=xxxx to override)
 * Prereqs: pnpm install && npx playwright install chromium
 */
// `window` is referenced only inside page.evaluate (browser context).
/* global window */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const PORT = parseInt(process.env.PORT || '3471', 10);
const BASE = `http://127.0.0.1:${PORT}`;
const HEADLESS = process.env.SMOKE_HEADLESS !== 'false';

let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.error('[engineer-rt-smoke] playwright missing — run pnpm install && npx playwright install chromium'); process.exit(2); }

const serverProc = spawn(process.execPath, ['server.js'], {
  cwd: path.resolve(__dirname, '..'),
  env: { ...process.env, PORT: String(PORT) },
  // Ignore the child's streams: this test pings over HTTP and never reads the
  // server log, so leaving stdout/stderr piped could fill the OS buffer and hang.
  stdio: 'ignore',
});
let cleaned = false;
function cleanup(code) {
  if (cleaned) return; cleaned = true;
  try { serverProc.kill('SIGTERM'); } catch { /* noop */ }
  setTimeout(() => { try { serverProc.kill('SIGKILL'); } catch { /* noop */ } }, 2000).unref();
  process.exit(code);
}
process.on('SIGINT', () => cleanup(130));
process.on('SIGTERM', () => cleanup(143));

function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(`${BASE}/app/`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) resolve();
        else retry();
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

const pass = []; const fail = [];
function check(name, ok, detail = '') {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` (${detail})` : ''}`);
}

(async () => {
  await waitForServer();
  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newContext().then((c) => c.newPage());
  const errors = [];
  // Only JS errors matter here; the frozen legacy /app/ page makes external
  // integration calls (firebase/revenuecat) that fail with network/cert errors
  // in this sandbox — those are pre-existing and unrelated to the slider fix.
  const isEnvNoise = (t) => /ERR_CERT|Failed to load resource|net::ERR|ERR_NAME_NOT_RESOLVED|firebase|revenuecat/i.test(t);
  page.on('console', (m) => { if (m.type() === 'error' && !isEnvNoise(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => { if (!isEnvNoise(String(e))) errors.push(String(e)); });

  console.log('\n🎚️  Engineer Mode — real-time slider smoke\n');
  await page.goto(`${BASE}/app/`, { waitUntil: 'domcontentloaded' });

  // Wait for the app instance to come up.
  await page.waitForFunction(() => !!window._vipApp, null, { timeout: 15000 });

  // Drive the app: create the context+bridge, load a synthetic processed buffer,
  // start playback, then move sliders and read the bridge's live AudioParams.
  const result = await page.evaluate(async () => {
    const app = window._vipApp;
    await app.ensureCtx();
    // Ensure the Live-Mix bridge is up (dynamic import + shared context).
    const bridge = await app._ensureBridge();
    if (!bridge) return { bridgeReady: false };

    // Synthesize a 1 s stereo processed buffer and load it as the output.
    const sr = app.ctx.sampleRate;
    const buf = app.ctx.createBuffer(2, sr, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) d[i] = Math.sin(2 * Math.PI * 220 * i / sr) * 0.25;
    }
    app.outputBuffer = buf;
    app.procBuffer = buf;
    app.abMode = 'processed';
    window.VIP_PARAMS = window.VIP_PARAMS || {};

    // Start playback through the bridge.
    app.play();
    await new Promise((r) => setTimeout(r, 120));

    const mix = bridge.mixer;

    // Helper: move a slider via onSlider (the same path the DOM 'input' uses).
    const move = (id, v) => { window.VIP_PARAMS[id] = v; app.onSlider(id, v); };

    // Move several rt sliders during playback.
    move('eqMid', 9);
    move('outGain', 6);
    move('dryWet', 40);
    move('specTilt', 3);
    move('limThresh', -3);
    move('compRatio', 8);
    move('stereoWidth', 150);
    // Let the live setTargetAtTime ramps settle (tau≈30 ms → ~10 tau).
    await new Promise((r) => setTimeout(r, 400));

    return {
      bridgeReady: true,
      playing: bridge.isPlaying(),
      duration: bridge.duration(),
      eqMidGain: mix.graphicBands.get('mid').gain.value,
      outputTrim: mix.outputTrim.gain.value,
      wet: mix.wetGain.gain.value,
      dry: mix.dryGain.gain.value,
      tiltHigh: mix.tiltHigh.gain.value,
      limiterRatio: mix.limiter.ratio.value,
      limiterThreshold: mix.limiter.threshold.value,
      compRatio: mix.compressor.ratio.value,
      width: mix.widthGain.gain.value,
    };
  });

  check('Live-Mix bridge instantiates in /app/', result.bridgeReady === true);
  if (result.bridgeReady) {
    check('playback running through the bridge', result.playing === true);
    check('buffer loaded (≈1 s)', Math.abs(result.duration - 1) < 0.05, `${result.duration}s`);
    check('eqMid slider → graphic-EQ band live', Math.abs(result.eqMidGain - 9) < 0.001, `gain ${result.eqMidGain}`);
    check('outGain slider → output trim live', Math.abs(result.outputTrim - Math.pow(10, 6 / 20)) < 0.01, `${result.outputTrim.toFixed(3)}`);
    check('dryWet slider → wet/dry cross-fade live', Math.abs(result.wet - 0.4) < 0.001 && Math.abs(result.dry - 0.6) < 0.001, `wet ${result.wet} / dry ${result.dry}`);
    check('specTilt slider → tilt shelves live', Math.abs(result.tiltHigh - 3) < 0.001, `tiltHigh ${result.tiltHigh}`);
    check('limThresh slider → limiter engaged (20:1)', Math.abs(result.limiterRatio - 20) < 0.05 && Math.abs(result.limiterThreshold + 3) < 0.05, `ratio ${result.limiterRatio}, thr ${result.limiterThreshold}`);
    check('compRatio slider → compressor live', Math.abs(result.compRatio - 8) < 0.001, `ratio ${result.compRatio}`);
    check('stereoWidth slider → width live', Math.abs(result.width - 1.5) < 0.001, `width ${result.width}`);
  }
  check('no console errors', errors.length === 0, errors[0] || '');

  await browser.close();
  console.log(`\n${fail.length === 0 ? '✅ Engineer Mode RT: ALL CHECKS PASSED' : `❌ ${fail.length} CHECK(S) FAILED`}\n`);
  cleanup(fail.length === 0 ? 0 : 1);
})().catch((err) => { console.error('[engineer-rt-smoke] fatal:', err); cleanup(1); });
