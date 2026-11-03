/**
 * tests/autoanalysis-speakers.test.js
 *
 * VIP-007 (IMPLEMENTATION_READINESS_AUDIT_2026-11-02): AutoAnalysis speaker
 * detection is wired to the existing diarization path through an injected
 * hook (src/core stays pure). Pins the adapter contracts:
 * segments time-ordered/non-overlapping, identities never invented, dominant
 * speaker excluded from SECONDARY_SPEAKER overlays, failures degrade to
 * empty + warning, cancellation propagates, hung hooks are bounded.
 */
'use strict';

let runAutoAnalysis;

beforeAll(async () => {
  ({ runAutoAnalysis } = await import('../src/core/audio/analysis/AutoAnalysis.js'));
});

/** ~1 s of deterministic pseudo-speech energy at 48 kHz mono. */
function testChannels(seconds = 1) {
  const n = Math.floor(48_000 * seconds);
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / 48_000;
    ch[i] = 0.25 * Math.sin(2 * Math.PI * 220 * t) * (Math.sin(2 * Math.PI * 2.5 * t) > -0.3 ? 1 : 0.05);
  }
  return [ch];
}

function hookReturning(result) {
  const fn = jest.fn(async () => result);
  return fn;
}

describe('runAutoAnalysis speaker hook (VIP-007)', () => {
  test('no hook keeps the legacy empty-speakers behavior', async () => {
    const result = await runAutoAnalysis(testChannels(), 48_000);
    expect(result.speakers).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.speakerDetection.method).toBe('none');
    expect(result.regions.filter((r) => r.type === 'secondary_speaker')).toEqual([]);
  });

  test('single speaker populates the speakers list and produces no secondary overlay', async () => {
    const hook = hookReturning({
      method: 'kmeans',
      segments: [{ speakerId: 'S1', label: 'Speaker 1', start: 0, end: 1, confidence: 0.8 }],
      speakers: [{ speakerId: 'S1', label: 'Speaker 1', talkTime: 1 }],
    });
    const result = await runAutoAnalysis(testChannels(), 48_000, { detectSpeakers: hook });
    expect(hook).toHaveBeenCalledTimes(1);
    expect(result.speakers).toHaveLength(1);
    expect(result.speakers[0]).toMatchObject({ speakerId: 'S1', label: 'Speaker 1', confidence: 0.8 });
    expect(result.speakerDetection.method).toBe('kmeans');
    expect(result.regions.filter((r) => r.type === 'secondary_speaker')).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('two speakers: the dominant one is not an overlay, the other becomes SECONDARY_SPEAKER regions', async () => {
    const result = await runAutoAnalysis(testChannels(2), 48_000, {
      detectSpeakers: hookReturning({
        method: 'kmeans',
        segments: [
          { speakerId: 'S1', label: 'Speaker 1', start: 0, end: 1.5, confidence: 0.9 }, // dominant
          { speakerId: 'S2', label: 'Speaker 2', start: 1.5, end: 1.9, confidence: 0.7 },
        ],
      }),
    });
    expect(result.speakers).toHaveLength(2);
    const secondary = result.regions.filter((r) => r.type === 'secondary_speaker');
    expect(secondary).toHaveLength(1);
    expect(secondary[0]).toMatchObject({ speakerId: 'S2', label: 'Speaker 2', start: 1.5, end: 1.9 });
    // Identities come from the diarizer verbatim — nothing invented.
    expect(result.speakers.map((s) => s.speakerId).sort()).toEqual(['S1', 'S2']);
  });

  test('diarizer-supplied labels are preserved verbatim', async () => {
    const result = await runAutoAnalysis(testChannels(), 48_000, {
      detectSpeakers: hookReturning({
        segments: [
          { speakerId: 'S1', label: 'Custom A', start: 0, end: 0.6, confidence: 0.5 },
          { speakerId: 'S2', label: 'Custom B', start: 0.6, end: 1, confidence: 0.5 },
        ],
      }),
    });
    expect(result.speakers.map((s) => s.label).sort()).toEqual(['Custom A', 'Custom B']);
  });

  test('silence yields an empty speaker list without warnings', async () => {
    const result = await runAutoAnalysis([new Float32Array(48_000)], 48_000, {
      detectSpeakers: hookReturning({ segments: [], method: 'kmeans' }),
    });
    expect(result.speakers).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('segments are clipped to the file duration (short clips)', async () => {
    const result = await runAutoAnalysis(testChannels(0.5), 48_000, {
      detectSpeakers: hookReturning({
        segments: [{ speakerId: 'S1', label: 'Speaker 1', start: -5, end: 9000, confidence: 0.5 }],
      }),
    });
    expect(result.speakers).toHaveLength(1);
    expect(result.speakers[0].start).toBeGreaterThanOrEqual(0);
    expect(result.speakers[0].end).toBeLessThanOrEqual(0.5);
  });

  test('overlapping hook segments are normalised to the non-overlapping contract', async () => {
    const result = await runAutoAnalysis(testChannels(2), 48_000, {
      detectSpeakers: hookReturning({
        segments: [
          { speakerId: 'S1', label: 'Speaker 1', start: 0, end: 1.2, confidence: 0.9 },
          { speakerId: 'S2', label: 'Speaker 2', start: 1.0, end: 1.8, confidence: 0.6 }, // overlaps S1
        ],
      }),
    });
    const segs = result.speakers;
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].start).toBeGreaterThanOrEqual(segs[i - 1].end);
    }
    // Earlier segment keeps its span; the later one is clipped.
    expect(segs[0]).toMatchObject({ speakerId: 'S1', start: 0, end: 1.2 });
    expect(segs[1]).toMatchObject({ speakerId: 'S2', start: 1.2, end: 1.8 });
  });

  test('malformed segments are dropped, never invented', async () => {
    const result = await runAutoAnalysis(testChannels(1), 48_000, {
      detectSpeakers: hookReturning({
        segments: [
          { speakerId: 'S1', start: NaN, end: 1 },
          { speakerId: 'S1', start: 0.5, end: 0.2 },
          null,
          { speakerId: 'S1', start: 'x', end: 'y' },
          { speakerId: 'S1', label: 'Speaker 1', start: 0, end: 1, confidence: 0.5 },
        ],
      }),
    });
    expect(result.speakers).toHaveLength(1);
    expect(result.speakers[0].speakerId).toBe('S1');
  });

  test('hook failure degrades to empty speakers with a warning — analysis still completes', async () => {
    const result = await runAutoAnalysis(testChannels(), 48_000, {
      detectSpeakers: async () => { throw new Error('worker exploded'); },
    });
    expect(result.speakers).toEqual([]);
    expect(result.warnings.some((w) => /speaker detection unavailable/.test(w))).toBe(true);
    // The rest of the analysis is intact.
    expect(result.regions.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.snrDb)).toBe(true);
    expect(result.speakerDetection.method).toBe('failed');
  });

  test('cancellation propagates as AbortError (never swallowed as a warning)', async () => {
    const controller = new AbortController();
    const hook = jest.fn(async () => {
      controller.abort();
      const err = new Error('superseded');
      err.name = 'AbortError';
      throw err;
    });
    await expect(runAutoAnalysis(testChannels(), 48_000, {
      detectSpeakers: hook,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('a hung hook is bounded by the timeout and analysis still completes', async () => {
    const result = await runAutoAnalysis(testChannels(), 48_000, {
      detectSpeakers: () => new Promise(() => {}),
      speakerTimeoutMs: 50,
    });
    expect(result.speakers).toEqual([]);
    expect(result.warnings.some((w) => /timeout/.test(w))).toBe(true);
    expect(result.speakerDetection.method).toBe('failed');
  });

  test('overlay regions merge per speaker — adjacent speakers never fuse', async () => {
    const result = await runAutoAnalysis(testChannels(2), 48_000, {
      detectSpeakers: hookReturning({
        segments: [
          { speakerId: 'S1', label: 'Speaker 1', start: 0, end: 1.2, confidence: 0.9 },
          { speakerId: 'S2', label: 'Speaker 2', start: 1.2, end: 1.6, confidence: 0.6 },
          { speakerId: 'S3', label: 'Speaker 3', start: 1.6, end: 2, confidence: 0.6 },
        ],
      }),
    });
    const secondary = result.regions.filter((r) => r.type === 'secondary_speaker');
    expect(secondary).toHaveLength(2);
    expect(secondary.map((r) => r.speakerId)).toEqual(['S2', 'S3']);
  });
});

describe('caller wiring (VIP-007 regression pin)', () => {
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.resolve(__dirname, '..');

  test('landing and premium-workspace inject the existing diarization path', () => {
    const landing = fs.readFileSync(path.join(ROOT, 'public', 'landing.js'), 'utf8');
    expect(landing).toMatch(/detectSpeakers:\s*detectSpeakersPipeline/);
    const premium = fs.readFileSync(path.join(ROOT, 'public', 'app', 'premium-workspace.js'), 'utf8');
    expect(premium).toMatch(/detectSpeakers:\s*\(clean, sr, opts\) => import\('\/src\/pipeline\/SpeakerDetection\.js'\)/);
  });

  test('the AutoAnalysis placeholder is gone', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'core', 'audio', 'analysis', 'AutoAnalysis.js'), 'utf8');
    expect(src).not.toMatch(/placeholder for now, will be enriched by diarization/);
    expect(src).toMatch(/runSpeakerHook/);
  });
});
