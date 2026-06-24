/**
 * VoiceIsolate Pro — Diarization Timeline source-inspection tests.
 *
 * diarization-timeline.js is an ES module loaded into the page via
 *   <script type="module">
 * It depends on a live DOM (canvas, playhead, time label) that does not exist
 * in the Node test environment, so we cover its public surface via source-level
 * assertions. Behaviour-level tests should run in Playwright/Puppeteer where a
 * real DOM is available.
 *
 * The previous Vitest-based suite at public/app/diarization-timeline.test.js
 * was outside Jest's testMatch and never executed in CI; this file replaces it.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '../public/app/diarization-timeline.js');
const SRC      = fs.readFileSync(SRC_PATH, 'utf8');

describe('diarization-timeline.js — module surface', () => {
  test.each([
    ['initDiarizationTimeline'],
    ['onDiarizationResult'],
    ['seekTimeline'],
    ['zoomTimeline'],
    ['fitTimeline'],
    ['setSpeakerVolume'],
    ['setSpeakerMute'],
    ['setSpeakerSolo'],
  ])('exports %s as a named function', (name) => {
    const re = new RegExp(`export\\s+function\\s+${name}\\b`);
    expect(SRC).toMatch(re);
  });

  test('uses ES module syntax (export, not module.exports)', () => {
    // The file is loaded via <script type="module">; CJS exports would never
    // resolve in the browser. Guarding against accidental conversions.
    expect(SRC).toMatch(/^export\s+function/m);
    expect(SRC).not.toMatch(/module\.exports\s*=/);
  });
});

describe('diarization-timeline.js — palette & color assignment', () => {
  test('defines an 8-color palette', () => {
    const m = SRC.match(/const\s+PALETTE\s*=\s*\[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const colors = m[1].match(/#[0-9a-fA-F]{6}/g) || [];
    expect(colors).toHaveLength(8);
  });

  test('color assignment cycles via modulo (no unbounded growth)', () => {
    expect(SRC).toMatch(/_colorIndex\+\+\s*%\s*PALETTE\.length/);
  });
});

describe('diarization-timeline.js — default DOM ids', () => {
  test.each([
    ['diarPlayhead'],
    ['diarTimeLabel'],
    ['diarSpeakerCount'],
  ])('default id %s used when opts override is missing', (id) => {
    expect(SRC).toContain(id);
  });
});
