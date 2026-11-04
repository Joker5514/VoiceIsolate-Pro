/**
 * VIP-004/034 — unit tests for the corpus eval's new pieces: plain SDR in
 * metrics.cjs, and the WAV reader + activity mask in corpus-eval.cjs.
 * The full eval itself (144 worker runs) is not a jest test; it runs via
 * `node scripts/quality/corpus-eval.cjs` and writes output/corpus-eval/.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const M = require('../scripts/quality/lib/metrics.cjs');
const { readWav, writeWav16, activityMask, upsampleLinear, judgeChain } = require('../scripts/quality/corpus-eval.cjs');

function writeWav(file, samples, { junkBeforeData = false } = {}) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(Math.round(v * 32767), i * 2));
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(16000, 4);
  fmt.writeUInt32LE(32000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const chunks = [Buffer.from('fmt '), Buffer.alloc(4), fmt];
  chunks[1].writeUInt32LE(16, 0);
  if (junkBeforeData) {
    // A JUNK chunk whose bytes duplicate the data pattern: proves the
    // reader uses the data chunk offset, not a first-byte search.
    const junk = Buffer.from(data);
    chunks.push(Buffer.from('JUNK'), Buffer.alloc(4), junk);
    chunks[chunks.length - 2].writeUInt32LE(junk.length, 0);
  }
  chunks.push(Buffer.from('data'), Buffer.alloc(4), data);
  chunks[chunks.length - 2].writeUInt32LE(data.length, 0);
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVE', 8);
  fs.writeFileSync(file, Buffer.concat([header, body]));
}

describe('corpus eval metrics', () => {
  test('sdr: identical signals score very high, zero estimate scores 0 dB', () => {
    const ref = Float32Array.from([0.5, -0.25, 0.75, 0.1, -0.6]);
    expect(M.sdr(ref, ref)).toBeGreaterThan(100);
    expect(M.sdr(new Float32Array(5), ref)).toBeCloseTo(0, 6);
    const noisy = Float32Array.from(ref.map((v) => v * 0.9));
    // 0.9x gain: SDR punishes gain (unlike SI-SDR) — 10*log10(1/0.01) = 20 dB.
    expect(M.sdr(noisy, ref)).toBeCloseTo(20, 3);
  });

  test('sdr: silent reference is NaN, not a fabricated number', () => {
    expect(M.sdr(new Float32Array([0.1, 0.2]), new Float32Array(2))).toBeNaN();
  });

  test('readWav decodes PCM16 mono and skips non-data chunks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-wav-'));
    const file = path.join(dir, 't.wav');
    writeWav(file, [0, 0.5, -0.5, 1], { junkBeforeData: true });
    const { samples, sampleRate } = readWav(file);
    expect(sampleRate).toBe(16000);
    // Note: the writer rounds v*32767, and Math.round(-16383.5) is -16383.
    expect(Array.from(samples)).toEqual([0, 16384 / 32768, -16383 / 32768, 32767 / 32768]);
  });

  test('readWav rejects non-PCM input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-wav-'));
    const file = path.join(dir, 'bad.wav');
    fs.writeFileSync(file, Buffer.from('not a wav file at all........'));
    expect(() => readWav(file)).toThrow(/not a RIFF/);
  });

  test('activityMask marks loud frames active, quiet frames inactive', () => {
    const ref = new Float32Array(320 * 4);
    for (let i = 0; i < 320; i++) ref[i] = 0.0001; // ~-80 dBFS
    for (let i = 320; i < ref.length; i++) ref[i] = 0.5; // ~-6 dBFS
    const mask = activityMask(ref, 16000);
    expect(mask).not.toBeNull();
    expect(mask.slice(0, 320).every((v) => v === false)).toBe(true);
    expect(mask.slice(320).every((v) => v === true)).toBe(true);
  });

  test('activityMask returns null for all-silence input', () => {
    expect(activityMask(new Float32Array(3200), 16000)).toBeNull();
  });

  test('judgeChain passes a chain meeting every bar', () => {
    const v = judgeChain({
      'noisy-speech/hvac': { meanSiSdrDelta: 2.5, meanSpeechLevel: 0.5, meanFricative: -1 },
      'clean-speech': { meanPreservation: 20, meanSpeechLevel: -0.5, meanFricative: -0.2 },
    }, 0.3, 5000);
    expect(v.meetsAllBars).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  test('judgeChain fails unmeasured (null) metrics instead of passing them', () => {
    // null >= 0 and null >= -6 are both true in JS; the judge must not
    // let that coerce an unmeasured bar into a pass.
    const v = judgeChain({
      'noisy-speech/hvac': { meanSiSdrDelta: null, meanSpeechLevel: null, meanFricative: null },
    }, null, null);
    expect(v.meetsAllBars).toBe(false);
    expect(v.reasons.length).toBeGreaterThanOrEqual(4);
  });

  test('writeWav16 round-trips through readWav', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vip-wav-'));
    const file = path.join(dir, 'roundtrip.wav');
    writeWav16(file, Float32Array.from([0, 0.25, -0.75, 0.999]), 16000);
    const { samples, sampleRate } = readWav(file);
    expect(sampleRate).toBe(16000);
    expect(samples.length).toBe(4);
    expect(samples[1]).toBeCloseTo(0.25, 3);
    expect(samples[2]).toBeCloseTo(-0.75, 3);
  });

  test('upsampleLinear 16k->48k interpolates exactly at 3x', () => {
    const up = upsampleLinear(Float32Array.from([0, 3, 6]), 16000, 48000);
    expect(up.length).toBe(9);
    expect(Array.from(up)).toEqual([0, 1, 2, 3, 4, 5, 6, 6, 6]);
    expect(upsampleLinear(Float32Array.from([1, 2]), 48000, 48000)).toEqual(Float32Array.from([1, 2]));
  });
});
