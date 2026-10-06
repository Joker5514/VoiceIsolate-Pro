#!/usr/bin/env node
/**
 * Engineer Mode upload smoke — Browse + file decode + video card wiring.
 */
'use strict';

/* global window, document */

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function waitForServer(base, timeoutMs = 20000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(`${base}/app/`, (res) => {
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

async function ensureAppReady(page) {
  await page.waitForFunction(
    () => typeof window._vipApp?.handleFile === 'function' && !!document.getElementById('fileInput'),
    null,
    { timeout: 20000 },
  );
  await page.evaluate(() => {
    window._vipApp?._dismissBootSplash?.();
    const splash = document.getElementById('bootSplash');
    if (splash && splash.dataset.dismissed !== '1') {
      splash.dataset.dismissed = '1';
      splash.style.pointerEvents = 'none';
      splash.style.display = 'none';
    }
  });
}

async function ingestWav(page, wavPath) {
  // Prefer File constructor + handleFile — more reliable than setInputFiles on
  // hidden inputs with long accept= lists across Playwright/Chromium builds.
  const bytes = fs.readFileSync(wavPath);
  await page.evaluate(async (arr) => {
    const u8 = new Uint8Array(arr);
    const file = new File([u8], 'vip-engineer-smoke.wav', { type: 'audio/wav' });
    await window._vipApp.handleFile(file);
  }, [...bytes]);
}

async function readUploadDiag(page) {
  return page.evaluate(() => ({
    hasApp: Boolean(window._vipApp),
    hasHandleFile: typeof window._vipApp?.handleFile === 'function',
    bufferLen: window._vipApp?.inputBuffer?.length ?? 0,
    fileInfo: document.getElementById('fileInfo')?.textContent || '',
    splashDismissed: document.getElementById('bootSplash')?.dataset?.dismissed || '',
    processDisabled: document.getElementById('processBtn')?.disabled ?? true,
  }));
}

function makeWav() {
  const sr = 48000, secs = 1, n = sr * secs;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    pcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * (i / sr)) * 16000);
  }
  const data = Buffer.from(pcm.buffer);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sr, 24); header.writeUInt32LE(sr * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  const file = path.join(os.tmpdir(), 'vip-engineer-smoke.wav');
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

function readWavChannel0(bytes) {
  let off = 12, fmt = null;
  while (off + 8 <= bytes.length) {
    const id = bytes.toString('ascii', off, off + 4);
    const size = bytes.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { format: bytes.readUInt16LE(body), channels: bytes.readUInt16LE(body + 2), bits: bytes.readUInt16LE(body + 14) };
    } else if (id === 'data' && fmt) {
      const step = (fmt.bits / 8) * fmt.channels;
      const n = Math.floor(size / step);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const p = body + i * step;
        if (fmt.format === 3) out[i] = bytes.readFloatLE(p);
        else if (fmt.bits === 16) out[i] = bytes.readInt16LE(p) / 32768;
        else if (fmt.bits === 24) out[i] = bytes.readIntLE(p, 3) / 8388608;
        else out[i] = bytes.readInt32LE(p) / 2147483648;
      }
      return out;
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV has no data chunk');
}

const rms = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / Math.max(1, x.length));

async function exportProcessedWav(page) {
  await page.waitForFunction(() => {
    const b = document.getElementById('saveProcBtn');
    return b && !b.disabled && !b.hasAttribute('aria-busy');
  }, null, { timeout: 60000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.evaluate(() => {
      const app = window._vipApp;
      if (!app.__smokeNotify) {
        const orig = app.showNotification.bind(app);
        app.__smokeNotify = true;
        app.showNotification = (msg, kind) => { console.log(`[smoke-notify] ${kind}: ${msg}`); return orig(msg, kind); };
      }
      document.getElementById('saveProcBtn').click();
    }),
  ]);
  return readWavChannel0(fs.readFileSync(await download.path()));
}

async function setSlider(page, id, value) {
  await page.evaluate(([sid, v]) => {
    const el = document.getElementById('sl_' + sid);
    if (!el) throw new Error('missing slider ' + sid);
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, value]);
}

(async () => {
  const PORT = Number(process.env.SMOKE_PORT) || await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const wavPath = makeWav();
  const fails = [];

  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } };
  process.on('exit', cleanup);

  await waitForServer(BASE);
  // Shared launcher so images whose pre-installed Chromium revision differs
  // from the pinned Playwright build can still run the upload smoke.
  const { launchChromium } = require('./lib/launch-chromium.cjs');
  const browser = await launchChromium({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (process.env.SMOKE_DEBUG) page.on('console', (m) => console.log('   [console]', m.type(), m.text().slice(0, 300)));

  try {
    await page.goto(`${BASE}/app/`, { waitUntil: 'load' });
    await ensureAppReady(page);
    await ingestWav(page, wavPath);

    // Upload may remain deferred as _sourceFile or may already be decoded into
    // input/origBuffer. Either state is Process-ready when the button is enabled.
    try {
      await page.waitForFunction(
        () => {
          const app = window._vipApp;
          const hasInput = Boolean(app?._sourceFile || app?.inputBuffer?.length || app?.origBuffer?.length);
          return hasInput && !document.getElementById('processBtn')?.disabled;
        },
        null,
        { timeout: 15000 },
      );
    } catch (waitErr) {
      const diag = await readUploadDiag(page);
      throw new Error(`source not ready for Process: ${JSON.stringify(diag)} (${waitErr.message})`);
    }

    // Exercise Process path: decode + ML isolation must complete without freeze.
    await page.evaluate(() => window._vipApp.runPipeline());
    try {
      await page.waitForFunction(
        () => {
          const app = window._vipApp;
          if (!app) return false;
          if (app.isProcessing) return false;
          const status = (document.getElementById('hStatus')?.textContent || '').trim();
          const out = app.outputBuffer?.length || app.procBuffer?.length || 0;
          return status === 'DONE' || status === 'ERROR' || out > 0;
        },
        null,
        { timeout: 120000 },
      );
    } catch (procErr) {
      const diag = await page.evaluate(() => ({
        status: document.getElementById('hStatus')?.textContent,
        detail: document.getElementById('pipeDetail')?.textContent,
        isProcessing: window._vipApp?.isProcessing,
        inputLen: window._vipApp?.inputBuffer?.length || 0,
        outLen: window._vipApp?.outputBuffer?.length || window._vipApp?.procBuffer?.length || 0,
      }));
      throw new Error(`process did not complete: ${JSON.stringify(diag)} (${procErr.message})`);
    }

    const state = await page.evaluate(() => ({
      hasSource: Boolean(window._vipApp?._sourceFile),
      hasBuffer: Boolean(window._vipApp?.inputBuffer?.length),
      hasOut: Boolean(window._vipApp?.outputBuffer?.length || window._vipApp?.procBuffer?.length),
      fileInfo: document.getElementById('fileInfo')?.textContent || '',
      processEnabled: !document.getElementById('processBtn')?.disabled,
      status: (document.getElementById('hStatus')?.textContent || '').trim(),
      mlOk: window._vipApp?._mlIsolationSucceeded,
    }));

    if (!state.hasSource && !state.hasBuffer) fails.push('no source after upload');
    if (!state.processEnabled && state.status !== 'DONE') fails.push('processBtn still disabled after load');
    if (!state.fileInfo.includes('vip-engineer-smoke')) fails.push(`fileInfo unexpected: ${state.fileInfo}`);
    if (!state.hasBuffer) fails.push('inputBuffer not decoded after Process');
    if (!state.hasOut && state.status !== 'DONE') fails.push('no processed output after Process');
    if (state.status === 'ERROR') fails.push('pipeline ended in ERROR');

    // AUD-001: the exported file must be the Live-Mix the user hears, not the
    // bare clean stem. Let post-Process idle work settle, then move a Live-Mix
    // control and compare two real downloads plus the playback graph's render.
    await page.waitForTimeout(2500);
    await page.waitForFunction(() => {
      const b = document.getElementById('saveProcBtn');
      return b && !b.disabled && !b.hasAttribute('aria-busy');
    }, null, { timeout: 60000 });
    await setSlider(page, 'outGain', 0);
    const exp0 = await exportProcessedWav(page);
    await setSlider(page, 'outGain', -12);
    const expMinus12 = await exportProcessedWav(page);
    const liveRender = await page.evaluate(async () => {
      const app = window._vipApp;
      const out = await app._bridge.mixer.renderMix();
      return Array.from(out.getChannelData(0));
    });
    const deltaDb = 20 * Math.log10(rms(expMinus12) / Math.max(1e-12, rms(exp0)));
    if (!(Math.abs(deltaDb + 12) <= 1)) fails.push(`export ignores outGain: -12 dB slider moved export by ${deltaDb.toFixed(2)} dB`);
    let maxDelta = 0;
    const n = Math.min(liveRender.length, expMinus12.length);
    if (Math.abs(liveRender.length - expMinus12.length) > 1) fails.push(`export length ${expMinus12.length} != Live-Mix ${liveRender.length}`);
    for (let i = 0; i < n; i++) maxDelta = Math.max(maxDelta, Math.abs(liveRender[i] - expMinus12[i]));
    // 16-bit quantisation bound.
    if (!(maxDelta <= 2 / 32768)) fails.push(`export differs from playback Live-Mix render by ${maxDelta}`);
    console.log(`  ✓ export follows Live-Mix outGain: ${deltaDb.toFixed(2)} dB for -12 dB; maxDelta vs playback graph ${maxDelta.toExponential(2)}`);

    console.log('  ✓ audio upload accepted (deferred or eager decode)');
    console.log('  ✓ Process enabled after upload');
    console.log(`  ✓ Process completed — status=${state.status} ml=${state.mlOk} out=${state.hasOut}`);
    console.log(`  ✓ fileInfo: ${state.fileInfo}`);
  } finally {
    await browser.close();
    cleanup();
  }

  if (errors.length) fails.push(`page errors: ${errors.join(' | ')}`);
  if (fails.length) {
    console.error('\n❌ Engineer upload smoke failed:\n', fails.join('\n'));
    process.exit(1);
  }
  console.log('\n✅ Engineer upload smoke: ALL CHECKS PASSED\n');
})().catch((e) => {
  console.error('[engineer-upload-smoke] fatal:', e);
  process.exit(1);
});