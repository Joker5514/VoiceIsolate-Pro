/**
 * VoiceIsolate Pro — LicenseManager Unit Tests
 *
 * Tests tier definitions, feature gating, file/export limits, token
 * validation, and the activate/deactivate lifecycle.
 *
 * The LicenseManager uses localStorage and browser-style btoa/atob.
 * Node.js 18+ provides btoa/atob and globalThis.crypto.getRandomValues
 * natively, so only localStorage needs mocking.
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
  // Provide browser globals used inside the IIFE
  /* eslint-disable no-unused-vars */
  const window   = global.window;
  const localStorage = global.localStorage;
  /* eslint-enable no-unused-vars */
  eval(lmSrc); // eslint-disable-line no-eval
  return module.exports;
})();

// ── Helper: build a valid demo-style token ────────────────────────────────────
// LicenseManager._validateToken only checks structure + expiry + tier existence;
// it does NOT verify the HMAC signature for client-side tokens.
function makeToken(tier, daysValid = 30) {
  const payload = {
    tier: tier.toLowerCase(),
    sub: 'test_user',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + daysValid * 86400,
    source: 'test',
  };
  const header  = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body    = btoa(JSON.stringify(payload));
  const sig     = btoa('test_sig');
  return `${header}.${body}.${sig}`;
}

function makeExpiredToken(tier) {
  const payload = {
    tier: tier.toLowerCase(),
    sub: 'test_user',
    iat: Math.floor(Date.now() / 1000) - 10000,
    exp: Math.floor(Date.now() / 1000) - 1, // already expired
    source: 'test',
  };
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = btoa(JSON.stringify(payload));
  const sig    = btoa('test_sig');
  return `${header}.${body}.${sig}`;
}

// ── Init lifecycle ────────────────────────────────────────────────────────────
describe('LicenseManager.init()', () => {
  beforeEach(() => { LicenseManager.deactivate(); }); // reset singleton state

  test('defaults to FREE tier when no license is stored', () => {
    LicenseManager.init();
    expect(LicenseManager.getTier()).toBe('FREE');
  });

  test('restores a valid stored license on init', () => {
    const token = makeToken('PRO');
    localStorageMock.setItem('vip_license_v22', JSON.stringify({ token, email: 'a@b.com' }));
    LicenseManager.init();
    expect(LicenseManager.getTier()).toBe('PRO');
  });

  test('falls back to FREE if stored token is expired', () => {
    const token = makeExpiredToken('PRO');
    localStorageMock.setItem('vip_license_v22', JSON.stringify({ token, email: 'a@b.com' }));
    LicenseManager.init();
    expect(LicenseManager.getTier()).toBe('FREE');
  });

  test('falls back to FREE if stored JSON is malformed', () => {
    localStorageMock.setItem('vip_license_v22', 'not-json');
    LicenseManager.init();
    expect(LicenseManager.getTier()).toBe('FREE');
  });
});

// ── activate() ───────────────────────────────────────────────────────────────
describe('LicenseManager.activate()', () => {
  beforeEach(() => { LicenseManager.deactivate(); LicenseManager.init(); });

  test('returns success and sets tier for a valid PRO token', () => {
    const result = LicenseManager.activate(makeToken('PRO'));
    expect(result.success).toBe(true);
    expect(result.tier).toBe('PRO');
    expect(LicenseManager.getTier()).toBe('PRO');
  });

  test('returns success and sets tier for a valid STUDIO token', () => {
    const result = LicenseManager.activate(makeToken('STUDIO'));
    expect(result.success).toBe(true);
    expect(result.tier).toBe('STUDIO');
  });

  test('returns success and sets tier for a valid ENTERPRISE token', () => {
    const result = LicenseManager.activate(makeToken('ENTERPRISE'));
    expect(result.success).toBe(true);
    expect(result.tier).toBe('ENTERPRISE');
  });

  test('returns failure for an expired token', () => {
    const result = LicenseManager.activate(makeExpiredToken('PRO'));
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test('returns failure for a malformed token', () => {
    expect(LicenseManager.activate('bad-token').success).toBe(false);
    expect(LicenseManager.activate('').success).toBe(false);
    expect(LicenseManager.activate(null).success).toBe(false);
  });

  test('returns failure for an unknown tier in the token', () => {
    const payload = { tier: 'SUPERDUPER', exp: Math.floor(Date.now() / 1000) + 86400 };
    const token = `${btoa('{}')}.${btoa(JSON.stringify(payload))}.${btoa('sig')}`;
    expect(LicenseManager.activate(token).success).toBe(false);
  });

  test('persists license to localStorage on success', () => {
    LicenseManager.activate(makeToken('PRO'), 'user@example.com');
    const stored = JSON.parse(localStorageMock.getItem('vip_license_v22'));
    expect(stored).not.toBeNull();
    expect(stored.token).toBeTruthy();
  });

  test('fires the license:activated event', () => {
    const cb = jest.fn();
    LicenseManager.on('license:activated', cb);
    LicenseManager.activate(makeToken('PRO'));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// ── deactivate() ─────────────────────────────────────────────────────────────
describe('LicenseManager.deactivate()', () => {
  beforeEach(() => {
    LicenseManager.deactivate();
    LicenseManager.init();
    LicenseManager.activate(makeToken('STUDIO'));
  });

  test('resets tier to FREE', () => {
    LicenseManager.deactivate();
    expect(LicenseManager.getTier()).toBe('FREE');
  });

  test('removes the license from localStorage', () => {
    LicenseManager.deactivate();
    expect(localStorageMock.getItem('vip_license_v22')).toBeNull();
  });

  test('fires the license:deactivated event', () => {
    const cb = jest.fn();
    LicenseManager.on('license:deactivated', cb);
    LicenseManager.deactivate();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

// ── activateTrial() ───────────────────────────────────────────────────────────
describe('LicenseManager.activateTrial()', () => {
  beforeEach(() => { LicenseManager.deactivate(); LicenseManager.init(); });

  test('activates a trial and sets the correct tier', () => {
    const result = LicenseManager.activateTrial('PRO');
    expect(result.success).toBe(true);
    expect(LicenseManager.getTier()).toBe('PRO');
  });

  test('returns failure on a second trial for the same tier', () => {
    LicenseManager.activateTrial('PRO');
    const second = LicenseManager.activateTrial('PRO');
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/already used/i);
  });

  test('returns failure for an unknown tier', () => {
    const result = LicenseManager.activateTrial('DIAMOND');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unknown tier/i);
  });
});

// ── can() — feature gating ───────────────────────────────────────────────────
describe('LicenseManager.can()', () => {
  beforeEach(() => { LicenseManager.deactivate(); LicenseManager.init(); });

  test('FREE tier: basicNoiseReduction is enabled', () => {
    expect(LicenseManager.can('basicNoiseReduction')).toBe(true);
  });

  test('FREE tier: voiceIsolation is disabled', () => {
    expect(LicenseManager.can('voiceIsolation')).toBe(false);
  });

  test('FREE tier: mlModels is disabled', () => {
    expect(LicenseManager.can('mlModels')).toBe(false);
  });

  test('PRO tier: voiceIsolation is enabled', () => {
    LicenseManager.activate(makeToken('PRO'));
    expect(LicenseManager.can('voiceIsolation')).toBe(true);
  });

  test('PRO tier: cloudSync is disabled', () => {
    LicenseManager.activate(makeToken('PRO'));
    expect(LicenseManager.can('cloudSync')).toBe(false);
  });

  test('STUDIO tier: cloudSync is enabled', () => {
    LicenseManager.activate(makeToken('STUDIO'));
    expect(LicenseManager.can('cloudSync')).toBe(true);
  });

  test('ENTERPRISE tier: whiteLabel is enabled', () => {
    LicenseManager.activate(makeToken('ENTERPRISE'));
    expect(LicenseManager.can('whiteLabel')).toBe(true);
  });

  test('returns false for a non-existent feature key', () => {
    expect(LicenseManager.can('nonExistentFeature')).toBe(false);
  });
});

// ── canUsePreset() ────────────────────────────────────────────────────────────
describe('LicenseManager.canUsePreset()', () => {
  beforeEach(() => { LicenseManager.deactivate(); LicenseManager.init(); });

  test('FREE tier allows Podcast preset', () => {
    expect(LicenseManager.canUsePreset('Podcast')).toBe(true);
  });

  test('FREE tier disallows Film preset', () => {
    expect(LicenseManager.canUsePreset('Film')).toBe(false);
  });

  test('PRO tier allows all presets', () => {
    LicenseManager.activate(makeToken('PRO'));
    expect(LicenseManager.canUsePreset('Film')).toBe(true);
    expect(LicenseManager.canUsePreset('Forensic')).toBe(true);
    expect(LicenseManager.canUsePreset('Music')).toBe(true);
  });
});

// ── shouldWatermark() ─────────────────────────────────────────────────────────
describe('LicenseManager.shouldWatermark()', () => {
  beforeEach(() => { LicenseManager.deactivate(); LicenseManager.init(); });

  test('FREE tier applies watermark', () => {
    expect(LicenseManager.shouldWatermark()).toBe(true);
  });

  test('PRO tier does not apply watermark', () => {
    LicenseManager.activate(makeToken('PRO'));
    expect(LicenseManager.shouldWatermark()).toBe(false);
  });

  test('STUDIO tier does not apply watermark', () => {
    LicenseManager.activate(makeToken('STUDIO'));
    expect(LicenseManager.shouldWatermark()).toBe(false);
  });
});

// ── checkFileLimit() ──────────────────────────────────────────────────────────
describe('LicenseManager.checkFileLimit()', () => {
  beforeEach(() => { LicenseManager.deactivate(); LicenseManager.init(); });

  test('FREE: allows a 30 MB / 4 min file', () => {
    const r = LicenseManager.checkFileLimit(30, 4);
    expect(r.allowed).toBe(true);
  });

  test('FREE: rejects a file over 50 MB', () => {
    const r = LicenseManager.checkFileLimit(60, 1);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/file size/i);
  });

  test('FREE: rejects a file over 5 minutes', () => {
    const r = LicenseManager.checkFileLimit(10, 6);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/duration/i);
  });

  test('PRO: allows a 400 MB / 60 min file', () => {
    LicenseManager.activate(makeToken('PRO'));
    expect(LicenseManager.checkFileLimit(400, 60).allowed).toBe(true);
  });

  test('STUDIO: unlimited duration is allowed', () => {
    LicenseManager.activate(makeToken('STUDIO'));
    expect(LicenseManager.checkFileLimit(100, 999).allowed).toBe(true);
  });

  test('rejection includes the upgrade tier', () => {
    const r = LicenseManager.checkFileLimit(60, 1);
    expect(r.upgrade).toBe('PRO');
  });
});

// ── checkExportLimit() + recordExport() ───────────────────────────────────────
describe('LicenseManager.checkExportLimit() + recordExport()', () => {
  beforeEach(() => {
    LicenseManager.deactivate();
    LicenseManager.init();
    // Ensure usage counters exist
    LicenseManager._usageCounters = {
      date: new Date().toDateString(),
      exportsToday: 0,
      totalExports: 0,
      totalMinutesProcessed: 0,
      apiCallsThisMonth: 0,
      monthKey: new Date().toISOString().slice(0, 7),
    };
  });

  test('FREE: first export is allowed', () => {
    expect(LicenseManager.checkExportLimit().allowed).toBe(true);
  });

  test('FREE: export is denied once the daily limit (3) is reached', () => {
    LicenseManager.recordExport(1);
    LicenseManager.recordExport(1);
    LicenseManager.recordExport(1);
    expect(LicenseManager.checkExportLimit().allowed).toBe(false);
  });

  test('recordExport increments exportsToday and totalExports', () => {
    LicenseManager.recordExport(5);
    const usage = LicenseManager.getUsage();
    expect(usage.exportsToday).toBe(1);
    expect(usage.totalExports).toBe(1);
    expect(usage.totalMinutesProcessed).toBe(5);
  });

  test('STUDIO: export limit is unlimited (-1)', () => {
    LicenseManager.activate(makeToken('STUDIO'));
    for (let i = 0; i < 200; i++) LicenseManager.recordExport(0);
    expect(LicenseManager.checkExportLimit().allowed).toBe(true);
  });
});

// ── getLicenseInfo() ──────────────────────────────────────────────────────────
describe('LicenseManager.getLicenseInfo()', () => {
  beforeEach(() => { LicenseManager.deactivate(); LicenseManager.init(); });

  test('FREE: isActive is false', () => {
    const info = LicenseManager.getLicenseInfo();
    expect(info.isActive).toBe(false);
    expect(info.tier).toBe('FREE');
  });

  test('PRO: isActive is true and expiresAt is set', () => {
    LicenseManager.activate(makeToken('PRO'), 'pro@user.com');
    const info = LicenseManager.getLicenseInfo();
    expect(info.isActive).toBe(true);
    expect(info.tier).toBe('PRO');
    expect(info.email).toBe('pro@user.com');
    expect(info.expiresAt).toBeGreaterThan(Date.now());
  });
});

// ── getAllTiers() ─────────────────────────────────────────────────────────────
describe('LicenseManager.getAllTiers()', () => {
  test('returns definitions for all four tiers', () => {
    const tiers = LicenseManager.getAllTiers();
    expect(tiers).toHaveProperty('FREE');
    expect(tiers).toHaveProperty('PRO');
    expect(tiers).toHaveProperty('STUDIO');
    expect(tiers).toHaveProperty('ENTERPRISE');
  });

  test('each tier has limits and features', () => {
    const tiers = LicenseManager.getAllTiers();
    for (const [, def] of Object.entries(tiers)) {
      expect(def).toHaveProperty('limits');
      expect(def).toHaveProperty('features');
    }
  });

  test('ENTERPRISE has unlimited (−1) for all limits', () => {
    const { limits } = LicenseManager.getAllTiers().ENTERPRISE;
    for (const val of Object.values(limits)) {
      expect(val).toBe(-1);
    }
  });
});

// ── on() — event subscription ─────────────────────────────────────────────────
describe('LicenseManager.on()', () => {
  beforeEach(() => { LicenseManager.deactivate(); LicenseManager.init(); });

  test('on() returns an unsubscribe function', () => {
    const unsub = LicenseManager.on('license:activated', () => {});
    expect(typeof unsub).toBe('function');
  });

  test('unsubscribe prevents further callbacks', () => {
    const cb = jest.fn();
    const unsub = LicenseManager.on('license:activated', cb);
    unsub();
    LicenseManager.activate(makeToken('PRO'));
    expect(cb).not.toHaveBeenCalled();
  });

  test('wildcard "*" catches any event', () => {
    const cb = jest.fn();
    LicenseManager.on('*', cb);
    LicenseManager.activate(makeToken('PRO'));
    LicenseManager.deactivate();
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
