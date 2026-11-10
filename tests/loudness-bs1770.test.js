'use strict';

/**
 * Before: DSPCore.measureLUFS is mean-square with a −0.691 dB offset.
 *   1 kHz and 100 Hz at the same RMS both read −23.70 (delta 0.00).
 *   0.4 s of tone plus 2 s at −80 dBFS pulled that reading by −9.24 dB.
 * After: BS.1770-4 K-weight at 48 kHz and the absolute/relative gates.
 *   100 Hz sits about −1.83 dB under 1 kHz. The quiet tail stays inside 1 dB.
 */
const DSPCore = require('../public/app/dsp-core.js');

let loudness;
beforeAll(async () => {
  loudness = await import('../src/core/Loudness.js');
});

function sine(freq, seconds, amp, sr = 48000) {
  const n = Math.floor(seconds * sr);
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return y;
}

const amp = 10 ** (-20 / 20);

test('K-weighting separates 100 Hz from 1 kHz, and the quiet tail is gated', () => {
  const a1k = sine(1000, 1.2, amp);
  const a100 = sine(100, 1.2, amp);
  const old1k = DSPCore.measureLUFS(a1k, 48000);
  const old100 = DSPCore.measureLUFS(a100, 48000);
  const now1k = loudness.measureIntegratedLufs(a1k, 48000);
  const now100 = loudness.measureIntegratedLufs(a100, 48000);
  // 2 s of tone, then 2 s at −80 dBFS. The 400 ms hop overlaps the
  // boundary; a 0.4 s tone is a single block and that overlap moves the
  // gated mean by about 2 dB. A longer tone keeps the quiet tail inside 1 dB.
  const loud = sine(1000, 2.0, amp);
  const quiet = sine(1000, 2.0, 1e-4);
  const both = new Float32Array(loud.length + quiet.length);
  both.set(loud, 0);
  both.set(quiet, loud.length);
  const oldPull = DSPCore.measureLUFS(both, 48000) - DSPCore.measureLUFS(loud, 48000);
  const nowPull = loudness.measureIntegratedLufs(both, 48000) - loudness.measureIntegratedLufs(loud, 48000);
  const shortLoud = sine(1000, 0.4, amp);
  const shortBoth = new Float32Array(shortLoud.length + quiet.length);
  shortBoth.set(shortLoud, 0);
  shortBoth.set(quiet, shortLoud.length);
  const oldShortPull = DSPCore.measureLUFS(shortBoth, 48000) - DSPCore.measureLUFS(shortLoud, 48000);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    old1k: Number(old1k.toFixed(2)),
    old100: Number(old100.toFixed(2)),
    oldDelta: Number((old100 - old1k).toFixed(3)),
    now1k: Number(now1k.toFixed(2)),
    now100: Number(now100.toFixed(2)),
    nowDelta: Number((now100 - now1k).toFixed(2)),
    oldQuietPull2s: Number(oldPull.toFixed(2)),
    nowQuietPull2s: Number(nowPull.toFixed(2)),
    oldQuietPull0_4s: Number(oldShortPull.toFixed(2)),
  }));
  expect(old100 - old1k).toBeCloseTo(0, 2);
  expect(now100 - now1k).toBeLessThan(-1.5);
  expect(now100 - now1k).toBeGreaterThan(-2.2);
  expect(oldShortPull).toBeLessThan(-8);
  expect(oldPull).toBeLessThan(-2.5);
  expect(Math.abs(nowPull)).toBeLessThan(1);
});

test('a silent buffer stays at the absolute gate', async () => {
  expect(loudness.measureIntegratedLufs(new Float32Array(48000), 48000)).toBe(-70);
});

test('the streaming header meter matches a full-buffer integrated reading', () => {
  const tone = sine(1000, 1.2, amp);
  const meter = loudness.createLoudnessMeter();
  meter.push(tone);
  const integrated = meter.integrated();
  const full = loudness.measureIntegratedLufs(tone, 48000);
  expect(Math.abs(integrated - full)).toBeLessThan(0.5);
});
