/**
 * The live/export limiter worklet (src/workers/TruePeakLimiterProcessor.js)
 * streams the same algorithm as the offline limiter (src/core/TruePeakLimiter.js):
 * output equals the offline single pass, delayed by the fixed latency.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../src/workers/TruePeakLimiterProcessor.js'), 'utf8');

let lim;
beforeAll(async () => { lim = await import('../src/core/TruePeakLimiter.js'); });
const SR = 48000;

function makeProcessor() {
  global.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {} }; } };
  global.registerProcessor = jest.fn();
  global.sampleRate = SR;
  eval(source);
  const P = global.registerProcessor.mock.calls[0][1];
  expect(global.registerProcessor.mock.calls[0][0]).toBe('vip-true-peak-limiter');
  return new P();
}
afterEach(() => { delete global.AudioWorkletProcessor; delete global.registerProcessor; delete global.sampleRate; });

function stream(proc, channels, params, tail) {
  const n = channels[0].length + tail;
  const out = channels.map(() => new Float32Array(n));
  for (let s = 0; s < n; s += 128) {
    const ins = channels.map((c) => { const b = new Float32Array(128); b.set(c.subarray(Math.min(s, c.length), Math.min(s + 128, c.length))); return b; });
    const o = channels.map(() => new Float32Array(128));
    proc.process([ins], [o], params);
    o.forEach((b, c) => out[c].set(b.subarray(0, Math.min(128, n - s)), s));
  }
  return out;
}
function hot(n) {
  const L = new Float32Array(n); const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = 0.4 + 1.1 * Math.max(0, Math.sin(2 * Math.PI * 3 * i / SR));
    L[i] = env * Math.sin(2 * Math.PI * 330 * i / SR); R[i] = 0.7 * env * Math.sin(2 * Math.PI * 331 * i / SR + 1);
  }
  return [L, R];
}

test('latency is the look-ahead plus the interpolation half-width', () => {
  const p = makeProcessor();
  expect(p.delay).toBe(lim.truePeakLimiterLatencyFrames(SR));
  expect(p.delay).toBe(240 + 16);
});

test('disengaged it is a pure delay', () => {
  const x = hot(SR / 2);
  const D = lim.truePeakLimiterLatencyFrames(SR);
  const y = stream(makeProcessor(), x, { enabled: [0], ceiling: [-1], release: [50] }, D);
  for (let i = 0; i < x[0].length; i += 37) expect(y[0][i + D]).toBe(x[0][i]);
});

test('engaged it matches the offline export limiter sample for sample', async () => {
  const x = hot(SR);
  const D = lim.truePeakLimiterLatencyFrames(SR);
  const y = stream(makeProcessor(), x, { enabled: [1], ceiling: [-1], release: [45] }, D);
  const off = await lim.limitTruePeak(x, SR, { ceilingDb: -1, releaseMs: 45, yieldFn: () => Promise.resolve() });
  let worst = 0;
  for (let c = 0; c < 2; c++) for (let i = 0; i < x[0].length; i++) worst = Math.max(worst, Math.abs(y[c][i + D] - off.channels[c][i]));
  expect(worst).toBeLessThan(1e-4);
  const aligned = y.map((ch) => ch.subarray(D, D + x[0].length));
  expect(lim.measureTruePeak(aligned)).toBeLessThanOrEqual(10 ** (-1 / 20) * 1.0005);
});
