/**
 * F06 — placing media content inside a real-time capture of
 * [pre-roll zeros][content][post-roll zeros] (media-decode locateContentWindow).
 * Real-browser evidence (click-marker alignment, rate labelling) is recorded in
 * docs/audits/REPAIR_AUDIT_2026-10-12.md.
 */
'use strict';

let locateContentWindow;
beforeAll(async () => {
  ({ locateContentWindow } = await import('../src/pipeline/media-decode.js'));
});

function capture(pre, content, post) {
  const out = new Float32Array(pre + content.length + post);
  out.set(content, pre);
  return out;
}

const tone = (n) => Float32Array.from({ length: n }, (_, i) => 0.2 * Math.sin(i * 0.05 + 0.1));

test('content that opens with signal is placed sample-exactly', () => {
  const c = tone(48000);
  const v = capture(4100, c, 9000);
  const w = locateContentWindow([v], 48000, 4096);
  expect(w).toEqual({ start: 4100, length: 48000, shortBy: 0 });
});

test('container duration longer than the content keeps the true start', () => {
  const c = tone(48000);
  const v = capture(4100, c, 9000);
  const w = locateContentWindow([v], 48384, 4096); // 384 frames of codec padding
  expect(w.start).toBe(4100);
  expect(w.length).toBe(48384);
});

test('content opening in digital silence falls back to the pre-roll estimate', () => {
  const body = new Float32Array(48000);
  body.set(tone(24000), 12000); // 12000 frames of exact silence first
  const v = capture(4100, body, 9000);
  const w = locateContentWindow([v], 48000, 4096);
  expect(w.start).toBe(4096); // block-granular estimate, true start 4100
  expect(w.length).toBe(48000);
});

test('a capture shorter than the media reports how short', () => {
  const v = capture(1000, tone(30000), 0);
  const w = locateContentWindow([v], 48000, 1024);
  expect(w.shortBy).toBe(48000 - 30000);
});

test('stereo: the earliest/latest non-zero sample over all channels bounds the window', () => {
  const l = capture(5000, tone(2000), 50000);
  const r = capture(4000, tone(3000), 50000);
  const w = locateContentWindow([l, r], 40000, 4096);
  expect(w.start).toBe(4000);
});
