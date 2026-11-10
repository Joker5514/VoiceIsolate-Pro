/**
 * Gate chatter fix: hysteresis and stereo-linked detection (GateProcessor.js).
 * A level hovering at the threshold used to flip the gate every few ms
 * (audible as fluttering noise); each channel was also gated on its own.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const source = fs.readFileSync(path.join(__dirname, '../src/workers/GateProcessor.js'), 'utf8');

function makeGate() {
  global.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {} }; } };
  global.registerProcessor = jest.fn();
  global.sampleRate = 48000;
  eval(source);
  const Gate = global.registerProcessor.mock.calls[0][1];
  return new Gate();
}
afterEach(() => { delete global.AudioWorkletProcessor; delete global.registerProcessor; delete global.sampleRate; });

const params = (o = {}) => ({ threshold: [-40], range: [40], attack: [1], release: [20], hold: [0], lookahead: [0], ...o });
/** Run channels through the gate in 128-frame blocks; returns gain per frame (output/input). */
function run(gate, channels, p) {
  const n = channels[0].length;
  const outs = channels.map(() => new Float32Array(n));
  for (let s = 0; s < n; s += 128) {
    const ins = channels.map((c) => c.subarray(s, s + 128));
    const o = channels.map(() => new Float32Array(Math.min(128, n - s)));
    gate.process([ins], [o], p);
    o.forEach((b, c) => outs[c].set(b, s));
  }
  return outs;
}
const SR = 48000;
/** 1 kHz tone whose level follows levelsDb, one entry per `segMs`. */
function steppedTone(levelsDb, segMs) {
  const seg = Math.round(SR * segMs / 1000);
  const x = new Float32Array(seg * levelsDb.length);
  for (let i = 0; i < x.length; i++) x[i] = 10 ** (levelsDb[Math.floor(i / seg)] / 20) * Math.sin(2 * Math.PI * 1000 * i / SR);
  return x;
}
/** Count open→closed transitions of a gain envelope (crossing the midpoint in dB). */
function closings(out, inp) {
  let open = true; let count = 0;
  for (let i = 0; i < out.length; i += 48) {
    let o = 0; let a = 0;
    for (let k = i; k < Math.min(i + 48, out.length); k++) { o += out[k] ** 2; a += inp[k] ** 2; }
    if (a < 1e-12) continue;
    const gDb = 10 * Math.log10(o / a + 1e-20);
    if (open && gDb < -20) { open = false; count++; } else if (!open && gDb > -20) open = true;
  }
  return count;
}

test('a level hovering 2–4 dB around the threshold does not flip the gate', () => {
  const levels = []; for (let k = 0; k < 40; k++) levels.push(k % 2 ? -44 : -38);
  levels.unshift(-20, -20); // open on real signal first
  const x = steppedTone(levels, 80);
  const [y] = run(makeGate(), [x], params());
  expect(closings(y, x)).toBe(0);
});

test('the gate still closes once the level falls well under the threshold', () => {
  const x = steppedTone([-20, -20, -60, -60, -60, -60], 50);
  const [y] = run(makeGate(), [x], params());
  expect(closings(y, x)).toBe(1);
  let o = 0; let a = 0;
  for (let i = x.length - 2400; i < x.length; i++) { o += y[i] ** 2; a += x[i] ** 2; }
  expect(10 * Math.log10(o / a)).toBeLessThan(-35);
});

test('the gate opens above the threshold exactly as before', () => {
  const x = steppedTone([-60, -60, -30, -30], 50);
  const [y] = run(makeGate(), [x], params());
  let o = 0; let a = 0;
  for (let i = x.length - 2400; i < x.length; i++) { o += y[i] ** 2; a += x[i] ** 2; }
  expect(10 * Math.log10(o / a)).toBeGreaterThan(-0.1);
});

test('stereo channels share one gate decision', () => {
  const L = steppedTone([-20, -20, -20, -20], 50);
  const R = steppedTone([-60, -60, -60, -60], 50);
  const [yl, yr] = run(makeGate(), [L, R], params());
  for (let i = 4800; i < L.length; i += 113) {
    if (Math.abs(R[i]) > 1e-5) expect(yr[i] / R[i]).toBeCloseTo(yl[i] / L[i], 5);
  }
});

test('hold still keeps the gate open after the level drops', () => {
  const x = steppedTone([-20, -20, -70, -70], 50);
  const [y] = run(makeGate(), [x], params({ hold: [60] }));
  // 30 ms after the drop the hold (60 ms) still has it open.
  const i0 = 2 * 2400 + 1440;
  let o = 0; let a = 0;
  for (let i = i0; i < i0 + 240; i++) { o += y[i] ** 2; a += x[i] ** 2; }
  expect(10 * Math.log10(o / a)).toBeGreaterThan(-1);
});
