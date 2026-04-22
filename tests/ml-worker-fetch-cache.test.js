/**
 * VoiceIsolate Pro — ml-worker-fetch-cache.js source-inspection tests.
 *
 * The fetch-cache module relies on browser-only globals (indexedDB, fetch,
 * URL.createObjectURL, window) at top level. Direct require() in Node would
 * crash before any assertion can run, so we cover its contract with
 * source-level assertions that protect the privacy and architectural
 * invariants in CLAUDE.md.
 *
 * Behaviour-level tests (real IDB round-trip, chunked fetch progress) belong
 * in a Playwright/jsdom integration suite once one is set up.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '../public/app/ml-worker-fetch-cache.js'),
  'utf8'
);

describe('ml-worker-fetch-cache.js — model registry contract', () => {
  test('declares MODEL_REGISTRY with only relative paths (no http/https)', () => {
    const m = SRC.match(/const\s+MODEL_REGISTRY\s*=\s*\{([\s\S]*?)\n\}/);
    expect(m).not.toBeNull();
    const body = m[1];
    // Privacy invariant: every model path must be local.
    expect(body).not.toMatch(/path\s*:\s*['"`]https?:\/\//);
    // Each entry should declare a sizeBytes field for progress UI fallback.
    const entries = body.match(/\{\s*path\s*:\s*['"`][^'"`]+['"`]\s*,\s*sizeBytes\s*:\s*[\d_]+/g) || [];
    expect(entries.length).toBeGreaterThanOrEqual(5);
  });

  test('every registered model path begins with "models/"', () => {
    const re = /path\s*:\s*['"`]([^'"`]+)['"`]/g;
    let m;
    const paths = [];
    while ((m = re.exec(SRC)) !== null) paths.push(m[1]);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(p).toMatch(/^models\//);
  });

  test('IDB version is bumpable and constants are present', () => {
    expect(SRC).toMatch(/const\s+VIP_IDB_NAME\s*=\s*['"`]vip-model-cache['"`]/);
    expect(SRC).toMatch(/const\s+VIP_IDB_VERSION\s*=\s*\d+/);
    expect(SRC).toMatch(/const\s+VIP_IDB_STORE\s*=\s*['"`]models['"`]/);
  });
});

describe('ml-worker-fetch-cache.js — public API surface', () => {
  test.each([
    'window._vipPreloadModels',
    'window._vipClearModelCache',
    'window._vipCacheStatus',
    'window._vipModelRegistry',
  ])('exposes %s on window for orchestrator integration', (sym) => {
    expect(SRC).toContain(sym);
  });

  test('declares helpers for IDB CRUD', () => {
    for (const fn of ['idbGet', 'idbPut', 'idbDelete', 'idbListKeys']) {
      expect(SRC).toMatch(new RegExp(`async\\s+function\\s+${fn}\\b`));
    }
  });

  test('progress events use a vip:* namespace (no global pollution)', () => {
    expect(SRC).toMatch(/vip:modelDownloadProgress/);
  });
});

describe('ml-worker-fetch-cache.js — privacy invariants', () => {
  test('no fetch() targets a non-relative URL', () => {
    const fetchCalls = SRC.match(/fetch\s*\(\s*['"`]([^'"`]+)['"`]/g) || [];
    for (const call of fetchCalls) {
      const url = call.replace(/.*['"`]([^'"`]+)['"`]/, '$1');
      // Allow relative paths starting with `models/`, `./`, or `/lib/`.
      expect(url).not.toMatch(/^https?:\/\//);
    }
  });

  test('does not POST audio buffers anywhere', () => {
    // application/octet-stream may legitimately appear when constructing a
    // local Blob for IDB caching; we only care about outbound uploads.
    expect(SRC).not.toMatch(/method\s*:\s*['"`]POST/);
    expect(SRC).not.toMatch(/audio\/wav/);
  });
});

describe('ml-worker-fetch-cache.js — Object URL lifecycle', () => {
  test('tracks created Object URLs in a Map for explicit revocation', () => {
    expect(SRC).toMatch(/const\s+_objectURLs\s*=\s*new Map\(/);
  });

  test('exposes a revokeAllModelURLs helper to prevent memory leaks', () => {
    expect(SRC).toMatch(/function\s+revokeAllModelURLs\b/);
    expect(SRC).toMatch(/URL\.revokeObjectURL/);
  });
});
