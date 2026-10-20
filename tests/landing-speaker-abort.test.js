'use strict';

/**
 * Landing speaker detection is cancelled when its request goes stale (audit
 * 2026-10-12): it used to run without a signal, so a superseded
 * DiarizationWorker kept a full-length stem copy alive for up to 60 s.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../public/landing.js'), 'utf8').replace(/\r\n/g, '\n');

test('detectSpeakers passes an AbortSignal to the pipeline', () => {
  expect(src).toMatch(/detectSpeakersPipeline\(clean, sampleRate, \{ signal: ctl\.signal \}\)/);
});

test('every request-sequence bump aborts the in-flight detection', () => {
  const bumps = [...src.matchAll(/(\+\+requestSeq|requestSeq \+= 1);\n\s*(\S[^\n]*)/g)];
  expect(bumps.length).toBeGreaterThanOrEqual(4);
  for (const m of bumps) expect(m[2]).toBe('speakerDetectAbort?.abort();');
});
