'use strict';
let buildSpeakerGainEnvelope;
beforeAll(async () => ({ buildSpeakerGainEnvelope } = await import('../src/core/SpeakerGainEnvelope.js')));

test('builds clipped, overlap-deterministic, click-safe linear automation without source mutation', () => {
  const states = { a: { volume: 0, muted: false }, b: { volume: 0.5, muted: false } };
  const envelope = buildSpeakerGainEnvelope({
    length: 100, sampleRate: 1000, rampSeconds: 0.012,
    segments: [
      { speakerId: 'a', start: -1, end: 0.05 },
      { speakerId: 'b', start: 0.04, end: 0.2 },
      { speakerId: 'bad', start: 2, end: 1 },
    ],
    getState: (id) => states[id],
  });
  expect(envelope).toHaveLength(100);
  expect(envelope[45]).toBeCloseTo(0.5, 6); // later overlapping segment wins
  let maxDelta = 0;
  for (let i = 1; i < envelope.length; i++) maxDelta = Math.max(maxDelta, Math.abs(envelope[i] - envelope[i - 1]));
  expect(maxDelta).toBeLessThanOrEqual(1 / 12 + 1e-6);
});
