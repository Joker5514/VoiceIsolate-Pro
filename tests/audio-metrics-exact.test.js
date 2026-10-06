'use strict';

/**
 * The header Voice % / Noise % / SNR read-out uses every sample (no
 * subsampling), computed in yielding chunks off the progress tick. The two
 * methods are lifted out of app.js and run against stub buffers.
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const appSrc = fs.readFileSync(path.join(__dirname, '../public/app/app.js'), 'utf8');

function extractMethod(src, signature) {
  const start = src.indexOf(`\n  ${signature}`);
  if (start < 0) throw new Error(`missing ${signature}`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  return src.slice(start, i + 1);
}

let Metrics;
let bump;

beforeAll(async () => {
  const { processInChunks } = await import(
    pathToFileURL(path.join(__dirname, '../src/pipeline/ui-yield.js')).href
  );
  const body = extractMethod(appSrc, '_audioMetricSums(orig, proc, o, p, n) {')
    + extractMethod(appSrc, '_computeAudioMetricsState() {');
  // The real identity + revision helpers, lifted from app.js.
  const helpers = appSrc.slice(appSrc.indexOf('const _bufferRevisions = new WeakMap();'),
    appSrc.indexOf('const LARGE_FILE_WARNING_BYTES'));
  const made = new Function('processInChunks', 'cachedChannelData', 'structuredLog',
    `${helpers}; return { Metrics: class { ${body} }, bumpBufferRevision };`)(
    processInChunks, (buf, ch) => buf.getChannelData(ch), () => {});
  Metrics = made.Metrics;
  bump = made.bumpBufferRevision;
});

const buf = (d) => ({ sampleRate: 48000, duration: d.length / 48000, getChannelData: () => d });

function exact(o, p) {
  let oSq = 0; let pSq = 0; let noise = 0;
  for (let i = 0; i < o.length; i++) {
    oSq += o[i] * o[i]; pSq += p[i] * p[i];
    const r = o[i] - p[i]; noise += r * r;
  }
  const n = o.length;
  const voicePct = Math.max(0, Math.min(100, (pSq / (pSq + noise + 1e-12)) * 100));
  let snrDb = 20 * Math.log10((Math.sqrt(pSq / n) + 1e-10) / (Math.sqrt(noise / n) + 1e-10));
  snrDb = Math.max(-40, Math.min(60, snrDb));
  return { voicePct, noisePct: Math.max(0, Math.min(100, 100 - voicePct)), snrDb, oRms: Math.sqrt(oSq / n), pRms: Math.sqrt(pSq / n) };
}

test('header metrics equal a full-sample computation, then repaint', async () => {
  const n = 48000 * 20;
  const o = new Float32Array(n);
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    o[i] = Math.sin(i * 0.02) * 0.3 + ((i * 7919) % 17) / 400;
    p[i] = Math.sin(i * 0.02) * 0.28;
  }
  // A burst strictly between two points of the old 1-in-120 grid
  // (500040 and 500160 are on it): subsampling never sees it.
  for (let i = 500_041; i < 500_160; i++) o[i] = 0.95;

  const app = new Metrics();
  app.origBuffer = buf(o);
  app.outputBuffer = buf(p);
  app.abMode = 'processed';
  let repaint;
  const repainted = new Promise((r) => { repaint = r; });
  app.updateAudioMetrics = () => repaint();

  expect(app._computeAudioMetricsState()).toEqual({ voicePct: null, noisePct: null, snrDb: null });
  await repainted;
  const got = app._computeAudioMetricsState();
  const want = exact(o, p);
  for (const k of Object.keys(want)) expect(got[k]).toBeCloseTo(want[k], 9);

  // Sanity: the old 1-in-(n/8000) subsample gives a different noise share.
  const step = Math.floor(n / 8000);
  let sv = 0; let sn = 0;
  for (let i = 0; i < n; i += step) { sv += p[i] * p[i]; const r = o[i] - p[i]; sn += r * r; }
  expect(Math.abs((sv / (sv + sn)) * 100 - want.voicePct)).toBeGreaterThan(1e-3);
});

test('an in-place rewrite with a revision bump is recomputed, not served stale', async () => {
  const o = new Float32Array(48000 * 2).map((_, i) => Math.sin(i * 0.01) * 0.2);
  const p = o.map((v) => v * 0.5);
  const app = new Metrics();
  app.origBuffer = buf(o);
  app.outputBuffer = buf(p);
  app.abMode = 'processed';
  await new Promise((r) => { app.updateAudioMetrics = r; app._computeAudioMetricsState(); });
  const before = app._computeAudioMetricsState().voicePct;
  // Interior-only rewrite (as the limiter does): first/mid/last unchanged.
  for (let i = 1000; i < 40000; i++) p[i] *= 0.1;
  bump(app.outputBuffer);
  expect(app._computeAudioMetricsState()).toEqual({ voicePct: null, noisePct: null, snrDb: null });
  await new Promise((r) => { app.updateAudioMetrics = r; });
  const after = app._computeAudioMetricsState().voicePct;
  expect(after).toBeCloseTo(exact(o, p).voicePct, 9);
  expect(after).not.toBeCloseTo(before, 3);
});

test('A/B toggle back to a computed pair is served from cache', async () => {
  const o = new Float32Array(48000 * 2).map((_, i) => Math.sin(i * 0.01) * 0.2);
  const p = o.map((v) => v * 0.5);
  const app = new Metrics();
  app.origBuffer = buf(o);
  app.outputBuffer = buf(p);
  app.abMode = 'processed';
  await new Promise((r) => { app.updateAudioMetrics = r; app._computeAudioMetricsState(); });
  app.abMode = 'original';
  await new Promise((r) => { app.updateAudioMetrics = r; app._computeAudioMetricsState(); });
  app.updateAudioMetrics = () => { throw new Error('should not recompute'); };
  app.abMode = 'processed';
  expect(app._computeAudioMetricsState().voicePct).toBeCloseTo(exact(o, p).voicePct, 9);
});

describe('session metrics (async, every sample)', () => {
  let Session;
  let updates;

  beforeAll(async () => {
    const { processInChunks } = await import(
      pathToFileURL(path.join(__dirname, '../src/pipeline/ui-yield.js')).href
    );
    const body = extractMethod(appSrc, 'async _computeSessionMetricsAsync(orig, o, p, n, sampleRate, key) {');
    Session = new Function('processInChunks', 'getAudioSessionStore',
      `return class { getDiarizationSegments() { return []; } ${body} };`)(
      processInChunks,
      () => ({ updateMetrics: (m) => updates.push(m) }),
    );
  });

  beforeEach(() => { updates = []; });

  function stems(n) {
    const o = new Float32Array(n);
    const p = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      o[i] = Math.sin(i * 0.013) * (i % 9600 < 4800 ? 0.4 : 0.01) + ((i * 7919) % 11) / 900;
      p[i] = o[i] * (i % 9600 < 4800 ? 0.9 : 0.2);
    }
    return { o, p };
  }

  test('publishes exact metrics over every sample when the source is unchanged', async () => {
    const n = 48000 * 30;
    const { o, p } = stems(n);
    const app = new Session();
    app._fileSeq = 1;
    app._sessionMetricsPendingKey = 'k';
    await app._computeSessionMetricsAsync({ duration: 30 }, o, p, n, 48000, 'k');
    expect(updates).toHaveLength(1);
    let pSq = 0;
    let peak = 0;
    for (let i = 0; i < n; i++) { pSq += p[i] * p[i]; peak = Math.max(peak, Math.abs(p[i])); }
    expect(updates[0].rms).toBeCloseTo(Math.sqrt(pSq / n), 12);
    expect(updates[0].peak).toBe(peak);
    expect(app._sessionMetricsCache).toBe(updates[0]);
  });

  test('a file change mid-run never publishes the old file’s metrics', async () => {
    const n = 48000 * 30;
    const { o, p } = stems(n);
    const app = new Session();
    app._fileSeq = 1;
    app._sessionMetricsPendingKey = 'k';
    const run = app._computeSessionMetricsAsync({ duration: 30 }, o, p, n, 48000, 'k');
    app._fileSeq = 2; // file replaced/cleared while the pass is in flight
    await run;
    expect(updates).toHaveLength(0);
    expect(app._sessionMetricsCache).toBeUndefined();
  });

  test('a stale run clears its pending key and stops mid-pass', async () => {
    const n = 48000 * 30;
    const { o, p } = stems(n);
    let reads = 0;
    const counted = new Proxy(p, {
      get(t, k) {
        if (typeof k === 'string' && /^\d+$/.test(k)) reads++;
        return Reflect.get(t, k);
      },
    });
    const app = new Session();
    app._fileSeq = 1;
    app._sessionMetricsPendingKey = 'k';
    const run = app._computeSessionMetricsAsync({ duration: 30 }, o, counted, n, 48000, 'k');
    app._fileSeq = 2;
    await run;
    // Same stems requested again must be able to start a fresh pass.
    expect(app._sessionMetricsPendingKey).toBeNull();
    expect(updates).toHaveLength(0);
    // Stopped within the first chunk's worth of reads, not a full pass.
    expect(reads).toBeLessThan(n);
  });

  test('a newer stem pair supersedes the pending run', async () => {
    const n = 48000 * 30;
    const { o, p } = stems(n);
    const app = new Session();
    app._fileSeq = 1;
    app._sessionMetricsPendingKey = 'old';
    const run = app._computeSessionMetricsAsync({ duration: 30 }, o, p, n, 48000, 'old');
    app._sessionMetricsPendingKey = 'new';
    await run;
    expect(updates).toHaveLength(0);
  });
});
