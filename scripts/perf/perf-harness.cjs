#!/usr/bin/env node
/**
 * Runtime performance / stability harness (real Chromium).
 *
 * Drives the shipping entry points (Engineer `/app/`, Landing `/`) through
 * upload -> Process -> (cancel) -> Process -> clear cycles and records, per run:
 * processing wall time + RTF, long tasks, the longest main-thread gap seen by a
 * 16 ms interval heartbeat, cancel latency, live Worker / AudioContext counts
 * (constructor/terminate/close are wrapped before any app script runs), JS heap
 * after a forced GC, and Chromium process-tree RSS.
 *
 * It asserts only stability (no hang, no crash, no page error, bounded workers
 * and contexts). Timings are recorded, never thresholded: they are machine
 * specific. Output: output/performance/perf-<surface>-<stamp>.json
 *
 * Usage:
 *   node scripts/perf/perf-harness.cjs --surface engineer --secs 10,60 --cycles 3
 *   node scripts/perf/perf-harness.cjs --surface landing --secs 30 --cancel
 *   flags: --sr 44100|48000  --channels 1|2  --cancel  --cycles N  --headed
 *          --no-ml  (blocks MLWorker.js so Engineer measures its DSP fallback path)
 *          --mobile (Pixel 7 viewport/UA/touch + CPU throttle, default 4x;
 *                    --cpu-throttle N overrides the rate)
 */
'use strict';

/* global document, window, performance, PerformanceObserver */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { launchChromium } = require('../lib/launch-chromium.cjs');

const ROOT = path.join(__dirname, '..', '..');
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);

const SURFACE = arg('surface', 'engineer');
const SECS = String(arg('secs', '10')).split(',').map(Number).filter((n) => n > 0);
const SR = Number(arg('sr', '48000'));
const CH = Number(arg('channels', '2'));
const CYCLES = Number(arg('cycles', '1'));
const DO_CANCEL = has('cancel');
const NO_ML = has('no-ml');
const HEADED = has('headed');
const PROFILE = has('profile');
const TRACE = has('trace');
const MARKER = `vip-perf-${process.pid}-${Date.now()}`;
const SETTLE = Number(arg('settle', '0'));
const MOBILE = has('mobile');
const CPU_THROTTLE = Number(arg('cpu-throttle', MOBILE ? '4' : '1'));
{
  const bad = [];
  if (!['engineer', 'landing'].includes(SURFACE)) bad.push(`--surface ${SURFACE}`);
  if (!SECS.length || SECS.some((n) => !Number.isFinite(n))) bad.push('--secs (positive numbers, comma separated)');
  if (![8000, 16000, 22050, 32000, 44100, 48000, 96000].includes(SR)) bad.push(`--sr ${SR}`);
  if (![1, 2].includes(CH)) bad.push(`--channels ${CH}`);
  if (!Number.isInteger(CYCLES) || CYCLES < 1) bad.push(`--cycles ${CYCLES}`);
  if (!Number.isFinite(SETTLE) || SETTLE < 0) bad.push(`--settle ${SETTLE}`);
  if (!Number.isFinite(CPU_THROTTLE) || CPU_THROTTLE < 1) bad.push(`--cpu-throttle ${CPU_THROTTLE}`);
  if (bad.length) {
    console.error(`invalid arguments: ${bad.join(', ')}`);
    process.exit(2);
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    s.on('error', reject);
  });
}

function waitForServer(base, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const ping = () => {
      const req = http.get(`${base}/`, (res) => { res.resume(); (res.statusCode < 500 ? resolve : retry)(); });
      req.on('error', retry);
      req.setTimeout(1500, () => { req.destroy(); retry(); });
    };
    const retry = () => (Date.now() - start > timeoutMs ? reject(new Error('server timeout')) : setTimeout(ping, 250));
    ping();
  });
}

const fixtures = [];

/** Speech-like fixture: harmonic voiced bursts with pauses over broadband noise. */
function makeWav(secs, sr, ch) {
  const file = path.join(os.tmpdir(), `vip-perf-${process.pid}-${secs}s-${sr}-${ch}ch.wav`);
  if (fs.existsSync(file)) return file;
  const n = Math.round(sr * secs);
  const pcm = new Int16Array(n * ch);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.max(0, Math.sin(2 * Math.PI * 1.7 * t)) ** 0.5;
    const f0 = 140 + 30 * Math.sin(2 * Math.PI * 0.3 * t);
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin(2 * Math.PI * f0 * h * t) / h;
    const s = 0.25 * env * v + 0.06 * rnd();
    for (let c = 0; c < ch; c++) pcm[i * ch + c] = Math.max(-32768, Math.min(32767, Math.round(s * 26000)));
  }
  const data = Buffer.from(pcm.buffer);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * ch * 2, 28); h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(`${file}.tmp`, Buffer.concat([h, data]));
  fs.renameSync(`${file}.tmp`, file);
  fixtures.push(file);
  return file;
}

/** Sum RSS (MB) of the Chromium process tree started with our marker flag. */
function chromiumRssMb() {
  try {
    const rows = execSync('ps -eo pid=,ppid=,rss=,args=', { encoding: 'utf8', maxBuffer: 1 << 24 })
      .split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
      .map((m) => ({ pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] }));
    const root = rows.find((r) => r.args.includes(MARKER) && !rows.some((p) => p.pid === r.ppid && p.args.includes(MARKER)));
    if (!root) return null;
    const tree = new Set([root.pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const r of rows) if (!tree.has(r.pid) && tree.has(r.ppid)) { tree.add(r.pid); grew = true; }
    }
    return Math.round(rows.filter((r) => tree.has(r.pid)).reduce((a, r) => a + r.rss, 0) / 1024);
  } catch { return null; }
}

/** Installed before any page script: resource counters + responsiveness probes. */
function instrument() {
  const P = { workersLive: 0, workersMade: 0, ctxLive: 0, ctxMade: 0, offlineMade: 0, longTasks: [], gaps: [] };
  window.__vipPerf = P;
  const NativeWorker = window.Worker;
  if (NativeWorker) {
    window.Worker = class extends NativeWorker {
      constructor(...a) {
        super(...a);
        P.workersMade++; P.workersLive++;
        this.__vipUrl = String(a[0]);
        (P.workerUrls ||= []).push(this.__vipUrl);
      }
      terminate() {
        if (!this.__vipDead) { this.__vipDead = true; P.workersLive--; }
        return super.terminate();
      }
    };
  }
  const wrapCtx = (Name, offline) => {
    const Native = window[Name];
    if (!Native) return;
    window[Name] = class extends Native {
      constructor(...a) {
        super(...a);
        if (offline) { P.offlineMade++; return; }
        P.ctxMade++; P.ctxLive++;
      }
      close() {
        if (!this.__vipClosed) { this.__vipClosed = true; P.ctxLive--; }
        return super.close();
      }
    };
  };
  wrapCtx('AudioContext', false);
  wrapCtx('webkitAudioContext', false);
  wrapCtx('OfflineAudioContext', true);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) P.longTasks.push({ t: Math.round(e.startTime), d: Math.round(e.duration) });
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* unsupported */ }
  // Event-loop heartbeat: a 16 ms timer; gap - 16 is the stall the user feels.
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const gap = now - last;
    if (gap > 66) P.gaps.push({ t: Math.round(last), d: Math.round(gap) });
    last = now;
  }, 16);
}

function summarize(list, from, to) {
  const xs = list.filter((x) => x.t >= from && x.t <= to).map((x) => x.d);
  return {
    count50: xs.filter((d) => d > 50).length,
    count100: xs.filter((d) => d > 100).length,
    count250: xs.filter((d) => d > 250).length,
    max: xs.length ? Math.max(...xs) : 0,
    total: xs.reduce((a, b) => a + b, 0),
  };
}

/**
 * Self time per function from a CDP CPU profile, plus the functions that own
 * the longest contiguous non-idle stretch (what a long task is made of).
 */
function hotspots(profile, pt0, longTasks = []) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const label = (n) => {
    const f = n.callFrame;
    return `${f.functionName || '(anon)'} ${(f.url || '').replace(/^.*?\/\/[^/]+/, '')}:${f.lineNumber + 1}`;
  };
  const self = new Map();
  const deltas = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const k = label(n);
    self.set(k, (self.get(k) || 0) + (deltas[i + 1] || 0) / 1000);
  }
  const top = [...self.entries()].filter(([k]) => !/^\((idle|program|garbage collector)\)/.test(k))
    .sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, ms]) => `${ms.toFixed(0)}ms ${k}`);
  // Longest busy stretch: consecutive samples whose leaf is not (idle).
  let best = { ms: 0, from: 0, to: 0 };
  let cur = 0; let start = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]);
    const idle = n.callFrame.functionName === '(idle)';
    const d = (deltas[i + 1] || 0) / 1000;
    if (idle) { cur = 0; start = i + 1; continue; }
    cur += d;
    if (cur > best.ms) best = { ms: cur, from: start, to: i };
  }
  const inclusive = new Map();
  for (let i = best.from; i <= best.to; i++) {
    const seen = new Set();
    let id = profile.samples[i];
    const d = (deltas[i + 1] || 0) / 1000;
    while (id != null) {
      const k = label(byId.get(id));
      if (!seen.has(k)) { seen.add(k); inclusive.set(k, (inclusive.get(k) || 0) + d); }
      id = parent.get(id);
    }
  }
  const longest = [...inclusive.entries()].filter(([k]) => !/^\((root|program)\)/.test(k))
    .sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, ms]) => `${ms.toFixed(0)}ms ${k}`);
  // Per long task: inclusive time by function for samples inside its window.
  // Profile timestamps are monotonic us; align its start to pt0 (page ms).
  const ts = [];
  let acc = profile.startTime;
  for (const d of deltas) { acc += d; ts.push((acc - profile.startTime) / 1000 + pt0); }
  const tasks = [...longTasks].sort((a, b) => b.d - a.d).slice(0, 3).map((lt) => {
    const inc = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
      if (ts[i] < lt.t - 2 || ts[i] > lt.t + lt.d + 2) continue;
      const seen = new Set();
      const d = (deltas[i + 1] || 0) / 1000;
      let id = profile.samples[i];
      while (id != null) {
        const k = label(byId.get(id));
        if (!seen.has(k)) { seen.add(k); inc.set(k, (inc.get(k) || 0) + d); }
        id = parent.get(id);
      }
    }
    return { t: lt.t, d: lt.d, stack: [...inc.entries()].filter(([k]) => !/^\((root|program)\)/.test(k))
      .sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, ms]) => `${ms.toFixed(0)}ms ${k}`) };
  });
  return { top, longestBusyMs: Math.round(best.ms), longest, tasks };
}

/** Renderer main-thread RunTasks > 250 ms with the trace events nested in them. */
function summarizeTrace(trace) {
  const evs = (trace.traceEvents || trace).filter((e) => e.ph === 'X' && e.dur);
  const threads = new Map();
  for (const e of evs) if (e.name === 'RunTask' && e.dur > 250000) {
    const key = `${e.pid}:${e.tid}`;
    (threads.get(key) || threads.set(key, []).get(key)).push(e);
  }
  const out = [];
  for (const [key, tasks] of threads) {
    for (const t of tasks) {
      const inside = new Map();
      for (const e of evs) {
        if (`${e.pid}:${e.tid}` !== key || e === t || e.ts < t.ts || e.ts + e.dur > t.ts + t.dur) continue;
        const name = e.name + (e.args?.data?.functionName ? `:${e.args.data.functionName}` : '')
          + (e.args?.data?.url ? `@${String(e.args.data.url).replace(/^.*\/\/[^/]+/, '')}:${e.args.data.lineNumber ?? ''}` : '');
        inside.set(name, (inside.get(name) || 0) + e.dur / 1000);
      }
      out.push({ thread: key, ms: Math.round(t.dur / 1000), top: [...inside.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n, ms]) => `${ms.toFixed(0)}ms ${n}`) });
    }
  }
  return out.sort((a, b) => b.ms - a.ms).slice(0, 6);
}

async function gcHeapMb(cdp) {
  try {
    await cdp.send('HeapProfiler.collectGarbage');
    const { usedSize } = await cdp.send('Runtime.getHeapUsage');
    return Math.round(usedSize / 1048576);
  } catch { return null; }
}

const ENGINEER = {
  url: '/app/',
  async ready(page) {
    await page.waitForFunction(() => typeof window._vipApp?.handleFile === 'function', null, { timeout: 60000 });
    await page.evaluate(() => {
      window._vipApp?._dismissBootSplash?.();
      const s = document.getElementById('bootSplash');
      if (s) { s.style.display = 'none'; s.style.pointerEvents = 'none'; }
    });
  },
  async upload(page, file) {
    await page.setInputFiles('#fileInput', file);
    await page.waitForFunction(() => { const b = document.getElementById('processBtn'); return b && !b.disabled; }, null, { timeout: 120000 });
  },
  // Phones hide the panel actions row; Process lives in the sticky mobile bar.
  async start(page) { await page.locator('#processBtn:visible, #mobileProcessBtn:visible').first().click(); },
  state: (page) => page.evaluate(() => ({
    status: document.getElementById('hStatus')?.textContent?.trim() || '',
    busy: Boolean(window._vipApp?.isProcessing),
    ok: Boolean(window._vipApp?.outputBuffer),
    ml: window._vipApp?._mlIsolationSucceeded,
  })),
  done: (s) => !s.busy && (s.status === 'DONE' || s.status === 'ERROR' || s.status === 'IDLE'),
  success: (s) => s.status === 'DONE' && s.ok,
  async cancel(page) {
    await page.evaluate(() => {
      const b = document.getElementById('procCancelBtn');
      if (b && b.offsetParent) b.click(); else window._vipApp.cancelActiveJobs();
    });
  },
  idle: (s) => !s.busy,
  async clear(page) {
    await page.evaluate(() => {
      const app = window._vipApp;
      app._clearFile();
    });
  },
};

const LANDING = {
  url: '/',
  async ready(page) {
    await page.waitForFunction(() => (document.getElementById('statusText')?.textContent || '').includes('Idle'), null, { timeout: 60000 });
  },
  async upload(page, file) {
    await page.setInputFiles('#fileInput', file);
    await page.waitForFunction(() => { const b = document.getElementById('processBtn'); return b && !b.disabled; }, null, { timeout: 120000 });
  },
  async start(page) { await page.click('#processBtn', { force: true }); },
  state: (page) => page.evaluate(() => {
    const status = (document.getElementById('statusText')?.textContent || '').trim();
    const cancel = document.getElementById('cancelProcessBtn');
    return { status, busy: Boolean(cancel && !cancel.hidden), ok: status.includes('Stems ready') };
  }),
  done: (s) => !s.busy && (s.ok || /fail|error|cancel/i.test(s.status)),
  success: (s) => s.ok,
  async cancel(page) { await page.click('#cancelProcessBtn', { force: true }); },
  idle: (s) => !s.busy,
  async clear() { /* Landing has no clear-file control; next upload replaces the source. */ },
};

async function waitFor(page, S, pred, timeoutMs) {
  const t0 = Date.now();
  let s;
  while (Date.now() - t0 < timeoutMs) {
    s = await S.state(page);
    if (pred(s)) return { s, ms: Date.now() - t0 };
    await page.waitForTimeout(25);
  }
  return { s, ms: null };
}

async function main() {
  const S = SURFACE === 'landing' ? LANDING : ENGINEER;
  const PORT = await getFreePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  const cleanup = () => { try { server.kill('SIGTERM'); } catch { /* noop */ } };
  process.on('exit', cleanup);
  await waitForServer(BASE);

  const browser = await launchChromium({
    headless: !HEADED,
    args: ['--no-sandbox', '--enable-precise-memory-info', '--js-flags=--expose-gc', `--${MARKER}`],
  });
  const runs = [];
  const errors = [];
  let crashed = false;
  let baseline = null;
  let fatal = null;
  let page = null;
  // Teardown and the report always happen, including after a renderer crash.
  try {
    const ctx = await browser.newContext(MOBILE ? { ...require('playwright').devices['Pixel 7'] } : {});
    if (NO_ML) await ctx.route('**/src/workers/MLWorker.js', (r) => r.abort());
    page = await ctx.newPage();
    await page.addInitScript(instrument);
    // Optional ad-hoc probe (diagnostics only): VIP_PERF_PROBE=/path/probe.js
    if (process.env.VIP_PERF_PROBE) await page.addInitScript({ path: process.env.VIP_PERF_PROBE });
    const cdp = await ctx.newCDPSession(page);
    if (CPU_THROTTLE > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`); });
    page.on('crash', () => { crashed = true; });

    await page.goto(`${BASE}${S.url}`, { waitUntil: 'load' });
    await S.ready(page);
    await page.waitForTimeout(1500);
    baseline = { heapMb: await gcHeapMb(cdp), rssMb: chromiumRssMb(), res: await page.evaluate(() => ({ ...window.__vipPerf, longTasks: undefined, gaps: undefined })) };

    for (const secs of SECS) {
      const file = makeWav(secs, SR, CH);
      for (let cycle = 1; cycle <= CYCLES; cycle++) {
        const run = { secs, cycle, sr: SR, channels: CH };
        const tUp = Date.now();
        await S.upload(page, file);
        run.uploadMs = Date.now() - tUp;

        if (DO_CANCEL) {
          await S.start(page);
          await page.waitForTimeout(Number(arg('cancel-after', String(Math.min(4000, 600 + secs * 40)))));
          const t0 = Date.now();
          await S.cancel(page);
          const w = await waitFor(page, S, S.idle, 60000);
          run.cancelMs = w.ms ?? Date.now() - t0;
          run.cancelSettled = w.ms != null;
          run.cancelStatus = w.s?.status;
          await page.waitForTimeout(300);
          await page.waitForFunction(() => { const b = document.getElementById('processBtn'); return b && !b.disabled; }, null, { timeout: 30000 }).catch(() => {});
        }

        const pt0 = await page.evaluate(() => performance.now());
        let peakRss = chromiumRssMb() || 0;
        if (TRACE) await browser.startTracing(page, { categories: ['devtools.timeline', 'v8', 'v8.execute', 'blink.user_timing', 'disabled-by-default-devtools.timeline'] });
        if (PROFILE) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
        const t0 = Date.now();
        await S.start(page);
        const timeout = Math.max(240000, secs * 8000);
        let s;
        let lastRss = 0;
        while (Date.now() - t0 < timeout && !crashed) {
          s = await S.state(page);
          if (S.done(s) && Date.now() - t0 > 300) break;
          // `ps` is a full process-table scan: sample RSS once a second.
          if (Date.now() - lastRss >= 1000) {
            peakRss = Math.max(peakRss, chromiumRssMb() || 0);
            lastRss = Date.now();
          }
          await page.waitForTimeout(100);
        }
        run.processMs = Date.now() - t0;
        run.ptEnd = await page.evaluate(() => performance.now());
        if (TRACE) run.traceTasks = summarizeTrace(JSON.parse((await browser.stopTracing()).toString()));
        if (PROFILE) {
          // --settle: keep sampling through the post-Process idle work.
          if (SETTLE > 0) await page.waitForTimeout(SETTLE);
          // Read long tasks first: serialising the profile is itself a long task.
          const PL = await page.evaluate(() => window.__vipPerf.longTasks);
          const { profile } = await cdp.send('Profiler.stop');
          run.hotspots = hotspots(profile, pt0, PL.filter((x) => x.t >= pt0));
          const dir = path.join(ROOT, 'output', 'performance');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${SURFACE}-${secs}s-c${cycle}.cpuprofile`), JSON.stringify(profile));
        }
        run.rtf = +(run.processMs / 1000 / secs).toFixed(4);
        run.final = s;
        run.engine = await page.evaluate(() => window._vipApp?._processingEngine ?? null).catch(() => null);
        run.stageMs = await page.evaluate(() => ({ ...(globalThis.__vipStageTimings || {}) })).catch(() => null);
        run.success = Boolean(s && S.success(s));
        run.hung = !s || !S.done(s);
        const pt1 = run.ptEnd ?? await page.evaluate(() => performance.now());
        delete run.ptEnd;
        const P = await page.evaluate(() => window.__vipPerf);
        run.longTasks = summarize(P.longTasks, pt0, pt1);
        run.heartbeatGaps = summarize(P.gaps, pt0, pt1);
        run.peakRssMb = peakRss;

        // Let post-Process idle work (auto-calibrate, analysis) run as it would
        // for a user who keeps the file loaded: it is part of the Process cost.
        // (With --profile the settle window already elapsed above.)
        if (!PROFILE) await page.waitForTimeout(SETTLE);
        if (SETTLE > 0) {
          const late = await page.evaluate(() => window.__vipPerf.longTasks);
          run.settleLongTaskMax = Math.max(0, ...late.filter((x) => x.t >= pt1 - 1).map((x) => x.d));
        }
        await S.clear(page);
        await page.waitForTimeout(500);
        const R = await page.evaluate(() => window.__vipPerf);
        run.workersLive = R.workersLive;
        run.workersMade = R.workersMade;
        run.audioCtxLive = R.ctxLive;
        run.audioCtxMade = R.ctxMade;
        run.offlineCtxMade = R.offlineMade;
        run.heapAfterGcMb = await gcHeapMb(cdp);
        run.rssAfterMb = chromiumRssMb();
        runs.push(run);
        console.log(JSON.stringify({
          secs, cycle, ok: run.success, engine: run.engine, stages: run.stageMs, ms: run.processMs, rtf: run.rtf, cancelMs: run.cancelMs,
          lt: run.longTasks.max, settleLt: run.settleLongTaskMax, lt100: run.longTasks.count100, gap: run.heartbeatGaps.max,
          heap: run.heapAfterGcMb, rss: run.rssAfterMb, peakRss, w: run.workersLive, ctx: run.audioCtxLive, st: s?.status,
        }));
        if (crashed) break;
      }
      if (crashed) break;
    }
  } catch (err) {
    fatal = err;
  }

  // Never evaluate in a crashed page; it would hang until the protocol timeout.
  const probe = crashed || !page ? null : await page.evaluate(() => window.__vipProbe || null).catch(() => null);
  const workerUrls = crashed || !page ? [] : await page.evaluate(() => window.__vipPerf.workerUrls || []).catch(() => []);
  const report = {
    surface: SURFACE, sr: SR, channels: CH, cancel: DO_CANCEL, cycles: CYCLES, headed: HEADED,
    mobile: MOBILE, cpuThrottle: CPU_THROTTLE,
    commit: (() => { try { return execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } })(),
    crashed, fatal: fatal ? String(fatal.stack || fatal) : null, baseline, runs, workerUrls, probe, errors: errors.slice(0, 50),
  };
  const outDir = path.join(ROOT, 'output', 'performance');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `perf-${SURFACE}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`report: ${path.relative(ROOT, out)}`);

  await browser.close().catch(() => {});
  cleanup();
  for (const f of fixtures) { try { fs.unlinkSync(f); } catch { /* already gone */ } }

  const failures = [];
  if (fatal) failures.push(`harness error: ${fatal.message || fatal}`);
  if (crashed) failures.push('renderer crashed');
  for (const r of runs) {
    if (r.hung) failures.push(`${r.secs}s cycle ${r.cycle}: did not finish (${r.final?.status})`);
    else if (!r.success) failures.push(`${r.secs}s cycle ${r.cycle}: ended ${r.final?.status}`);
    if (NO_ML && SURFACE === 'engineer' && r.engine !== 'dsp-fallback') {
      failures.push(`${r.secs}s cycle ${r.cycle}: --no-ml ran engine '${r.engine}', not the DSP fallback`);
    }
    if (DO_CANCEL && !r.cancelSettled) failures.push(`${r.secs}s cycle ${r.cycle}: cancel never settled`);
  }
  // Growth = the later half of the runs needs more live resources than the
  // earlier half ever did. A transient analysis worker alive at one sample is
  // not growth; a count that keeps climbing is.
  if (runs.length >= 4) {
    const half = Math.floor(runs.length / 2);
    const peak = (xs, k) => Math.max(...xs.map((r) => r[k]));
    for (const [k, label] of [['workersLive', 'live workers'], ['audioCtxLive', 'live AudioContexts']]) {
      const early = peak(runs.slice(0, half), k);
      const late = Math.min(...runs.slice(half).map((r) => r[k]));
      if (late > early) failures.push(`${label} grew: early peak ${early}, late floor ${late}`);
    }
  }
  const pageErrors = errors.filter((e) => e.startsWith('pageerror'));
  if (pageErrors.length) failures.push(`${pageErrors.length} uncaught page error(s): ${pageErrors[0]}`);
  if (failures.length) {
    console.error('FAIL\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  console.log('PASS');
}

main().catch((e) => { console.error(e); process.exit(1); });
