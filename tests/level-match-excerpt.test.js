/**
 * Level matching must measure a BOUNDED excerpt, never the whole file.
 *
 * Regression: every slider move (debounced, once edits settle) re-ran the
 * A/B level match, and ComparisonLevelMatcher.match() rendered the ENTIRE
 * file offline (renderMix with no startSec/endSec) and measured the full
 * buffers. On a 522 s / 25M-frame file that froze the tab for seconds after
 * every slider move: renderMix runs synchronous full-buffer true-peak scans
 * on the main thread (measureTruePeak is ~3.4 s at 25M frames, and
 * limitTruePeak adds up to three more), plus ~100 MB channel copies.
 * The match now renders/measures only the first LEVEL_MATCH_EXCERPT_SEC
 * seconds of each lane — ample for a stable RMS/peak ratio, and the ratio
 * stays like-for-like because both lanes use the same fixed window.
 */
'use strict';

const mockMeasure = jest.fn(async () => ({ rms: 0.1, peak: 0.5 }));
const mockReviewGains = jest.fn(() => ({ original: 1, cleaned: 1, matched: true }));

jest.unstable_mockModule('../src/pipeline/AudioReview.js', () => ({
  measureAudioBuffer: mockMeasure,
  reviewGains: mockReviewGains,
}));

let ComparisonLevelMatcher;
let LEVEL_MATCH_EXCERPT_SEC;

beforeAll(async () => {
  ({ ComparisonLevelMatcher, LEVEL_MATCH_EXCERPT_SEC } = await import(
    '../src/pipeline/ComparisonLevelMatch.js'
  ));
});

beforeEach(() => {
  mockMeasure.mockClear();
  mockReviewGains.mockClear();
});

function fakeBuffer(seconds, sampleRate = 48000) {
  const len = Math.round(seconds * sampleRate);
  const data = [new Float32Array(len)];
  return {
    numberOfChannels: 1,
    length: len,
    duration: seconds,
    sampleRate,
    getChannelData: (c) => data[c],
  };
}

function fakeMixer(cleanedSeconds = LEVEL_MATCH_EXCERPT_SEC) {
  return {
    masterGain: null,
    renderMix: jest.fn(async () => fakeBuffer(cleanedSeconds)),
  };
}

describe('ComparisonLevelMatcher excerpt', () => {
  test('match() renders and measures only a bounded excerpt of a long file', async () => {
    const mixer = fakeMixer();
    const matcher = new ComparisonLevelMatcher(mixer);
    const original = fakeBuffer(522.768);

    const result = await matcher.match(original);

    expect(result).toEqual({ original: 1, cleaned: 1, matched: true });
    // The render must be bounded: full-file renderMix is the freeze.
    expect(mixer.renderMix).toHaveBeenCalledTimes(1);
    expect(mixer.renderMix).toHaveBeenCalledWith(
      expect.objectContaining({ startSec: 0, endSec: LEVEL_MATCH_EXCERPT_SEC }),
    );
    // The original side is measured over the SAME fixed window (like-for-like).
    expect(mockMeasure).toHaveBeenCalledWith(
      original,
      expect.objectContaining({ startSec: 0, endSec: LEVEL_MATCH_EXCERPT_SEC }),
    );
    // The cleaned side is already the excerpt render, so it is measured whole.
    expect(mockMeasure).toHaveBeenCalledTimes(2);
  });

  test('match() measures a short file in full (no excerpt below its length)', async () => {
    const mixer = fakeMixer(10);
    const matcher = new ComparisonLevelMatcher(mixer);
    const original = fakeBuffer(10);

    await matcher.match(original);

    expect(mixer.renderMix).toHaveBeenCalledWith(
      expect.objectContaining({ startSec: 0, endSec: 10 }),
    );
    expect(mockMeasure).toHaveBeenCalledWith(
      original,
      expect.objectContaining({ startSec: 0, endSec: 10 }),
    );
  });

  test('the original-side stats are cached per reference (same window)', async () => {
    const mixer = fakeMixer();
    const matcher = new ComparisonLevelMatcher(mixer);
    const original = fakeBuffer(522.768);

    await matcher.match(original);
    await matcher.match(original);

    // One original measurement total across both matches; two cleaned ones.
    const originalCalls = mockMeasure.mock.calls.filter(([buf]) => buf === original);
    expect(originalCalls).toHaveLength(1);
    expect(mockMeasure).toHaveBeenCalledTimes(3);
  });
});
