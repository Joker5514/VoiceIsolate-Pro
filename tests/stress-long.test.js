/**
 * VIP-029 — regression pins for the long-file/resource guards.
 *
 * The full sweep (60/300/900 s) lives in scripts/quality/stress-long.cjs
 * and is too slow for jest; these tests pin the guard behaviour that the
 * sweep relies on, plus worker cancel/recovery on short signals:
 * - upload guards refuse unsafe sizes BEFORE any read/decode work (pure
 *   functions — no I/O happens in these calls by construction);
 * - the post-decode budget throws instead of truncating;
 * - a corrupt WAV probe is ignored rather than producing a false refusal;
 * - cooperative cancellation rejects as cancelled and does not poison
 *   the next job; an errored job does not poison the next job either.
 */
'use strict';

const { createMlWorker } = require('../scripts/quality/lib/mlworker-node.cjs');
const S = require('../scripts/quality/lib/signals.cjs');

let limits;

beforeAll(async () => {
  limits = await import('../src/core/upload-limits.js');
});

function wavHead({ channels = 1, sampleRate = 48000, bits = 16, dataBytes = 48000 * 2 * 60 }) {
  // Minimal RIFF header: fmt chunk + data chunk header (no payload).
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buf.writeUInt16LE(channels * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

describe('upload guards (VIP-029 box 4)', () => {
  test('file-bytes hard cap refuses before any decode', () => {
    const v = limits.evaluateUpload({ sizeBytes: 9 * 1024 * 1024 * 1024, tier: 'HIGH' });
    expect(v.severity).toBe('refuse');
    expect(v.code).toBe('REFUSE_FILE_BYTES');
  });

  test('decoded-PCM budget refuses a WAV whose PCM exceeds the tier budget', () => {
    // 60 min mono 48 kHz 16-bit: decoded float32 = 60*60*48000*4 ≈ 691 MB.
    // CONSTRAINED budget is 192 MB → must refuse; HIGH budget (3 GB) ok.
    const probe = limits.probeWavHeader(wavHead({ dataBytes: 60 * 60 * 48000 * 2 }));
    expect(probe.durationSec).toBeCloseTo(3600, 0);
    expect(limits.evaluateUpload({ sizeBytes: 60 * 60 * 48000 * 2, probe, tier: 'CONSTRAINED' }).severity).toBe('refuse');
    expect(limits.evaluateUpload({ sizeBytes: 60 * 60 * 48000 * 2, probe, tier: 'HIGH' }).severity).not.toBe('refuse');
  });

  test('corrupt probe (data larger than file) is ignored, not a false refusal', () => {
    const probe = limits.probeWavHeader(wavHead({ dataBytes: 10 * 1024 * 1024 }));
    const v = limits.evaluateUpload({ sizeBytes: 1024, probe, tier: 'HIGH' });
    expect(v.severity).not.toBe('refuse');
  });

  test('post-decode budget throws instead of truncating', () => {
    expect(() => limits.assertDecodedWithinBudget(300 * 1024 * 1024, 'CONSTRAINED')).toThrow(RangeError);
    expect(() => limits.assertDecodedWithinBudget(100 * 1024 * 1024, 'CONSTRAINED')).not.toThrow();
  });

  test('unknown/negative size refuses rather than proceeding blindly', () => {
    expect(limits.evaluateUpload({ sizeBytes: NaN, tier: 'HIGH' }).severity).toBe('refuse');
  });
});

describe('worker cancel + recovery (VIP-029 box 3)', () => {
  test('cancel rejects as cancelled and the next job still succeeds', async () => {
    const worker = await createMlWorker();
    // 10 s (not 30 s): model load alone exceeds the 300 ms cancel delay,
    // so the cancel reliably lands mid-flight, and the test stays fast
    // even when the full suite runs suites in parallel. A 30 s job with
    // a 60 s timeout timed out in the full run under parallel load.
    const { signal, active } = S.talker({ seconds: 10, seed: 3 });
    const { mix } = S.mixAtSnr(signal, S.hvac(signal.length, 102), 5, active);
    const pending = worker.separate([mix], { modelIds: ['bsrnn_vocals'], sampleRate: 48000 });
    await new Promise((r) => setTimeout(r, 300));
    worker.cancelLast();
    await expect(pending).rejects.toThrow(/cancel/i);
    const small = S.talker({ seconds: 2, seed: 4 }).signal;
    const out = await worker.separate([small], { modelIds: ['bsrnn_vocals'], sampleRate: 48000 });
    expect(out.clean[0].length).toBe(small.length);
  }, 120000);

  test('an empty channel resolves to empty stems (graceful, not a crash)', async () => {
    const worker = await createMlWorker();
    const out = await worker.separate([new Float32Array(0)], { modelIds: ['bsrnn_vocals'], sampleRate: 48000 });
    expect(out.clean[0].length).toBe(0);
  }, 60000);

  test('an errored job does not poison the next job', async () => {
    const worker = await createMlWorker();
    await expect(worker.separate([S.talker({ seconds: 2, seed: 5 }).signal], { modelIds: ['no-such-model'], sampleRate: 48000 })).rejects.toThrow();
    const small = S.talker({ seconds: 2, seed: 5 }).signal;
    const out = await worker.separate([small], { modelIds: ['bsrnn_vocals'], sampleRate: 48000 });
    expect(out.clean[0].length).toBe(small.length);
  }, 60000);
});
