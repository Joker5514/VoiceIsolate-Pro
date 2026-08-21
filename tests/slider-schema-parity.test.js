/**
 * Slider schema parity — registry ↔ ParameterSchema ↔ app mount contract.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const appJs = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
const workflowJs = fs.readFileSync(path.join(ROOT, 'public/app/workflow-tier.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public/app/index.html'), 'utf8');
const sliderMapSrc = fs.readFileSync(path.join(ROOT, 'public/app/slider-map.js'), 'utf8');
const schemaSrc = fs.readFileSync(path.join(ROOT, 'src/core/ParameterSchema.js'), 'utf8');

function parseRegistryEntries(src) {
  const entries = [];
  const re = /\{\s*id\s*:\s*'([^']+)',\s*key\s*:\s*'([^']+)'[\s\S]*?min\s*:\s*([^,]+),\s*max\s*:\s*([^,]+),\s*step\s*:\s*([^,]+),\s*default\s*:\s*([^,]+),[\s\S]*?target\s*:\s*'([^']+)'[\s\S]*?group\s*:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    entries.push({
      id: m[1],
      key: m[2],
      min: Number(m[3]),
      max: Number(m[4]),
      step: Number(m[5]),
      default: Number(m[6]),
      target: m[7],
      group: m[8],
    });
  }
  return entries;
}

function parseSchemaEntries(src) {
  const entries = [];
  const re = /\{\s*id:\s*'([^']+)'[^}]*?min:\s*([^,]+),\s*max:\s*([^,]+),\s*default:\s*([^,]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    entries.push({
      id: m[1],
      min: Number(m[2]),
      max: Number(m[3]),
      default: Number(m[4]),
    });
  }
  return entries;
}

describe('slider schema parity', () => {
  const registry = parseRegistryEntries(sliderMapSrc);
  const schema = parseSchemaEntries(schemaSrc);

  test('SLIDER_REGISTRY has exactly 67 entries with unique ids', () => {
    expect(registry.length).toBe(67);
    expect(new Set(registry.map((s) => s.id)).size).toBe(67);
  });

  test('ParameterSchema covers every registry id with matching bounds', () => {
    const byId = Object.fromEntries(schema.map((s) => [s.id, s]));
    const mismatches = [];
    for (const s of registry) {
      const p = byId[s.id];
      if (!p) {
        mismatches.push(`missing schema:${s.id}`);
        continue;
      }
      if (p.min !== s.min || p.max !== s.max || p.default !== s.default) {
        mismatches.push(`${s.id}: registry(${s.min},${s.max},${s.default}) vs schema(${p.min},${p.max},${p.default})`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('every registry group panel exists in Engineer HTML', () => {
    const groups = [...new Set(registry.map((s) => s.group))];
    for (const g of groups) {
      expect(html).toContain(`id="${g}"`);
    }
  });

  test('Creator/Studio/Forensic expose full rack (groups: null)', () => {
    expect(workflowJs).toMatch(/creator:[\s\S]*?groups:\s*null/);
    expect(workflowJs).toMatch(/studio:[\s\S]*?groups:\s*null/);
    expect(workflowJs).toMatch(/forensic:[\s\S]*?groups:\s*null/);
    expect(workflowJs).toMatch(/defaultFilterMode:\s*'essentials'/);
  });

  test('Essentials filter chip is wired in HTML + app.js', () => {
    expect(html).toContain('sliderFilterEssentials');
    expect(appJs).toMatch(/sliderFilterEssentials/);
    expect(appJs).toMatch(/mode === 'essentials'/);
  });

  test('app prefers registry ranges for SLIDER_BY_ID', () => {
    expect(appJs).toMatch(/for \(const s of SLIDER_REGISTRY\)/);
    expect(appJs).toMatch(/SLIDER_REGISTRY/);
  });
});
