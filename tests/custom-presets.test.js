/**
 * VIP-021 box 3 — the "Save Custom" preset modal actually saves.
 *
 * The modal's Save button previously performed no save at all (its handler
 * only removed a keydown listener and restored focus); no save path existed
 * anywhere in the app. These tests pin the new pure storage logic in
 * src/core/CustomPresets.js and assert app.js wires the modal to it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let CUSTOM_PRESETS_KEY;
let MAX_CUSTOM_PRESETS;
let buildCustomPresetValues;
let isBuiltInPresetName;
let loadCustomPresets;
let persistCustomPresets;
let sanitizeCustomPresets;
let upsertPresetOption;

function memoryStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    _store: store,
  };
}

function fakeSelect(existing = []) {
  const options = existing.map((value) => ({ value, textContent: value }));
  return {
    options,
    value: options[0] ? options[0].value : '',
    appendChild(el) {
      options.push(el);
    },
  };
}

function fakeDoc() {
  return {
    createElement: () => ({ value: '', textContent: '' }),
  };
}

beforeAll(async () => {
  const mod = await import('../src/core/CustomPresets.js');
  CUSTOM_PRESETS_KEY = mod.CUSTOM_PRESETS_KEY;
  MAX_CUSTOM_PRESETS = mod.MAX_CUSTOM_PRESETS;
  buildCustomPresetValues = mod.buildCustomPresetValues;
  isBuiltInPresetName = mod.isBuiltInPresetName;
  loadCustomPresets = mod.loadCustomPresets;
  persistCustomPresets = mod.persistCustomPresets;
  sanitizeCustomPresets = mod.sanitizeCustomPresets;
  upsertPresetOption = mod.upsertPresetOption;
});

describe('VIP-021 — custom preset storage', () => {
  test('round-trips through storage and sanitizes corrupt entries', () => {
    const storage = memoryStorage();
    expect(loadCustomPresets(storage)).toEqual({});
    expect(loadCustomPresets(null)).toEqual({});
    const dirty = {
      'My Voice': { gateThresh: -30, nrAmount: 'not-a-number', junk: 'x' },
      '': { gateThresh: 0 },
      Broken: 'nope',
    };
    storage.setItem(CUSTOM_PRESETS_KEY, JSON.stringify(dirty));
    const loaded = loadCustomPresets(storage);
    expect(loaded['My Voice']).toEqual({ gateThresh: -30 });
    expect(loaded['']).toBeUndefined();
    expect(loaded.Broken).toBeUndefined();
    storage.setItem(CUSTOM_PRESETS_KEY, '{not json');
    expect(loadCustomPresets(storage)).toEqual({});
    expect(persistCustomPresets(null, {})).toBe(false);
    expect(persistCustomPresets(storage, { A: { gateThresh: 1 } })).toBe(true);
    expect(JSON.parse(storage.getItem(CUSTOM_PRESETS_KEY))).toEqual({ A: { gateThresh: 1 } });
  });

  test('sanitize caps preset count and name length', () => {
    const raw = {};
    for (let i = 0; i < MAX_CUSTOM_PRESETS + 5; i++) raw[`P${i}`] = { gateThresh: i };
    raw['x'.repeat(200)] = { gateThresh: 0 };
    expect(Object.keys(sanitizeCustomPresets(raw)).length).toBe(MAX_CUSTOM_PRESETS);
  });

  test('build fills every spec id and clamps to range', () => {
    const specs = [
      { id: 'gateThresh', min: -120, max: 0, val: -42 },
      { id: 'nrAmount', min: 0, max: 100, val: 52 },
      { id: 'eqMid', min: -24, max: 24, val: 0 },
    ];
    const values = buildCustomPresetValues({ gateThresh: 500, nrAmount: 'nan' }, specs);
    expect(values).toEqual({ gateThresh: 0, nrAmount: 52, eqMid: 0 });
  });

  test('built-in collision rule', () => {
    const builtIns = new Set(['Voice Clarity', 'voice-clarity']);
    expect(isBuiltInPresetName('Voice Clarity', builtIns)).toBe(true);
    expect(isBuiltInPresetName('My Voice', builtIns)).toBe(false);
  });

  test('upsert adds a missing option and selects it; boot sync does not reselect', () => {
    const select = fakeSelect(['Voice Clarity']);
    expect(upsertPresetOption(select, 'My Voice', { doc: fakeDoc() })).toBe(true);
    expect(select.options.map((o) => o.value)).toEqual(['Voice Clarity', 'My Voice']);
    expect(select.value).toBe('My Voice');
    expect(upsertPresetOption(select, 'My Voice', { doc: fakeDoc() })).toBe(false);
    select.value = 'Voice Clarity';
    expect(upsertPresetOption(select, 'My Voice', { select: false, doc: fakeDoc() })).toBe(false);
    expect(select.value).toBe('Voice Clarity');
  });
});

describe('VIP-021 — app.js wires the Save Custom modal to the store', () => {
  test('save handler persists, merges, and notifies (source contract)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'public/app/app.js'), 'utf8');
    expect(src).toContain("from '/src/core/CustomPresets.js'");
    expect(src).toContain('saveCustomPresetBtn');
    expect(src).toContain('persistCustomPresets(storage, customs)');
    expect(src).toContain('upsertPresetOption(d.presetSel, name)');
    expect(src).toContain('Custom preset saved: ');
    expect(src).toContain('A built-in preset already uses that name');
    expect(src).toContain('loadCustomPresets(storage)');
  });
});
