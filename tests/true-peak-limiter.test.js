/**
 * Export true-peak limiter (src/core/TruePeakLimiter.js).
 * Replaces the hard clip that flattened Engineer exports at the ceiling and the
 * Landing mixes that went over full scale.
 */
'use strict';

let lim;
const noYield = () => Promise.resolve();
beforeAll(async () => { lim = await import('../src/core/TruePeakLimiter.js'); });

const SR = 48000;
const dbOf = (v) => 20 * Math.log10(v);
function tone(n, f, amp, phase = 0) {
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / SR + phase);
  return x;
}
function noise(n, amp, seed = 7) {
  let s = seed; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; x[i] = amp * (s / 2147483647 - 0.5) * 2; }
  return x;
}
/** Longest run of equal |samples| at the peak (a clipped flat top). */
function flatRun(x) {
  let peak = 0; for (const v of x) peak = Math.max(peak, Math.abs(v));
  let run = 0; let best = 0;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) >= peak * 0.99999) { run++; best = Math.max(best, run); } else run = 0;
  }
  return best;
}

test('audio under the ceiling comes back as the same arrays, bit for bit', async () => {
  const x = tone(SR, 440, 0.5);
  const r = await lim.limitTruePeak([x], SR, { ceilingDb: -1, yieldFn: noYield });
  expect(r.limited).toBe(false);
  expect(r.channels[0]).toBe(x);
});

test('the 4x meter sees the inter-sample peak a sample meter misses', () => {
  // fs/4 sine at 45 degrees: samples at 0.707 A, true peak A.
  const x = tone(4800, SR / 4, 0.99, Math.PI / 4);
  let sp = 0; for (const v of x) sp = Math.max(sp, Math.abs(v));
  expect(dbOf(sp)).toBeCloseTo(dbOf(0.99 * Math.SQRT1_2), 2);
  expect(dbOf(lim.measureTruePeak([x]))).toBeGreaterThan(-0.2);
});

test.each([
  // The fs/4 tone has equal |samples| by construction, so no flat-top check there.
  ['hot tone +3 dBFS', () => [tone(SR, 997, 1.4)], true],
  ['inter-sample overs', () => [tone(SR, SR / 4, 0.99, Math.PI / 4)], false],
  ['loud noise', () => [noise(SR, 1.2)], true],
  ['stereo, one hot side', () => [tone(SR, 300, 1.3), tone(SR, 300, 0.4)], true],
])('%s: true peak ends at or under the ceiling with no flat tops', async (_name, make, checkFlat) => {
  const input = make();
  const r = await lim.limitTruePeak(input, SR, { ceilingDb: -1, yieldFn: noYield });
  expect(r.limited).toBe(true);
  expect(lim.measureTruePeak(r.channels)).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-6);
  for (const ch of r.channels) {
    expect(ch.every(Number.isFinite)).toBe(true);
    if (checkFlat) expect(flatRun(ch)).toBeLessThan(4);
  }
});

test('channels share one gain, so the stereo image does not move', async () => {
  const L = tone(SR, 300, 1.3); const R = tone(SR, 300, 0.4);
  const r = await lim.limitTruePeak([L, R], SR, { ceilingDb: -1, yieldFn: noYield });
  for (let i = 1000; i < SR; i += 997) {
    if (Math.abs(L[i]) > 0.1) expect(r.channels[1][i] / R[i]).toBeCloseTo(r.channels[0][i] / L[i], 5);
  }
});

test('gain moves smoothly: no step at a burst onset (no click)', async () => {
  const n = SR; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (i >= SR / 2 ? 1.6 : 0.3) * Math.sin(2 * Math.PI * 200 * i / SR);
  const r = await lim.limitTruePeak([x], SR, { ceilingDb: -1, lookaheadMs: 5, yieldFn: noYield });
  let worst = 0; let prevG = 1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(x[i]) < 0.05) continue;
    const g = r.channels[0][i] / x[i];
    if (i > 0 && Math.abs(x[i - 1]) >= 0.05) worst = Math.max(worst, Math.abs(g - prevG));
    prevG = g;
  }
  // 5 ms attack at 48 kHz: ~5 dB over 240 samples is well under 0.01 per sample.
  expect(worst).toBeLessThan(0.01);
  // The quiet part before the look-ahead window is untouched.
  for (let i = 0; i < SR / 2 - 300; i++) expect(r.channels[0][i]).toBe(x[i]);
});

test('release returns to unity after a sustained burst (slow follower)', async () => {
  const n = 3 * SR; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = (i < SR / 4 ? 1.5 : 0.3) * Math.sin(2 * Math.PI * 200 * i / SR);
  const r = await lim.limitTruePeak([x], SR, { ceilingDb: -1, releaseMs: 50, yieldFn: noYield });
  const i = n - 100; // 2.75 s after the burst, ~7 slow time constants (400 ms)
  expect(r.channels[0][i] / x[i]).toBeCloseTo(1, 2);
});

test('program-dependent release: an isolated peak recovers at the fast rate', async () => {
  const n = SR; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.3 * Math.sin(2 * Math.PI * 200 * i / SR);
  for (let i = 4800; i < 4900; i++) x[i] = 1.6 * Math.sign(x[i] || 1) * Math.abs(Math.sin(2 * Math.PI * 200 * i / SR)) + x[i];
  const r = await lim.limitTruePeak([x], SR, { ceilingDb: -1, releaseMs: 50, yieldFn: noYield });
  // 300 ms after the 2 ms peak: within 0.5 dB of unity (fixed 300 ms release would sit ~4 dB down).
  const i = 4900 + Math.round(0.3 * SR);
  let o = 0; let a = 0;
  for (let k = i; k < i + 480; k++) { o += r.channels[0][k] ** 2; a += x[k] ** 2; }
  expect(10 * Math.log10(o / a)).toBeGreaterThan(-0.5);
});

test('program-dependent release: syllable-rate limiting holds instead of pumping', async () => {
  // 4 Hz bursts, each well over the ceiling: the gain between bursts should not
  // swing back to unity every 250 ms the way a 50 ms release alone would.
  const n = 3 * SR; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const env = (i % (SR / 4)) < SR / 8 ? 1.8 : 0.5;
    x[i] = env * Math.sin(2 * Math.PI * 220 * i / SR);
  }
  const r = await lim.limitTruePeak([x], SR, { ceilingDb: -1, releaseMs: 50, yieldFn: noYield });
  const gains = [];
  for (let b = 4; b < 12; b++) {
    const k = b * (SR / 4) + SR / 8 + SR / 16; // middle of the quiet half
    let o = 0; let a = 0;
    for (let j = k - 240; j < k + 240; j++) { o += r.channels[0][j] ** 2; a += x[j] ** 2; }
    gains.push(10 * Math.log10(o / a));
  }
  // Quiet halves stay ducked (held) rather than released to 0 dB.
  for (const g of gains) expect(g).toBeLessThan(-2);
});

test('the ceiling at the file edges holds too', async () => {
  const x = tone(2000, 1000, 1.5);
  const r = await lim.limitTruePeak([x], SR, { ceilingDb: -1, yieldFn: noYield });
  expect(lim.measureTruePeak(r.channels)).toBeLessThanOrEqual(Math.pow(10, -1 / 20) + 1e-6);
});

test('cancellation stops a long run', async () => {
  const ac = new AbortController(); ac.abort();
  await expect(lim.limitTruePeak([tone(SR * 2, 200, 1.5)], SR, { signal: ac.signal, yieldEvery: 1024, yieldFn: noYield }))
    .rejects.toMatchObject({ name: 'AbortError' });
});
