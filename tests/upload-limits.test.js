/**
 * tests/upload-limits.test.js
 *
 * VIP-009 (IMPLEMENTATION_READINESS_AUDIT_2026-11-02): device-aware upload
 * size & memory policy. Covers malformed/misleading WAV headers, oversized
 * inputs, the soft-warning tier, post-decode budget refusal, mono/stereo and
 * long-recording estimates, and FileIngestion integration (valid media still
 * passes; policy refusals are deterministic and actionable).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let limits; // src/core/upload-limits.js (ESM)
let ingestion; // src/pipeline/FileIngestion.js (ESM)

beforeAll(async () => {
  limits = await import('../src/core/upload-limits.js');
  ingestion = await import('../src/pipeline/FileIngestion.js');
});

/** Build a real RIFF/WAVE header whose declared data size can be a lie. */
function wavHeader({ channels = 2, sampleRate = 48_000, bits = 16, dataBytes = 1000, riffSize } = {}) {
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(riffSize != null ? riffSize : 36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  buf.writeUInt16LE(channels * (bits / 8), 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

describe('WAV header probe', () => {
  test('parses a mono 8 kHz header with correct duration', () => {
    // 5 s of 8 kHz mono 16-bit = 80,000 bytes of payload.
    const probe = limits.probeWavHeader(wavHeader({ channels: 1, sampleRate: 8_000, bits: 16, dataBytes: 80_000 }));
    expect(probe).toMatchObject({ channels: 1, sampleRate: 8_000, bitsPerSample: 16, dataBytes: 80_000 });
    expect(probe.durationSec).toBeCloseTo(5, 5);
  });

  test('parses a stereo 48 kHz header (long recording)', () => {
    // 2 hours stereo 48 kHz 24-bit.
    const dataBytes = 2 * 3600 * 48_000 * 2 * 3;
    const probe = limits.probeWavHeader(wavHeader({ channels: 2, sampleRate: 48_000, bits: 24, dataBytes }));
    expect(probe.durationSec).toBeCloseTo(7200, 3);
  });

  test('returns null for malformed headers', () => {
    expect(limits.probeWavHeader(Buffer.alloc(10))).toBeNull();
    expect(limits.probeWavHeader(Buffer.from('not a wav file at all, but long enough to parse........'))).toBeNull();
    const badChunk = wavHeader({ dataBytes: 100 });
    badChunk.writeUInt32LE(0xFFFFFFF0, 16); // fmt chunk size nonsense → walk breaks
    expect(limits.probeWavHeader(badChunk.subarray(0, 44))).toBeNull();
    expect(limits.probeWavHeader(wavHeader({ channels: 0 }))).toBeNull();
    expect(limits.probeWavHeader(wavHeader({ sampleRate: 10 }))).toBeNull();
    expect(limits.probeWavHeader(wavHeader({ bits: 7 }))).toBeNull();
  });

  test('streaming (0xFFFFFFFF) data size yields unknown duration, not a crash', () => {
    const probe = limits.probeWavHeader(wavHeader({ dataBytes: 0xFFFFFFFF, riffSize: 4096 }));
    expect(probe).not.toBeNull();
    expect(probe.dataBytes).toBeNull();
    expect(probe.durationSec).toBeNull();
  });
});

describe('evaluateUpload policy', () => {
  const MB = 1024 * 1024;

  test('small files are ok on every tier', () => {
    for (const tier of ['HIGH', 'BALANCED', 'CONSTRAINED']) {
      const v = limits.evaluateUpload({ sizeBytes: 5 * MB, tier });
      expect(v.severity).toBe('ok');
      expect(v.code).toBe('OK');
    }
  });

  test('soft warning above warnFileBytes still accepts', () => {
    const v = limits.evaluateUpload({ sizeBytes: 100 * MB, tier: 'CONSTRAINED' });
    expect(v.severity).toBe('warn');
    expect(v.code).toBe('WARN_LARGE_FILE');
    expect(v.message).toContain('Large file');
  });

  test('file-bytes hard cap refuses with an actionable message', () => {
    const v = limits.evaluateUpload({ sizeBytes: 600 * MB, tier: 'CONSTRAINED' });
    expect(v.severity).toBe('refuse');
    expect(v.code).toBe('REFUSE_FILE_BYTES');
    expect(v.message).toMatch(/limit for this device/);
    expect(v.message).toMatch(/shorter recording|split the file/);
  });

  test('WAV decode-cost probe refuses before decoding when PCM exceeds budget', () => {
    // 20 min stereo 48 kHz 16-bit WAV → 460 MB decoded float32 > 192 MB budget.
    const dataBytes = 20 * 60 * 48_000 * 2 * 2;
    const probe = limits.probeWavHeader(wavHeader({ dataBytes }));
    const v = limits.evaluateUpload({ sizeBytes: dataBytes + 44, probe, tier: 'CONSTRAINED' });
    expect(v.severity).toBe('refuse');
    expect(v.code).toBe('REFUSE_DECODED_PCM');
    expect(v.message).toMatch(/processing budget/);
    expect(v.estimates.decodedBytesEstimate).toBeGreaterThan(limits.UPLOAD_POLICY.CONSTRAINED.decodedPcmBytes);
  });

  test('the same WAV is accepted on the HIGH tier (long recordings work where memory allows)', () => {
    const dataBytes = 20 * 60 * 48_000 * 2 * 2;
    const probe = limits.probeWavHeader(wavHeader({ dataBytes }));
    const v = limits.evaluateUpload({ sizeBytes: dataBytes + 44, probe, tier: 'HIGH' });
    expect(v.severity).not.toBe('refuse');
    expect(v.estimates.durationSecEstimate).toBeCloseTo(1200, 3);
  });

  test('a corrupt header claiming more payload than the file holds is ignored, not refused', () => {
    const probe = limits.probeWavHeader(wavHeader({ dataBytes: 500 * MB }));
    // File is only 44 bytes — the header is a lie (truncated/bogus writer).
    const v = limits.evaluateUpload({ sizeBytes: 44, probe, tier: 'CONSTRAINED' });
    expect(v.severity).toBe('ok');
    expect(v.estimates.decodedBytesEstimate).toBeNull();
  });

  test('unsupported/unknown size input is refused deterministically', () => {
    const v = limits.evaluateUpload({ sizeBytes: NaN, tier: 'HIGH' });
    expect(v.severity).toBe('refuse');
    expect(v.code).toBe('REFUSE_FILE_BYTES');
  });

  test('unknown tier falls back to the HIGH policy', () => {
    const v = limits.evaluateUpload({ sizeBytes: 100 * MB, tier: 'no-such-tier' });
    expect(v.tier).toBe('no-such-tier');
    // HIGH warn threshold is 512 MB and the hard cap 8 GB: 100 MB is plain ok.
    expect(v.severity).toBe('ok');
    expect(() => limits.evaluateUpload({ sizeBytes: 9 * 1024 * MB, tier: 'no-such-tier' }))
      .not.toThrow();
    expect(limits.evaluateUpload({ sizeBytes: 9 * 1024 * MB, tier: 'no-such-tier' }).severity).toBe('refuse');
  });
});

describe('assertDecodedWithinBudget (post-decode guard)', () => {
  test('decoded PCM within budget passes silently', () => {
    expect(() => limits.assertDecodedWithinBudget(100 * 1024 * 1024, 'BALANCED')).not.toThrow();
  });

  test('decoded PCM over budget throws an actionable RangeError', () => {
    let error = null;
    try {
      limits.assertDecodedWithinBudget(900 * 1024 * 1024, 'BALANCED');
    } catch (err) { error = err; }
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toMatch(/processing budget/);
    expect(error.message).toMatch(/Trim the recording/);
  });

  test('non-finite inputs are ignored (never crash ingestion)', () => {
    expect(() => limits.assertDecodedWithinBudget(NaN, 'HIGH')).not.toThrow();
    expect(() => limits.assertDecodedWithinBudget(undefined, 'HIGH')).not.toThrow();
  });
});

describe('FileIngestion integration', () => {
  test('assertIngestible refuses oversized input per tier before any decode', () => {
    const huge = new Blob([new Uint8Array(10)], { type: 'audio/wav' });
    Object.defineProperty(huge, 'size', { value: 600 * 1024 * 1024 }); // size without allocating
    let error = null;
    try { ingestion.assertIngestible(huge, { tier: 'CONSTRAINED' }); } catch (err) { error = err; }
    expect(error).toBeInstanceOf(RangeError);
    expect(error.message).toMatch(/limit for this device/);
  });

  test('valid small audio still passes validation (mono and stereo)', async () => {
    for (const channels of [1, 2]) {
      const wav = wavHeader({ channels, dataBytes: 256 });
      const blob = new Blob([wav], { type: 'audio/wav' });
      await expect(ingestion.assertIngestibleAsync(blob, { tier: 'HIGH' })).resolves.toBe('audio');
    }
  });

  test('corrupt WAV header claiming more payload than the file holds passes to the decoder', async () => {
    // Truncated download / bogus writer: header claims 40 min stereo but the
    // file is 1 KB. The probe must be ignored (no misleading "too long"
    // refusal) and validation leaves the decision to the decoder.
    const header = wavHeader({ dataBytes: 40 * 60 * 48_000 * 2 * 2 });
    const padded = Buffer.concat([header, Buffer.alloc(1024)]);
    const blob = new Blob([padded], { type: 'audio/wav' });
    await expect(ingestion.assertIngestibleAsync(blob, { tier: 'CONSTRAINED' })).resolves.toBe('audio');
  });

  test('MIDI and image rejection is preserved alongside the size policy', () => {
    expect(() => ingestion.assertIngestible(new Blob([new Uint8Array(8)], { type: 'audio/midi' })))
      .toThrow(/MIDI files are not supported/);
    expect(() => ingestion.assertIngestible(new Blob([new Uint8Array(8)], { type: 'image/png' })))
      .toThrow(/Images cannot be processed/);
    expect(() => ingestion.assertIngestible(new Blob([]), { tier: 'HIGH' }))
      .toThrow(/File is empty/);
  });

  test('upload-limits module is pure (no DOM/Web Audio references)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'upload-limits.js'), 'utf8');
    expect(src).not.toMatch(/document\.|AudioContext|window\./);
  });
});
