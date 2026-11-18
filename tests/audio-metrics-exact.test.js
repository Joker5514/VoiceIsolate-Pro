'use strict';

/**
 * Header Voice % / Noise % / SNR and the session cards share one computation
 * (SessionStats.computeStemStats over every sample, in yielding chunks),
 * cached by buffer identity + revision. The app methods are lifted out of
 * app.js and run against stub buffers. Round 10: the stats are level-invariant
 * stem estimates and Output is the last export's LUFS + true peak.
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
let computeStemStats;
let updates;

beforeAll(async () => {
  const { processInChunks } = await import(pathToFileURL(path.join(__dirname, '../src/pipeline/ui-yield.js')).href);
  const ss = await import(pathToFileURL(path.join(__dirname, '../src/core/SessionStats.js')).href);
  computeStemStats = ss.computeStemStats;
  const body = [
    '_computeAudioMetricsState() {',
    '_statsRemovedBuffer(proc) {',
    '_stemStats(orig, proc) {',
    '_stemStatsAsync(orig, proc) {',
    'async _computeSessionMetricsAsync(orig, o, p, n, sampleRate, key) {',
    '_publishExportLoudness(buf) {',
  ].map((sig) => extractMethod(appSrc, sig)).join('\n');
  const helpers = appSrc.slice(appSrc.indexOf('const _bufferRevisions = new WeakMap();'),
    appSrc.indexOf('const LARGE_FILE_WARNING_BYTES'));
  const made = new Function('processInChunks', 'cachedChannelData', 'structuredLog', 'computeStemStats',
    'measureExportLoudness', 'yieldToBrowser', 'getAudioSessionStore', 'measureIntegratedLufs',
    `${helpers}; return { Metrics: class { getDiarizationSegments() { return []; } ${body} }, bumpBufferRevision };`)(
    processInChunks, (b, ch) => b.getChannelData(ch), () => {}, ss.computeStemStats, ss.measureExportLoudness,
    () => new Promise((r) => setTimeout(r, 0)), () => ({ updateMetrics: (m) => updates.push(m) }), () => -30);
  Metrics = made.Metrics;
  bump = made.bumpBufferRevision;
});

beforeEach(() => { updates = []; });

const buf = (d, sr = 48000) => ({ sampleRate: sr, length: d.length, duration: d.length / sr, numberOfChannels: 1, getChannelData: () => d });

function stems(n) {
  const o = new Float32Array(n);
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const on = i % 48000 < 26400;
    o[i] = Math.sin(i * 0.013) * (on ? 0.3 : 0) + (((i * 7919) % 101) / 101 - 0.5) * 0.05;
    p[i] = Math.sin(i * 0.013) * (on ? 0.27 : 0) + (((i * 7919) % 101) / 101 - 0.5) * 0.01;
  }
  return { o, p };
}

test('header metrics are the shared stem stats over every sample, then repaint', async () => {
  const { o, p } = stems(48000 * 10);
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
  const want = await computeStemStats(o, p, null, 48000);
  expect(got.voicePct).toBeCloseTo(want.voicePct, 9);
  expect(got.noisePct).toBeCloseTo(want.noisePct, 9);
  expect(got.snrDb).toBeCloseTo(want.snrDb, 9);
});

test('an in-place rewrite with a revision bump is recomputed, not served stale', async () => {
  const { o, p } = stems(48000 * 6);
  const app = new Metrics();
  app.origBuffer = buf(o);
  app.outputBuffer = buf(p);
  await new Promise((r) => { app.updateAudioMetrics = r; app._computeAudioMetricsState(); });
  const before = app._computeAudioMetricsState().snrDb;
  // Interior rewrite: more residual in the gaps.
  for (let i = 0; i < p.length; i++) if (i % 48000 >= 26400) p[i] = o[i];
  bump(app.outputBuffer);
  expect(app._computeAudioMetricsState()).toEqual({ voicePct: null, noisePct: null, snrDb: null });
  await new Promise((r) => { app.updateAudioMetrics = r; });
  const after = app._computeAudioMetricsState().snrDb;
  expect(after).toBeCloseTo((await computeStemStats(o, p, null, 48000)).snrDb, 9);
  expect(after).toBeLessThan(before);
});

test('the header describes the last Process in both A/B modes, from cache', async () => {
  const { o, p } = stems(48000 * 4);
  const app = new Metrics();
  app.origBuffer = buf(o);
  app.outputBuffer = buf(p);
  app.abMode = 'processed';
  await new Promise((r) => { app.updateAudioMetrics = r; app._computeAudioMetricsState(); });
  const a = app._computeAudioMetricsState();
  app.updateAudioMetrics = () => { throw new Error('should not recompute'); };
  app.abMode = 'original';
  expect(app._computeAudioMetricsState()).toEqual(a);
});

test('the ML removed stem is used when it matches the processed length', () => {
  const { o, p } = stems(48000);
  const app = new Metrics();
  app.noiseBuffer = buf(new Float32Array(p.length));
  expect(app._statsRemovedBuffer(buf(p))).toBe(app.noiseBuffer);
  app.noiseBuffer = buf(new Float32Array(10));
  expect(app._statsRemovedBuffer(buf(p))).toBeNull();
  expect(o.length).toBe(p.length);
});

describe('session metrics (async, every sample)', () => {
  function session(o, p) {
    const app = new Metrics();
    app.origBuffer = buf(o);
    app.outputBuffer = buf(p);
    app.updateAudioMetrics = () => {};
    app._fileSeq = 1;
    app._sessionMetricsPendingKey = 'k';
    return app;
  }

  test('publishes the shared stats plus exact stem rms/peak', async () => {
    const n = 48000 * 10;
    const { o, p } = stems(n);
    const app = session(o, p);
    await app._computeSessionMetricsAsync(app.origBuffer, o, p, n, 48000, 'k');
    expect(updates).toHaveLength(1);
    const want = await computeStemStats(o, p, null, 48000);
    expect(updates[0].voiceClarity).toBeCloseTo(want.voicePct, 9);
    expect(updates[0].snrDb).toBeCloseTo(want.snrDb, 9);
    expect(updates[0].noiseReduction).toBeCloseTo(want.noiseReductionDb, 9);
    expect(updates[0].whisperRetention).toBeCloseTo(want.whisperRetentionPct, 9);
    let pSq = 0; let peak = 0;
    for (let i = 0; i < n; i++) { pSq += p[i] * p[i]; peak = Math.max(peak, Math.abs(p[i])); }
    expect(updates[0].rms).toBeCloseTo(Math.sqrt(pSq / n), 12);
    expect(updates[0].peak).toBe(peak);
    // No export yet: Output is not claimed.
    expect(updates[0].outputLevelDb).toBeNull();
    expect(updates[0].exportLufs).toBeNull();
    expect(app._sessionMetricsCache).toBe(updates[0]);
  });

  test('a file change mid-run never publishes the old file’s metrics', async () => {
    const n = 48000 * 10;
    const { o, p } = stems(n);
    const app = session(o, p);
    const run = app._computeSessionMetricsAsync(app.origBuffer, o, p, n, 48000, 'k');
    app._fileSeq = 2;
    await run;
    expect(updates).toHaveLength(0);
    expect(app._sessionMetricsCache).toBeUndefined();
    expect(app._sessionMetricsPendingKey).toBeNull();
  });

  test('a newer stem pair supersedes the pending run', async () => {
    const n = 48000 * 10;
    const { o, p } = stems(n);
    const app = session(o, p);
    app._sessionMetricsPendingKey = 'old';
    const run = app._computeSessionMetricsAsync(app.origBuffer, o, p, n, 48000, 'old');
    app._sessionMetricsPendingKey = 'new';
    await run;
    expect(updates).toHaveLength(0);
  });

  test('an export publishes its integrated LUFS and true peak as Output', () => {
    const n = 48000 * 4;
    const { o, p } = stems(n);
    const app = session(o, p);
    const mix = new Float32Array(n);
    for (let i = 0; i < n; i++) mix[i] = 0.1 * Math.sin((2 * Math.PI * 997 * i) / 48000);
    app._publishExportLoudness(buf(mix));
    const last = updates.at(-1);
    expect(last.exportLufs).toBeGreaterThan(-23.3);
    expect(last.exportLufs).toBeLessThan(-22.7);
    expect(last.outputLevelDb).toBe(last.exportLufs);
    expect(last.exportTruePeakDb).toBeCloseTo(-20, 0);
  });
});
