/**
 * gateAttack contract: Engineer, landing, and PlaybackMixer share 0–200 ms.
 * Legacy 0–500 ms snapshots are migrated with an explicit warning.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let migrateParamSnapshot;
let migrateGateAttack;
let PARAM_CONTRACT_VERSION;
let PARAMETER_BY_ID;

beforeAll(async () => {
  ({ migrateParamSnapshot, migrateGateAttack, PARAM_CONTRACT_VERSION } = await import('../src/core/ParamMigration.js'));
  ({ PARAMETER_BY_ID } = await import('../src/core/ParameterSchema.js'));
});

describe('gateAttack contract', () => {
  test('schema, registry, Engineer SLIDERS, and landing slider share 0–200 ms', () => {
    const spec = PARAMETER_BY_ID.get('gateAttack');
    expect(spec).toMatchObject({ min: 0, max: 200, default: 5, unit: 'ms' });

    const registry = fs.readFileSync(path.join(ROOT, 'public/app/slider-map.js'), 'utf8');
    expect(registry).toMatch(/id:\s*'gateAttack'[\s\S]*?min:\s*0,\s*max:\s*200/);

    const appJs = fs.readFileSync(path.join(ROOT, 'public/app/app.js'), 'utf8');
    expect(appJs).toMatch(/id:'gateAttack'[^}]*max:200/);

    const landing = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    expect(landing).toMatch(/id="gateAttackSlider"[^>]*max="200"/);

    const mixer = fs.readFileSync(path.join(ROOT, 'src/pipeline/PlaybackMixer.js'), 'utf8');
    expect(mixer).toMatch(/PARAMETER_BY_ID\.get\('gateAttack'\)/);
    expect(mixer).not.toMatch(/setGateAttack\(ms\)\s*\{\s*this\._setGateParam\('attack',\s*clamp\(ms,\s*0,\s*200\)\)/);
  });
});

describe('migrateGateAttack', () => {
  test('keeps an in-range millisecond value', () => {
    expect(migrateGateAttack(150, 0)).toEqual({ value: 150, warnings: [] });
    expect(migrateGateAttack(5, PARAM_CONTRACT_VERSION)).toEqual({ value: 5, warnings: [] });
  });

  test('reports a legacy 201–500 ms value and sets the engine maximum', () => {
    const result = migrateGateAttack(350, 0);
    expect(result.value).toBe(200);
    expect(result.warnings[0]).toMatch(/350 ms/);
    expect(result.warnings[0]).toMatch(/200 ms/);
  });

  test('resets an unsupported value instead of clamping it', () => {
    const high = migrateGateAttack(900, 0);
    expect(high.value).toBe(5);
    expect(high.warnings[0]).toMatch(/reset to 5 ms/);

    const versioned = migrateGateAttack(350, PARAM_CONTRACT_VERSION);
    expect(versioned.value).toBe(5);
    expect(versioned.warnings[0]).toMatch(/outside 0–200 ms/);
  });

  test('resets a non-finite value', () => {
    expect(migrateGateAttack(Number.NaN, 0).value).toBe(5);
  });
});

describe('project pack migration', () => {
  test('a legacy gateAttack in a pack is stored at the engine limit and reported', async () => {
    const { sanitizePackManifest } = await import('../src/core/ProjectPack.js');
    const files = new Map([['sources/a', new Uint8Array([1])]]);
    const pack = sanitizePackManifest({
      project: { name: 'Old session', savedParams: { gateAttack: 400, gain: 3 } },
      files: [{ path: 'sources/a' }],
    }, files);
    expect(pack.savedParams).toEqual({ gateAttack: 200, gain: 3 });
    expect(pack.paramWarnings).toHaveLength(1);
    expect(pack.paramContractVersion).toBe(PARAM_CONTRACT_VERSION);
  });
});

describe('migrateParamSnapshot', () => {
  test('leaves unrelated controls alone and stamps the contract version', () => {
    const result = migrateParamSnapshot({ nrAmount: 40, gateAttack: 80, label: 'nope' });
    expect(result.version).toBe(PARAM_CONTRACT_VERSION);
    expect(result.params).toEqual({ nrAmount: 40, gateAttack: 80 });
    expect(result.changed).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test('records the legacy gateAttack change', () => {
    const result = migrateParamSnapshot({ gateAttack: 500, outGain: 3 }, { version: 0 });
    expect(result.params.gateAttack).toBe(200);
    expect(result.params.outGain).toBe(3);
    expect(result.changed).toEqual([{ id: 'gateAttack', from: 500, to: 200 }]);
    expect(result.warnings).toHaveLength(1);
  });

  test('a v2 snapshot does not rewrite an in-range attack', () => {
    const result = migrateParamSnapshot(
      { gateAttack: 200, paramContractVersion: PARAM_CONTRACT_VERSION },
      { version: PARAM_CONTRACT_VERSION },
    );
    expect(result.params.gateAttack).toBe(200);
    expect(result.params.paramContractVersion).toBeUndefined();
    expect(result.changed).toEqual([]);
  });
});
