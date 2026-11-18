/**
 * Live test t24u: Randy asked whether Voice %, Noise %, SNR, Whisper Retention,
 * Noise Reduction and Output dBFS are post-process measurements or estimates.
 *
 * They are computed after Process from the decoded original (o) and the
 * processed stem (p), but as energy proxies: "voice" = energy kept in p,
 * "noise" = energy of o - p, Output dBFS = RMS of the processed stem before
 * the Live-Mix/export chain. Two honesty gaps found on main 2f78ab3:
 *  - nothing said so: no log line, and the UI cards had no description;
 *  - a new upload kept the previous file's numbers on screen until the next
 *    Process finished (premium-workspace skipped null metrics; app never reset).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'public/app/app.js'), 'utf8').replace(/\r\n/g, '\n');
const pwSource = fs.readFileSync(path.join(root, 'public/app/premium-workspace.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/app/index.html'), 'utf8');

function methodSource(name, signature, { async = false } = {}) {
  const head = `\n  ${async ? 'async ' : ''}${name}(${signature}) {`;
  const start = appSource.indexOf(head);
  if (start < 0) throw new Error(`method ${name}(${signature}) not found in app.js`);
  const end = appSource.indexOf('\n  }\n', start);
  return appSource.slice(start + 1, end + 4);
}

function sine(n, amp, f = 220) {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * f * i) / 48000);
  return a;
}

function harness() {
  const logs = [];
  const metricsPushed = [];
  const store = { updateMetrics: (m) => metricsPushed.push(m) };
  const written = {};
  const doc = { getElementById: (id) => ({ set textContent(v) { written[id] = v; } }) };
  const processInChunks = async ({ total, chunkSize, runChunk }) => {
    for (let s = 0; s < total; s += chunkSize) runChunk(s, Math.min(total, s + chunkSize));
  };
  const Cls = new Function(
    'processInChunks', 'cachedChannelData', 'getAudioSessionStore', 'structuredLog', 'measureIntegratedLufs', 'document',
    `return class {
      constructor() { this._fileSeq = 1; this._sessionMetricsPendingKey = 'k'; }
      getDiarizationSegments() { return []; }
      ${methodSource('_computeSessionMetricsAsync', 'orig, o, p, n, sampleRate, key', { async: true })}
      ${methodSource('_resetSessionMetrics', '')}
    };`,
  )(processInChunks, (b, c) => b.getChannelData(c), () => store, (l, msg, data) => logs.push({ l, msg, data }), () => -30, doc);
  return { app: new Cls(), logs, metricsPushed, written };
}

describe('session metrics say what they measure', () => {
  test('a post-process log line names the basis of every readout', async () => {
    const { app, logs, metricsPushed } = harness();
    const n = 48000;
    const o = sine(n, 0.2);
    const p = sine(n, 0.1);
    const orig = { getChannelData: () => o, numberOfChannels: 1, duration: 1 };
    await app._computeSessionMetricsAsync(orig, o, p, n, 48000, 'k');
    expect(metricsPushed).toHaveLength(1);
    const line = logs.find((x) => x.msg === '[VIP] Session metrics');
    expect(line).toBeTruthy();
    expect(line.data.measured).toBe('post-process');
    expect(line.data.basis.voiceClarity).toMatch(/processed.*removed/i);
    expect(line.data.basis.outputLevelDb).toMatch(/processed stem.*before Live-Mix/i);
    expect(line.data.basis.whisperRetention).toMatch(/quiet frames/i);
    // Output dBFS is the RMS of p: 0.1/sqrt(2) -> -23.01 dBFS.
    expect(line.data.values.outputLevelDb).toBeCloseTo(20 * Math.log10(0.1 / Math.SQRT2), 1);
  });

  test('a new upload clears the previous file\'s numbers', () => {
    const { app, metricsPushed, written } = harness();
    app._lastMetricsState = { voicePct: 44 };
    app._sessionMetricsKey = 'old'; app._sessionMetricsCache = { voiceClarity: 44 };
    app._resetSessionMetrics();
    expect(app._lastMetricsState).toBeNull();
    expect(app._sessionMetricsKey).toBeNull();
    expect(app._sessionMetricsCache).toBeNull();
    expect(metricsPushed.at(-1)).toMatchObject({ voiceClarity: null, noiseReduction: null, whisperRetention: null, outputLevelDb: null, snrDb: null });
    for (const id of ['hVoice', 'hNoise', 'stat-voice', 'stat-noise']) expect(written[id]).toBe('--');
    expect(written.hSNR).toBe('-- dB');
  });

  test('handleFile resets metrics when the source changes', () => {
    const start = appSource.indexOf('\n  async handleFile(file, options = {}) {');
    const body = appSource.slice(start, appSource.indexOf('\n    this._sourceName = file.name', start));
    expect(body).toMatch(/if \(!sameSource\) \{[\s\S]*this\._resetSessionMetrics\?\.\(\);/);
  });

  test('the header Voice/Noise/SNR are not swapped for input-analysis estimates', () => {
    expect(methodSource('_computeAudioMetricsState', '')).not.toMatch(/_lastEnvProfile|lastEnvProfile/);
  });

  test('the live metric cards render "--" for cleared values instead of keeping stale text', () => {
    const fn = pwSource.slice(pwSource.indexOf('function updateLiveMetrics('), pwSource.indexOf('// Deep metrics'));
    expect(fn).not.toMatch(/if \(metrics\.voiceClarity != null\) setMetric/);
    expect(fn).toMatch(/'metricVoiceClarity'[^\n]*'--'/);
    expect(fn).toMatch(/'metricOutputDb'[^\n]*'-- dBFS'/);
  });

  test('each live metric card describes its measurement (text only)', () => {
    for (const label of ['Voice Clarity', 'Noise Reduction', 'Whisper Retention', 'Output dBFS']) {
      const re = new RegExp(`<div class="vip-live-metrics__card" title="[^"]+"><span class="vip-live-metrics__label">${label}</span>`);
      expect(html).toMatch(re);
    }
    expect(html).toMatch(/title="[^"]*processed stem before the Live-Mix[^"]*"><span class="vip-live-metrics__label">Output dBFS/);
  });
});
