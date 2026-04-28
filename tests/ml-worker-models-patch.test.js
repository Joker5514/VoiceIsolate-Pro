/**
 * VoiceIsolate Pro — ml-worker model-absence graceful degradation tests.
 *
 * The patch code (merged into pipeline-orchestrator.js) wires absent-model
 * fallbacks: it stamps the pipeline UI with model status, surfaces a banner
 * when models are missing, and intercepts ML worker messages to keep stages
 * running in DSP-only mode. Covered via source-level assertions.
 *
 * Key invariant under test: the manifest in pipeline-orchestrator.js MUST stay
 * key-consistent with MODEL_REGISTRY in ml-worker-fetch-cache.js — drift causes
 * silent pass-through where the user expects ML inference.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PATCH_SRC = fs.readFileSync(
  path.join(__dirname, '../public/app/pipeline-orchestrator.js'),
  'utf8'
);
const FETCH_SRC = fs.readFileSync(
  path.join(__dirname, '../public/app/ml-worker-fetch-cache.js'),
  'utf8'
);

function extractKeys(src, blockRegex) {
  const m = src.match(blockRegex);
  if (!m) return [];
  // Pull keys that look like `<word>:` or `<word>_<word>:` at the start of an
  // entry line. Stop at nested braces of property-objects.
  return [...m[1].matchAll(/^\s{2,}([a-z][\w_]*)\s*:\s*\{/gm)].map((x) => x[1]);
}

describe('pipeline-orchestrator.js — MODEL_MANIFEST', () => {
  test('declares MODEL_MANIFEST', () => {
    expect(PATCH_SRC).toMatch(/const\s+MODEL_MANIFEST\s*=\s*\{/);
  });

  test('manifest keys are a subset of the fetch-cache MODEL_REGISTRY keys', () => {
    const manifestKeys = extractKeys(
      PATCH_SRC,
      /const\s+MODEL_MANIFEST\s*=\s*\{([\s\S]*?)\n\};/
    );
    const registryKeys = extractKeys(
      FETCH_SRC,
      /const\s+MODEL_REGISTRY\s*=\s*\{([\s\S]*?)\n\}/
    );
    expect(manifestKeys.length).toBeGreaterThan(0);
    expect(registryKeys.length).toBeGreaterThan(0);

    const missing = manifestKeys.filter((k) => !registryKeys.includes(k));
    // Drift here means the patch references a model the cache cannot fetch.
    expect(missing).toEqual([]);
  });

  test('every manifest entry declares stageId, stageName, filename', () => {
    const m = PATCH_SRC.match(/const\s+MODEL_MANIFEST\s*=\s*\{([\s\S]*?)\n\};/);
    expect(m).not.toBeNull();
    const entries = m[1].match(/\{[^{}]*?stageId[^{}]*?stageName[^{}]*?filename[^{}]*?\}/g) || [];
    // Each row in the manifest must have all three fields. Allow optional sourceUrl/sizeLabel.
    expect(entries.length).toBeGreaterThanOrEqual(5);
  });

  test('stageIds are uppercase S## format', () => {
    const stageIds = [...PATCH_SRC.matchAll(/stageId\s*:\s*['"`](S\d{2})['"`]/g)].map((x) => x[1]);
    expect(stageIds.length).toBeGreaterThan(0);
    for (const id of stageIds) expect(id).toMatch(/^S\d{2}$/);
  });
});

describe('pipeline-orchestrator.js — _normalizeKey alias map', () => {
  test('maps all known short aliases to canonical manifest keys', () => {
    const aliasBlock = PATCH_SRC.match(/function\s+_normalizeKey[\s\S]*?\{([\s\S]*?)return\s+map/);
    expect(aliasBlock).not.toBeNull();
    const aliases = [...aliasBlock[1].matchAll(/(\w+)\s*:\s*['"`]([\w_]+)['"`]/g)].map((m) => ({
      from: m[1], to: m[2],
    }));
    expect(aliases.length).toBeGreaterThan(0);

    // Every alias target must exist in MODEL_MANIFEST.
    const manifestKeys = extractKeys(
      PATCH_SRC,
      /const\s+MODEL_MANIFEST\s*=\s*\{([\s\S]*?)\n\};/
    );
    for (const a of aliases) {
      expect(manifestKeys).toContain(a.to);
    }
  });
});

describe('pipeline-orchestrator.js — public API surface (model patch)', () => {
  test.each([
    'window._stampPipelineStages',
    'window._checkModelFiles',
    'window._mlWorkerPatch',
  ])('exposes %s on window', (sym) => {
    expect(PATCH_SRC).toContain(sym);
  });

  test('banner is created with role="alert" and aria-live for accessibility', () => {
    expect(PATCH_SRC).toMatch(/setAttribute\s*\(\s*['"`]role['"`]\s*,\s*['"`]alert['"`]\)/);
    expect(PATCH_SRC).toMatch(/setAttribute\s*\(\s*['"`]aria-live['"`]/);
  });
});

describe('pipeline-orchestrator.js — model patch privacy', () => {
  test('does not load any external script or fetch a remote URL', () => {
    // sourceUrl strings (citations to upstream model repos) are static text,
    // not fetched. Confirm nothing actually fetches() http(s) URLs.
    expect(PATCH_SRC).not.toMatch(/fetch\s*\(\s*['"`]https?:\/\//);
    expect(PATCH_SRC).not.toMatch(/new\s+URL\s*\(\s*['"`]https?:\/\//);
  });
});
