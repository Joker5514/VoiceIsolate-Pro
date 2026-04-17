/**
 * VoiceIsolate Pro — LicenseManager Unit Tests (DEV BYPASS MODE)
 *
 * The license manager is currently in dev-bypass mode: all tiers return
 * ENTERPRISE-level caps and every feature/preset is unlocked. These tests
 * verify the bypass behaves correctly. When real tier enforcement is
 * reintroduced, replace this file with the full tier-gating suite.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── localStorage mock ─────────────────────────────────────────────────────────
let _localStore = {};
const localStorageMock = {
  getItem:    (k)    => Object.prototype.hasOwnProperty.call(_localStore, k) ? _localStore[k] : null,
  setItem:    (k, v) => { _localStore[k] = String(v); },
  removeItem: (k)    => { delete _localStore[k]; },
  clear:      ()     => { _localStore = {}; },
};

beforeEach(() => {
  _localStore = {};
});

// ── Browser global stubs ──────────────────────────────────────────────────────
global.localStorage        = localStorageMock;
global.window              = { addEventListener: () => {} };

// ── Load LicenseManager via eval (CJS-compatible export path) ─────────────────
const lmSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/license-manager.js'),
  'utf8'
);

const LicenseManager = (() => {
  const exports = {};
  const module  = { exports };
  /* eslint-disable no-unused-vars */
  const window   = global.window;
  const localStorage = global.localStorage;
  /* eslint-enable no-unused-vars */
  eval(lmSrc); // eslint-disable-line no-eval
  return module.exports;
})();

function makeToken(tier = 'PRO') {
  const payload = {
    tier: tier.toLowerCase(),
    sub: 'test_user',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30 * 86400,
    source: 'test',
  };
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = btoa(JSON.stringify(payload));
  const sig    = btoa('test_sig');
  return `${header}.${body}.${sig}`;
}

// ── Tier forcing ──────────────────────────────────────────────────────────────
describe('LicenseManager dev-bypass — tier', () => {
  beforeEach(() => { LicenseManager.init(); });

  test('getTier() always returns ENTERPRISE', () => {
    expect(LicenseManager.getTier()).toBe('ENTERPRISE');
  });

  test('getTier() stays ENTERPRISE after deactivate()', () => {
    LicenseManager.deactivate();
    expect(LicenseManager.getTier()).toBe('ENTERPRISE');
  });

  test('getTierDef() returns the ENTERPRISE definition', () => {
    const def = LicenseManager.getTierDef();
    expect(def).toBeTruthy();
    expect(def.id).toBe('enterprise');
  });

  test('init() ignores any stored license', () => {
    localStorageMock.setItem(
      'vip_license_v22',
      JSON.stringify({ token: makeToken('PRO'), email: 'a@b.com' })
    );
    LicenseManager.init();
    expect(LicenseManager.getTier()).toBe('ENTERPRISE');
  });

  test('init() ignores malformed stored JSON', () => {
    localStorageMock.setItem('vip_license_v22', 'not-json');
    LicenseManager.init();
    expect(LicenseManager.getTier()).toBe('ENTERPRISE');
  });
});

// ── activate() / activateTrial() ─────────────────────────────────────────────
describe('LicenseManager dev-bypass — activation', () => {
  beforeEach(() => { LicenseManager.init(); });

  test('activate() always succeeds and returns ENTERPRISE', () => {
    const result = LicenseManager.activate(makeToken('PRO'));
    expect(result.success).toBe(true);
    expect(result.tier).toBe('ENTERPRISE');
  });

  test('activate() succeeds even for malformed tokens', () => {
    expect(LicenseManager.activate('bad-token').success).toBe(true);
    expect(LicenseManager.activate('').success).toBe(true);
    expect(LicenseManager.activate(null).success).toBe(true);
  });

  test('activateTrial() always succeeds and returns ENTERPRISE', () => {
    const result = LicenseManager.activateTrial('PRO');
    expect(result.success).toBe(true);
    expect(result.tier).toBe('ENTERPRISE');
  });

  test('activateTrial() can be called repeatedly without failure', () => {
    LicenseManager.activateTrial('PRO');
    const second = LicenseManager.activateTrial('PRO');
    expect(second.success).toBe(true);
  });

  test('deactivate() is a no-op (tier stays ENTERPRISE)', () => {
    LicenseManager.deactivate();
    expect(LicenseManager.getTier()).toBe('ENTERPRISE');
  });
});

// ── Feature & preset gating ──────────────────────────────────────────────────
describe('LicenseManager dev-bypass — gating', () => {
  beforeEach(() => { LicenseManager.init(); });

  test('can() returns true for every feature', () => {
    expect(LicenseManager.can('basicNoiseReduction')).toBe(true);
    expect(LicenseManager.can('voiceIsolation')).toBe(true);
    expect(LicenseManager.can('mlModels')).toBe(true);
    expect(LicenseManager.can('cloudSync')).toBe(true);
    expect(LicenseManager.can('whiteLabel')).toBe(true);
    expect(LicenseManager.can('nonExistentFeature')).toBe(true);
  });

  test('canUsePreset() returns true for every preset', () => {
    for (const name of ['Podcast', 'Film', 'Forensic', 'Music', 'Whatever']) {
      expect(LicenseManager.canUsePreset(name)).toBe(true);
    }
  });

  test('shouldWatermark() returns false', () => {
    expect(LicenseManager.shouldWatermark()).toBe(false);
  });
});

// ── Limits ───────────────────────────────────────────────────────────────────
describe('LicenseManager dev-bypass — limits', () => {
  beforeEach(() => { LicenseManager.init(); });

  test('checkFileLimit() allows any size and duration', () => {
    expect(LicenseManager.checkFileLimit(1, 1).allowed).toBe(true);
    expect(LicenseManager.checkFileLimit(10_000, 10_000).allowed).toBe(true);
  });

  test('checkExportLimit() always allows', () => {
    for (let i = 0; i < 1000; i++) LicenseManager.recordExport(0);
    expect(LicenseManager.checkExportLimit().allowed).toBe(true);
  });

  test('recordExport() still increments usage counters', () => {
    LicenseManager.recordExport(5);
    const usage = LicenseManager.getUsage();
    expect(usage.exportsToday).toBeGreaterThanOrEqual(1);
    expect(usage.totalExports).toBeGreaterThanOrEqual(1);
    expect(usage.totalMinutesProcessed).toBeGreaterThanOrEqual(5);
  });

  test('getUsage() reports unlimited caps', () => {
    const u = LicenseManager.getUsage();
    expect(u.exportLimitToday).toBe(-1);
    expect(u.apiLimit).toBe(-1);
  });
});

// ── License info ─────────────────────────────────────────────────────────────
describe('LicenseManager dev-bypass — info', () => {
  beforeEach(() => { LicenseManager.init(); });

  test('getLicenseInfo() reports ENTERPRISE and active', () => {
    const info = LicenseManager.getLicenseInfo();
    expect(info.isActive).toBe(true);
    expect(info.tier).toBe('ENTERPRISE');
    expect(info.source).toBe('dev-override');
  });
});

// ── Tier table ───────────────────────────────────────────────────────────────
describe('LicenseManager.getAllTiers()', () => {
  test('returns definitions for all four tiers', () => {
    const tiers = LicenseManager.getAllTiers();
    expect(tiers).toHaveProperty('FREE');
    expect(tiers).toHaveProperty('PRO');
    expect(tiers).toHaveProperty('STUDIO');
    expect(tiers).toHaveProperty('ENTERPRISE');
  });

  test('every tier has limits and features', () => {
    const tiers = LicenseManager.getAllTiers();
    for (const [, def] of Object.entries(tiers)) {
      expect(def).toHaveProperty('limits');
      expect(def).toHaveProperty('features');
    }
  });

  test('every tier currently exposes unlimited (-1) limits (dev bypass)', () => {
    const tiers = LicenseManager.getAllTiers();
    for (const def of Object.values(tiers)) {
      for (const val of Object.values(def.limits)) {
        expect(val).toBe(-1);
      }
    }
  });
});

// ── Event subscription ───────────────────────────────────────────────────────
describe('LicenseManager.on()', () => {
  beforeEach(() => { LicenseManager.init(); });

  test('returns an unsubscribe function', () => {
    const unsub = LicenseManager.on('license:activated', () => {});
    expect(typeof unsub).toBe('function');
  });

  test('unsubscribe is idempotent', () => {
    const cb = jest.fn();
    const unsub = LicenseManager.on('license:activated', cb);
    unsub();
    unsub();
    LicenseManager.activate(makeToken('PRO'));
    expect(cb).not.toHaveBeenCalled();
  });
});
