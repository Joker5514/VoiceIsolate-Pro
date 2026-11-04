/**
 * VIP-021 — Engineer controls inventory stays true.
 *
 * docs/guides/ENGINEER_CONTROLS.md is the inventory of every visible Engineer
 * control. These tests pin it to the code it describes, so adding a control
 * without documenting it (or documenting one that no longer exists in the
 * slider tables) fails loudly instead of letting the inventory rot:
 *  - every SLIDER_REGISTRY id has a slider-table row in the doc;
 *  - the doc's RT/PROC marking matches LIVE_MIX_PARAM_IDS exactly;
 *  - every interactive id in public/app/index.html is mentioned in the doc.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let SLIDER_REGISTRY;
let LIVE_MIX_PARAM_IDS;

// public/app modules are browser ESM: load them through a vm module graph
// (same pattern as tests/vip021-engineer-action-controls.test.js) instead
// of a plain import, which jest's CJS transform cannot parse.
async function loadBrowserModule(relPath, ctx, cache = new Map()) {
  const fullPath = path.resolve(__dirname, '..', relPath);
  if (cache.has(fullPath)) return cache.get(fullPath);
  const src = fs.readFileSync(fullPath, 'utf8');
  const mod = new vm.SourceTextModule(src, { identifier: fullPath, context: ctx });
  cache.set(fullPath, mod);
  await mod.link(async (specifier) => {
    const resolved = specifier.startsWith('/src/')
      ? path.resolve(__dirname, '..', specifier.slice(1))
      : path.resolve(path.dirname(fullPath), specifier);
    const relResolved = path.relative(path.resolve(__dirname, '..'), resolved);
    return loadBrowserModule(relResolved, ctx, cache);
  });
  await mod.evaluate();
  return mod;
}

beforeAll(async () => {
  const ctx = vm.createContext({ console });
  const sliderMap = await loadBrowserModule('public/app/slider-map.js', ctx);
  SLIDER_REGISTRY = sliderMap.namespace.SLIDER_REGISTRY;
  ({ LIVE_MIX_PARAM_IDS } = await import('../src/core/ParameterSchema.js'));
});

function readDoc() {
  return fs.readFileSync(path.resolve(__dirname, '..', 'docs/guides/ENGINEER_CONTROLS.md'), 'utf8');
}

function sliderRows(doc) {
  // | `id` (label, which may itself contain parentheses) | range | step | default | unit | RT|PROC | entry |
  const rows = new Map();
  for (const line of doc.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cols = line.split('|').map((c) => c.trim());
    const idMatch = cols[1].match(/^`([a-zA-Z]+)`/);
    if (idMatch && (cols[6] === 'RT' || cols[6] === 'PROC')) rows.set(idMatch[1], cols[6]);
  }
  return rows;
}

describe('VIP-021 — Engineer controls inventory', () => {
  test('every registry slider has a row in the inventory', () => {
    const doc = readDoc();
    const rows = sliderRows(doc);
    expect(SLIDER_REGISTRY.length).toBe(67);
    for (const s of SLIDER_REGISTRY) {
      expect(rows.has(s.id)).toBe(true);
    }
    expect(rows.size).toBe(67);
  });

  test('doc RT marking matches LIVE_MIX_PARAM_IDS exactly', () => {
    const doc = readDoc();
    const rows = sliderRows(doc);
    const live = new Set(LIVE_MIX_PARAM_IDS);
    const rtInDoc = new Set([...rows.entries()].filter(([, when]) => when === 'RT').map(([id]) => id));
    expect(rtInDoc).toEqual(live);
    for (const s of SLIDER_REGISTRY) {
      expect(rows.get(s.id)).toBe(live.has(s.id) ? 'RT' : 'PROC');
    }
  });

  test('every interactive Engineer UI id is mentioned in the inventory', () => {
    const doc = readDoc();
    const html = fs.readFileSync(path.resolve(__dirname, '..', 'public/app/index.html'), 'utf8');
    const ids = [...html.matchAll(/<(?:button|select|input|textarea|a)\b[^>]*?\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(50);
    const missing = ids.filter((id) => !doc.includes(`\`${id}\``));
    expect(missing).toEqual([]);
  });

  test('dynamic control groups are documented', () => {
    const doc = readDoc();
    for (const needle of [
      'data-profile',
      'data-action',
      'whisperMode',
      'Enroll this voice',
      'Isolate target speaker',
      'USM is backend-only',
      'Hidden aliases',
    ]) {
      expect(doc).toContain(needle);
    }
  });
});
