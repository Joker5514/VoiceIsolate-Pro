/**
 * Landing visualization responsiveness guards.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '../src/presentation/LandingVisualizer.js'),
  'utf8',
);

describe('LandingVisualizer responsiveness', () => {
  test('uses the shared cooperative yield budget for long-file envelopes', () => {
    expect(src).toContain("import { createYieldBudget } from '../pipeline/ui-yield.js';");
    expect(src).toMatch(/async loadStems\(/);
    expect(src).toMatch(/await envelopeOfAsync\(/);
    expect(src).toMatch(/await maybeYield\(\)/);
  });

  test('cancels stale envelope generations when a newer file is loaded', () => {
    expect(src).toContain('this._loadGeneration');
    expect(src).toMatch(/generation === this\._loadGeneration/);
    expect(src).toMatch(/if \(!isCurrent\(\)\) return null/);
  });

  test('uses proportional buckets so the final audio tail is represented', () => {
    expect(src).toMatch(/Math\.floor\(\(\(c \+ 1\) \* length\) \/ nColumns\)/);
  });

  test('throttles paused or hidden rendering instead of full-rate canvas repainting', () => {
    expect(src).toContain('const IDLE_FRAME_MS = 250;');
    expect(src).toMatch(/this\._scheduleNextFrame\(playing \? 0 : IDLE_FRAME_MS\)/);
    expect(src).toMatch(/document !== 'undefined' && document\.hidden/);
  });

  test('dispose invalidates pending async work and clears both schedulers', () => {
    expect(src).toMatch(/dispose\(\) \{[\s\S]*\+\+this\._loadGeneration/);
    expect(src).toContain('clearTimeout(this._idleTimer)');
    expect(src).toContain('cancelAnimationFrame(this._rafId)');
  });
});
