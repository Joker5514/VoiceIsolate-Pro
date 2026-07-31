/**
 * Source-level guard: adaptive hop exists and scales with duration.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '../src/workers/MLWorker.js'),
  'utf8',
);

describe('MLWorker adaptive hop (speed)', () => {
  test('defines adaptiveHopSize', () => {
    expect(SRC).toMatch(/function adaptiveHopSize\s*\(/);
  });

  test('uses adaptive hop in runSpectralMask', () => {
    expect(SRC).toMatch(/const hop = adaptiveHopSize\(/);
  });

  test('long-file hop multipliers present (mobile + desktop)', () => {
    expect(SRC).toMatch(/base \* 16|base \* 8/);
    expect(SRC).toMatch(/base \* 4/);
    expect(SRC).toMatch(/mobile/);
  });

  test('batch frames raised for speed', () => {
    expect(SRC).toMatch(/Math\.min\(512/);
    expect(SRC).toMatch(/Math\.min\(384/);
  });
});

describe('Landing listen-first path', () => {
  const landing = fs.readFileSync(
    path.join(__dirname, '../public/landing.js'),
    'utf8',
  );

  test('does not auto-process files longer than 180s', () => {
    expect(landing).toMatch(/dur > 180/);
    expect(landing).toMatch(/press .Separate Stems./);
  });

  test('loads stems for early play after decode', () => {
    expect(landing).toMatch(/mixer\.loadStems/);
    expect(landing).toMatch(/Ready to play/);
  });

  test('library import is idle / non-blocking', () => {
    expect(landing).toMatch(/requestIdleCallback|scheduleLib/);
  });
});
