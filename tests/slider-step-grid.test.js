/**
 * Every registered slider default must survive clampSnap unchanged.
 * Steps stay in lockstep across the registry, ParameterSchema, and app.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function parseRegistry(src) {
  const entries = [];
  const re = /\{\s*id\s*:\s*'([^']+)',\s*key\s*:\s*'([^']+)'[\s\S]*?min\s*:\s*([^,]+),\s*max\s*:\s*([^,]+),\s*step\s*:\s*([^,]+),\s*default\s*:\s*([^,]+)/g;
  let m;
  while ((m = re.exec(src))) {
    entries.push({
      id: m[1],
      min: Number(m[3]),
      max: Number(m[4]),
      step: Number(m[5]),
      default: Number(m[6]),
    });
  }
  return entries;
}

function parseSchema(src) {
  const rows = [];
  const re = /\{\s*id:\s*'(\w+)'[^}]*\}/g;
  let m;
  while ((m = re.exec(src))) {
    const row = m[0];
    const num = (field) => {
      const hit = row.match(new RegExp(`${field}\\s*:\\s*(-?[\\d.]+)`));
      return hit ? Number(hit[1]) : undefined;
    };
    rows.push({ id: m[1], min: num('min'), max: num('max'), default: num('default'), step: num('step') });
  }
  return rows;
}

function parseApp(src) {
  const block = src.match(/const SLIDERS = \{([\s\S]*?)\n\};/);
  if (!block) return [];
  const rows = [];
  const re = /\{\s*id\s*:\s*'(\w+)'[^}]*\}/g;
  let m;
  while ((m = re.exec(block[1]))) {
    const row = m[0];
    const num = (field) => {
      const hit = row.match(new RegExp(`${field}\\s*:\\s*(-?[\\d.]+)`));
      return hit ? Number(hit[1]) : undefined;
    };
    rows.push({ id: m[1], min: num('min'), max: num('max'), default: num('val'), step: num('step') });
  }
  return rows;
}

let clampSnap;
beforeAll(async () => {
  ({ clampSnap } = await import('../src/presentation/DspSlider.js'));
});

describe('slider step grid', () => {
  const registry = parseRegistry(fs.readFileSync(path.join(ROOT, 'public/app/slider-map.js'), 'utf8'));
  const schema = parseSchema(fs.readFileSync(path.join(ROOT, 'src/core/ParameterSchema.js'), 'utf8'));
  const app = parseApp(fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8'));
  const schemaById = Object.fromEntries(schema.map((row) => [row.id, row]));
  const appById = Object.fromEntries(app.map((row) => [row.id, row]));

  test('registry has the 67 engineer controls', () => {
    expect(registry).toHaveLength(67);
  });

  test('clampSnap(default) === default for every registry entry', () => {
    const bad = registry.filter((row) => clampSnap(row.default, row.min, row.max, row.step) !== row.default);
    expect(bad.map((row) => `${row.id} default ${row.default} step ${row.step} -> ${clampSnap(row.default, row.min, row.max, row.step)}`)).toEqual([]);
  });

  test('schema and app.js defaults also lie on their own step grid', () => {
    const bad = [];
    for (const row of [...schema, ...app]) {
      if (![row.min, row.max, row.step, row.default].every(Number.isFinite)) continue;
      const snapped = clampSnap(row.default, row.min, row.max, row.step);
      if (snapped !== row.default) bad.push(`${row.id}:${row.default}->${snapped}`);
    }
    expect(bad).toEqual([]);
  });

  test('step and default match across registry, schema, and app.js', () => {
    const mismatches = [];
    for (const row of registry) {
      const schemaRow = schemaById[row.id];
      const appRow = appById[row.id];
      if (!schemaRow) mismatches.push(`schema missing ${row.id}`);
      else if (schemaRow.step !== row.step || schemaRow.default !== row.default || schemaRow.min !== row.min || schemaRow.max !== row.max) {
        mismatches.push(`schema ${row.id}`);
      }
      if (!appRow) mismatches.push(`app missing ${row.id}`);
      else if (appRow.step !== row.step || appRow.default !== row.default || appRow.min !== row.min || appRow.max !== row.max) {
        mismatches.push(`app ${row.id}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('documented defaults stay legal, including Butterworth Q', () => {
    const byId = Object.fromEntries(registry.map((row) => [row.id, row]));
    expect(byId.gateHold).toMatchObject({ step: 5, default: 20 });
    expect(byId.compRelease).toMatchObject({ step: 10, default: 150 });
    expect(byId.limRelease).toMatchObject({ step: 1, default: 50 });
    expect(byId.hpQ).toMatchObject({ step: 0.001, default: 0.707 });
    expect(byId.lpQ).toMatchObject({ step: 0.001, default: 0.707 });
    expect(byId.voiceIso).toMatchObject({ step: 1, default: 72 });
    expect(byId.bgSuppress).toMatchObject({ step: 1, default: 38 });
    expect(clampSnap(0.707, 0.5, 10, 0.001)).toBe(0.707);
    expect(clampSnap(72, 0, 100, 1)).toBe(72);
    expect(clampSnap(38, 0, 100, 1)).toBe(38);
  });
});
