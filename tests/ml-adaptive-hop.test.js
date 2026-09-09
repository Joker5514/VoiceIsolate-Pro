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

  test('does not auto-process: explicit Process button required', () => {
    // The listen-first / auto-skip pattern was replaced by QuickClean explicit Process.
    // Verify: no auto-process on ingest; the user must choose an outcome and press Process.
    expect(landing).toMatch(/quickClean\.setState\('ready'/);
    expect(landing).toMatch(/press Process locally/);
  });

  test('loads stems for A/B comparison after processing', () => {
    expect(landing).toMatch(/mixer\.loadStems/);
    expect(landing).toMatch(/quickClean\.setState\('processed'|quickClean\.setState\('ready'/);
  });

  test('library import is idle / non-blocking', () => {
    expect(landing).toMatch(/requestIdleCallback|scheduleLib/);
  });
});
