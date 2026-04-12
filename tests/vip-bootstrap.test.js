/**
 * VoiceIsolate Pro — Bootstrap / Boot Shim Unit Tests
 *
 * Covers the three bootstrap code paths introduced in this PR:
 *
 *  1. _vipBootstrap IIFE (end of public/app/app.js)
 *     — Fallback bootstrapper that runs when vip-boot.js is absent.
 *
 *  2. _vipSafetyNet IIFE (inline <script> in public/app/index.html)
 *     — Last-resort safety net that fires after all scripts have parsed.
 *
 *  3. aliasOrCreate() + _callAuthInit() (public/app/vip-boot.js)
 *     — Primary boot shim: three branches (already-set, alias-vip, fresh
 *       instantiation) plus the new _callAuthInit helper.
 *
 * All three files target the browser, so they are tested by eval()-ing the
 * relevant code inside a scope that supplies all required browser globals as
 * Jest mocks.  This mirrors the pattern used in pipeline-orchestrator.test.js.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Build a minimal VoiceIsolatePro mock constructor. */
function makeMockVIP(initThrows = false) {
  function VoiceIsolatePro() {
    this._initCalled = false;
    this.init = jest.fn(() => {
      if (initThrows) throw new Error('init failed');
    });
  }
  return VoiceIsolatePro;
}

/** Build a minimal Auth mock. */
function makeMockAuth(resolves = true, isLoggedIn = false, currentUser = null) {
  return {
    isLoggedIn,
    currentUser,
    init: jest.fn(() => resolves
      ? Promise.resolve()
      : Promise.reject(new Error('auth error'))),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extract source slices
// ─────────────────────────────────────────────────────────────────────────────

const appJsSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/app.js'), 'utf8',
);

const vipBootSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/vip-boot.js'), 'utf8',
);

const indexHtmlSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/index.html'), 'utf8',
);

/**
 * Extract and return just the _vipBootstrap IIFE from app.js.
 * The IIFE starts at "(function _vipBootstrap()" and runs to the final "})();".
 */
function extractVipBootstrapIIFE() {
  const start = appJsSrc.indexOf('(function _vipBootstrap()');
  if (start === -1) throw new Error('_vipBootstrap IIFE not found in app.js');
  // The IIFE ends at the last })(); in the file
  const chunk = appJsSrc.slice(start);
  // Find closing })(); — the entire file ends with this
  const end = chunk.lastIndexOf('})();');
  if (end === -1) throw new Error('Could not find end of _vipBootstrap IIFE');
  return chunk.slice(0, end + '})();'.length);
}

/**
 * Extract and return just the _vipSafetyNet IIFE from index.html's inline script.
 */
function extractSafetyNetIIFE() {
  const start = indexHtmlSrc.indexOf('(function _vipSafetyNet()');
  if (start === -1) throw new Error('_vipSafetyNet IIFE not found in index.html');
  const chunk = indexHtmlSrc.slice(start);
  const end = chunk.indexOf('})();');
  if (end === -1) throw new Error('Could not find end of _vipSafetyNet IIFE');
  return chunk.slice(0, end + '})();'.length);
}

const BOOTSTRAP_IIFE   = extractVipBootstrapIIFE();
const SAFETY_NET_IIFE  = extractSafetyNetIIFE();

// ─────────────────────────────────────────────────────────────────────────────
// Helper: run a code snippet inside a scope with controlled browser-like globals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Execute `codeStr` inside a fresh function scope that has the supplied
 * `globals` injected as local variables (via `with`).  Returns the globals
 * object after execution so tests can inspect side effects.
 *
 * Auth is optional — when not supplied the variable is simply absent from the
 * scope, which is how the browser behaves before auth.js loads.
 */
function runInScope(codeStr, globals) {
  // Build a wrapper that exposes each global as a local name.
  // `with` is used so that bare identifiers such as `window`, `document`,
  // `VoiceIsolatePro`, and `Auth` resolve correctly without needing `global.X`.
  // eslint-disable-next-line no-new-func
  const wrapper = new Function('__g__', `with (__g__) { ${codeStr} }`);
  wrapper(globals);
  return globals;
}

/**
 * Build a document mock.
 *
 * @param {'loading'|'complete'|'interactive'} readyState
 * @param {boolean} captureListeners - if true, store DOMContentLoaded callbacks
 */
function makeDocument(readyState = 'complete', captureListeners = false) {
  const _listeners = {};
  const doc = {
    readyState,
    addEventListener: jest.fn((event, cb, opts) => {
      if (captureListeners) {
        _listeners[event] = _listeners[event] || [];
        _listeners[event].push(cb);
      }
    }),
    removeEventListener: jest.fn(),
    getElementById: jest.fn(() => null),
    _listeners,
    /** Fire a captured event (used in tests that need to trigger DOMContentLoaded). */
    _fire(event) {
      (_listeners[event] || []).forEach(cb => cb());
    },
  };
  return doc;
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. _vipBootstrap IIFE (app.js)
// ═════════════════════════════════════════════════════════════════════════════

describe('_vipBootstrap (app.js) — DOM already ready', () => {
  let MockVIP;

  beforeEach(() => {
    MockVIP = makeMockVIP();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('skips instantiation when window._vipApp is already set', () => {
    const existingApp = { _initCalled: true };
    const scope = runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: existingApp, vip: existingApp },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
    });
    // _vipApp must still be the original object — no new instance created
    expect(scope.window._vipApp).toBe(existingApp);
    // Constructor never called
    expect(scope.window._vipApp).not.toBeInstanceOf(MockVIP);
  });

  test('creates a VoiceIsolatePro instance when window._vipApp is null', () => {
    const scope = runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp).toBeInstanceOf(MockVIP);
  });

  test('sets window.vip to the same instance as window._vipApp', () => {
    const scope = runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window.vip).toBe(scope.window._vipApp);
  });

  test('marks app._initCalled = true on the created instance', () => {
    const scope = runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp._initCalled).toBe(true);
  });

  test('calls Auth.init() when Auth is defined', async () => {
    const Auth = makeMockAuth(true);
    runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
      Auth,
    });
    // Auth.init is called synchronously then returns a promise; flush microtasks
    await Promise.resolve();
    expect(Auth.init).toHaveBeenCalledTimes(1);
  });

  test('does not throw when Auth.init() rejects', async () => {
    const Auth = makeMockAuth(false); // rejects
    await expect(async () => {
      runInScope(BOOTSTRAP_IIFE, {
        window: { _vipApp: null, vip: null },
        document: makeDocument('complete'),
        VoiceIsolatePro: MockVIP,
        Auth,
      });
      await Promise.resolve();
    }).not.toThrow();
  });

  test('does not call Auth.init() when Auth is absent from scope', () => {
    // Auth deliberately omitted from globals
    expect(() => {
      runInScope(BOOTSTRAP_IIFE, {
        window: { _vipApp: null, vip: null },
        document: makeDocument('complete'),
        VoiceIsolatePro: MockVIP,
        // no Auth property
      });
    }).not.toThrow();
  });

  test('logs info message on successful bootstrap', () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
      console,
    });
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('[app] VoiceIsolatePro ready via app.js bootstrap'),
    );
  });

  test('logs error and does not set globals when constructor throws', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    function BrokenVIP() { throw new Error('constructor failed'); }
    const scope = runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: BrokenVIP,
      console,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[app] Bootstrap failed:'),
      expect.any(Error),
    );
    expect(scope.window._vipApp).toBeNull();
    expect(scope.window.vip).toBeNull();
  });

  test('does not mutate window when _vipApp is already truthy', () => {
    const sentinel = { marker: 'original' };
    const scope = runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: sentinel, vip: sentinel },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp.marker).toBe('original');
  });
});

describe('_vipBootstrap (app.js) — DOM still loading', () => {
  let MockVIP;

  beforeEach(() => {
    MockVIP = makeMockVIP();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('registers a DOMContentLoaded listener when readyState is "loading"', () => {
    const doc = makeDocument('loading', true);
    runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: null, vip: null },
      document: doc,
      VoiceIsolatePro: MockVIP,
    });
    expect(doc.addEventListener).toHaveBeenCalledWith(
      'DOMContentLoaded',
      expect.any(Function),
      expect.objectContaining({ once: true }),
    );
  });

  test('does NOT call _setup immediately when readyState is "loading"', () => {
    const doc = makeDocument('loading', true);
    const scope = runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: null, vip: null },
      document: doc,
      VoiceIsolatePro: MockVIP,
    });
    // _setup not yet fired — _vipApp still null
    expect(scope.window._vipApp).toBeNull();
  });

  test('creates app after DOMContentLoaded fires', () => {
    const doc = makeDocument('loading', true);
    const scope = runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: null, vip: null },
      document: doc,
      VoiceIsolatePro: MockVIP,
      console,
    });
    // App not yet created
    expect(scope.window._vipApp).toBeNull();
    // Simulate browser firing DOMContentLoaded
    doc._fire('DOMContentLoaded');
    expect(scope.window._vipApp).toBeInstanceOf(MockVIP);
    expect(scope.window.vip).toBe(scope.window._vipApp);
  });

  test('DOMContentLoaded listener is registered with { once: true }', () => {
    const doc = makeDocument('loading', true);
    runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: null, vip: null },
      document: doc,
      VoiceIsolatePro: MockVIP,
    });
    const call = doc.addEventListener.mock.calls.find(([e]) => e === 'DOMContentLoaded');
    expect(call).toBeDefined();
    expect(call[2]).toEqual({ once: true });
  });

  test('calls _setup immediately when readyState is "interactive"', () => {
    const scope = runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('interactive'),
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp).toBeInstanceOf(MockVIP);
  });

  test('calls _setup immediately when readyState is "complete"', () => {
    const scope = runInScope(BOOTSTRAP_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp).toBeInstanceOf(MockVIP);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. _vipSafetyNet IIFE (index.html inline script)
// ═════════════════════════════════════════════════════════════════════════════

describe('_vipSafetyNet (index.html) — DOM already ready', () => {
  let MockVIP;

  beforeEach(() => {
    MockVIP = makeMockVIP();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('instantiates VoiceIsolatePro when _vipApp is null', () => {
    const scope = runInScope(SAFETY_NET_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp).toBeInstanceOf(MockVIP);
  });

  test('calls app.init() on the newly created instance', () => {
    const scope = runInScope(SAFETY_NET_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp.init).toHaveBeenCalledTimes(1);
  });

  test('sets window.vip and window._vipApp to the same instance', () => {
    const scope = runInScope(SAFETY_NET_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window.vip).toBe(scope.window._vipApp);
  });

  test('sets app._initCalled = true on the created instance', () => {
    const scope = runInScope(SAFETY_NET_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp._initCalled).toBe(true);
  });

  test('skips instantiation when _vipApp is already set', () => {
    const existing = { _initCalled: true, init: jest.fn() };
    const scope = runInScope(SAFETY_NET_IIFE, {
      window: { _vipApp: existing, vip: existing },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp).toBe(existing);
    expect(existing.init).not.toHaveBeenCalled();
  });

  test('does not instantiate when VoiceIsolatePro is not defined', () => {
    const scope = runInScope(SAFETY_NET_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      // VoiceIsolatePro intentionally absent
    });
    expect(scope.window._vipApp).toBeNull();
  });

  test('calls Auth.init() when Auth defined, not logged in, currentUser null', async () => {
    const Auth = makeMockAuth(true, false, null);
    runInScope(SAFETY_NET_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
      Auth,
    });
    await Promise.resolve();
    expect(Auth.init).toHaveBeenCalledTimes(1);
  });

  test('does not call Auth.init() when isLoggedIn is true', async () => {
    const Auth = makeMockAuth(true, true, { id: 'u1' });
    runInScope(SAFETY_NET_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
      Auth,
    });
    await Promise.resolve();
    expect(Auth.init).not.toHaveBeenCalled();
  });

  test('does not call Auth.init() when currentUser is not null', async () => {
    const Auth = makeMockAuth(true, false, { id: 'u2' });
    runInScope(SAFETY_NET_IIFE, {
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
      Auth,
    });
    await Promise.resolve();
    expect(Auth.init).not.toHaveBeenCalled();
  });

  test('does not throw when instantiation throws', () => {
    function BadVIP() { throw new Error('broken'); }
    expect(() => {
      runInScope(SAFETY_NET_IIFE, {
        window: { _vipApp: null, vip: null },
        document: makeDocument('complete'),
        VoiceIsolatePro: BadVIP,
        console,
      });
    }).not.toThrow();
  });

  test('does not throw when Auth.init() rejects', async () => {
    const Auth = makeMockAuth(false, false, null); // rejects
    await expect(async () => {
      runInScope(SAFETY_NET_IIFE, {
        window: { _vipApp: null, vip: null },
        document: makeDocument('complete'),
        VoiceIsolatePro: MockVIP,
        Auth,
      });
      await Promise.resolve();
    }).not.toThrow();
  });
});

describe('_vipSafetyNet (index.html) — DOM still loading', () => {
  let MockVIP;

  beforeEach(() => {
    MockVIP = makeMockVIP();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('registers DOMContentLoaded listener when readyState is "loading"', () => {
    const doc = makeDocument('loading', true);
    runInScope(SAFETY_NET_IIFE, {
      window: { _vipApp: null, vip: null },
      document: doc,
      VoiceIsolatePro: MockVIP,
    });
    expect(doc.addEventListener).toHaveBeenCalledWith(
      'DOMContentLoaded',
      expect.any(Function),
      expect.objectContaining({ once: true }),
    );
  });

  test('does not instantiate app before DOMContentLoaded fires', () => {
    const doc = makeDocument('loading', true);
    const scope = runInScope(SAFETY_NET_IIFE, {
      window: { _vipApp: null, vip: null },
      document: doc,
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp).toBeNull();
  });

  test('instantiates app after DOMContentLoaded fires', () => {
    const doc = makeDocument('loading', true);
    const scope = runInScope(SAFETY_NET_IIFE, {
      window: { _vipApp: null, vip: null },
      document: doc,
      VoiceIsolatePro: MockVIP,
      console,
    });
    doc._fire('DOMContentLoaded');
    expect(scope.window._vipApp).toBeInstanceOf(MockVIP);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. vip-boot.js — aliasOrCreate() + _callAuthInit()
//
// We eval the whole vip-boot.js with a controlled scope so we can test the
// internal aliasOrCreate() function by observing its side effects on window.
// Because the IIFE runs immediately, we test each scenario by setting up the
// window state BEFORE eval and checking the window state AFTER.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Execute vip-boot.js with the given scope overrides.
 *
 * Provides sensible defaults for document, location, and fetch so that
 * runDiagnostics() does not interfere with the aliasOrCreate() tests.
 * All async diagnostics are intentionally allowed to run but we only await
 * them when the test needs to inspect their side-effects.
 */
function runVipBoot(overrides = {}) {
  const defaults = {
    document: makeDocument('complete'),
    location: { protocol: 'https:', origin: 'http://localhost' },
    fetch: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
    console,
  };
  const scope = { ...defaults, ...overrides };
  runInScope(vipBootSrc, scope);
  return scope;
}

describe('vip-boot.js — aliasOrCreate(): VoiceIsolatePro absent', () => {
  beforeEach(() => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  test('logs an error when VoiceIsolatePro is not defined', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    runVipBoot({
      window: { _vipApp: null, vip: null },
      // VoiceIsolatePro intentionally absent
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[vip-boot] VoiceIsolatePro class not found'),
    );
  });

  test('does not set window._vipApp when VoiceIsolatePro is absent', () => {
    const scope = runVipBoot({
      window: { _vipApp: null, vip: null },
    });
    expect(scope.window._vipApp).toBeNull();
  });
});

describe('vip-boot.js — aliasOrCreate(): window._vipApp already set', () => {
  let MockVIP;

  beforeEach(() => {
    MockVIP = makeMockVIP();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  test('aliases window.vip to _vipApp when vip is not yet set', () => {
    const existingApp = new MockVIP();
    const scope = runVipBoot({
      window: { _vipApp: existingApp, vip: null },
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window.vip).toBe(existingApp);
  });

  test('does not replace window.vip when it is already set', () => {
    const existingApp = new MockVIP();
    const scope = runVipBoot({
      window: { _vipApp: existingApp, vip: existingApp },
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window.vip).toBe(existingApp);
  });

  test('calls _callAuthInit (Auth.init) when _vipApp is already set', async () => {
    const Auth = makeMockAuth(true);
    const existingApp = new MockVIP();
    runVipBoot({
      window: { _vipApp: existingApp, vip: existingApp },
      VoiceIsolatePro: MockVIP,
      Auth,
    });
    await Promise.resolve();
    expect(Auth.init).toHaveBeenCalledTimes(1);
  });

  test('does not create a new VoiceIsolatePro instance when _vipApp is already set', () => {
    const constructorSpy = jest.fn();
    function SpyVIP() { constructorSpy(); this._initCalled = false; this.init = jest.fn(); }
    const existingApp = { _initCalled: true, init: jest.fn() };
    runVipBoot({
      window: { _vipApp: existingApp, vip: existingApp },
      VoiceIsolatePro: SpyVIP,
    });
    expect(constructorSpy).not.toHaveBeenCalled();
  });
});

describe('vip-boot.js — aliasOrCreate(): window.vip is a VoiceIsolatePro instance', () => {
  let MockVIP;

  beforeEach(() => {
    MockVIP = makeMockVIP();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  test('sets _vipApp to window.vip when vip is already a VIP instance', () => {
    const vipInstance = new MockVIP();
    const scope = runVipBoot({
      window: { _vipApp: null, vip: vipInstance },
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp).toBe(vipInstance);
  });

  test('calls app.init() when _initCalled is false', () => {
    const vipInstance = new MockVIP();
    vipInstance._initCalled = false;
    runVipBoot({
      window: { _vipApp: null, vip: vipInstance },
      VoiceIsolatePro: MockVIP,
    });
    expect(vipInstance.init).toHaveBeenCalledTimes(1);
  });

  test('does not call app.init() again when _initCalled is already true', () => {
    const vipInstance = new MockVIP();
    vipInstance._initCalled = true;
    runVipBoot({
      window: { _vipApp: null, vip: vipInstance },
      VoiceIsolatePro: MockVIP,
    });
    expect(vipInstance.init).not.toHaveBeenCalled();
  });

  test('sets _initCalled = true on the instance after calling init()', () => {
    const vipInstance = new MockVIP();
    vipInstance._initCalled = false;
    runVipBoot({
      window: { _vipApp: null, vip: vipInstance },
      VoiceIsolatePro: MockVIP,
    });
    expect(vipInstance._initCalled).toBe(true);
  });

  test('does not throw when app.init() throws during alias path', () => {
    const vipInstance = new MockVIP();
    vipInstance._initCalled = false;
    vipInstance.init = jest.fn(() => { throw new Error('init boom'); });
    expect(() => {
      runVipBoot({
        window: { _vipApp: null, vip: vipInstance },
        VoiceIsolatePro: MockVIP,
        console,
      });
    }).not.toThrow();
  });

  test('calls _callAuthInit after aliasing vip → _vipApp', async () => {
    const Auth = makeMockAuth(true);
    const vipInstance = new MockVIP();
    runVipBoot({
      window: { _vipApp: null, vip: vipInstance },
      VoiceIsolatePro: MockVIP,
      Auth,
    });
    await Promise.resolve();
    expect(Auth.init).toHaveBeenCalledTimes(1);
  });
});

describe('vip-boot.js — aliasOrCreate(): fresh instantiation', () => {
  let MockVIP;

  beforeEach(() => {
    MockVIP = makeMockVIP();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  test('creates a new VoiceIsolatePro and assigns it to window._vipApp', () => {
    const scope = runVipBoot({
      window: { _vipApp: null, vip: null },
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp).toBeInstanceOf(MockVIP);
  });

  test('assigns the same instance to both window.vip and window._vipApp', () => {
    const scope = runVipBoot({
      window: { _vipApp: null, vip: null },
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window.vip).toBe(scope.window._vipApp);
  });

  test('sets _initCalled = true before calling app.init()', () => {
    // Verify _initCalled is set synchronously (init() reads it in the impl)
    let initCalledAtCallTime = undefined;
    function TrackVIP() {
      this._initCalled = false;
      this.init = jest.fn(() => { initCalledAtCallTime = this._initCalled; });
    }
    runVipBoot({
      window: { _vipApp: null, vip: null },
      VoiceIsolatePro: TrackVIP,
    });
    expect(initCalledAtCallTime).toBe(true);
  });

  test('calls app.init() on the new instance', () => {
    const scope = runVipBoot({
      window: { _vipApp: null, vip: null },
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp.init).toHaveBeenCalledTimes(1);
  });

  test('does not throw when app.init() throws during fresh instantiation', () => {
    const BrokenInitVIP = makeMockVIP(true); // init throws
    expect(() => {
      runVipBoot({
        window: { _vipApp: null, vip: null },
        VoiceIsolatePro: BrokenInitVIP,
        console,
      });
    }).not.toThrow();
  });

  test('logs an error and does not set globals when constructor throws', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    function CrashVIP() { throw new Error('ctor crash'); }
    const scope = runVipBoot({
      window: { _vipApp: null, vip: null },
      VoiceIsolatePro: CrashVIP,
      console,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[vip-boot] Failed to instantiate VoiceIsolatePro:'),
      expect.any(Error),
    );
    expect(scope.window._vipApp).toBeNull();
    expect(scope.window.vip).toBeNull();
  });

  test('calls _callAuthInit after fresh instantiation', async () => {
    const Auth = makeMockAuth(true);
    runVipBoot({
      window: { _vipApp: null, vip: null },
      VoiceIsolatePro: MockVIP,
      Auth,
    });
    await Promise.resolve();
    expect(Auth.init).toHaveBeenCalledTimes(1);
  });

  test('calls _callAuthInit even when constructor throws', async () => {
    const Auth = makeMockAuth(true);
    function CrashVIP() { throw new Error('ctor crash'); }
    runVipBoot({
      window: { _vipApp: null, vip: null },
      VoiceIsolatePro: CrashVIP,
      Auth,
      console,
    });
    await Promise.resolve();
    // _callAuthInit is called unconditionally after the try/catch
    expect(Auth.init).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. _callAuthInit (vip-boot.js)
// ═════════════════════════════════════════════════════════════════════════════

describe('vip-boot.js — _callAuthInit()', () => {
  let MockVIP;

  beforeEach(() => {
    MockVIP = makeMockVIP();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  test('calls Auth.init() when Auth is defined with an init function', async () => {
    const Auth = makeMockAuth(true);
    runVipBoot({
      window: { _vipApp: null, vip: null },
      VoiceIsolatePro: MockVIP,
      Auth,
    });
    await Promise.resolve();
    expect(Auth.init).toHaveBeenCalledTimes(1);
  });

  test('catches rejection from Auth.init() without throwing', async () => {
    const Auth = makeMockAuth(false); // rejects
    await expect(async () => {
      runVipBoot({
        window: { _vipApp: null, vip: null },
        VoiceIsolatePro: MockVIP,
        Auth,
        console,
      });
      await Promise.resolve();
    }).not.toThrow();
  });

  test('logs a warning when Auth is not defined', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    runVipBoot({
      window: { _vipApp: null, vip: null },
      VoiceIsolatePro: MockVIP,
      // Auth absent
      console,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[vip-boot] Auth module not loaded'),
    );
  });

  test('logs a warning when Auth is defined but has no init function', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    runVipBoot({
      window: { _vipApp: null, vip: null },
      VoiceIsolatePro: MockVIP,
      Auth: { isLoggedIn: false, currentUser: null }, // no init()
      console,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[vip-boot] Auth module not loaded'),
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. vip-boot.js — DOMContentLoaded gate
// ═════════════════════════════════════════════════════════════════════════════

describe('vip-boot.js — DOMContentLoaded gate', () => {
  let MockVIP;

  beforeEach(() => {
    MockVIP = makeMockVIP();
    jest.spyOn(console, 'info').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { jest.restoreAllMocks(); });

  test('registers DOMContentLoaded listener when readyState is "loading"', () => {
    const doc = makeDocument('loading', true);
    runVipBoot({
      window: { _vipApp: null, vip: null },
      document: doc,
      VoiceIsolatePro: MockVIP,
    });
    expect(doc.addEventListener).toHaveBeenCalledWith(
      'DOMContentLoaded',
      expect.any(Function),
      expect.objectContaining({ once: true }),
    );
  });

  test('does not instantiate app before DOMContentLoaded fires', () => {
    const doc = makeDocument('loading', true);
    const scope = runVipBoot({
      window: { _vipApp: null, vip: null },
      document: doc,
      VoiceIsolatePro: MockVIP,
    });
    expect(scope.window._vipApp).toBeNull();
  });

  test('instantiates app after DOMContentLoaded fires', () => {
    const doc = makeDocument('loading', true);
    const scope = runVipBoot({
      window: { _vipApp: null, vip: null },
      document: doc,
      VoiceIsolatePro: MockVIP,
      location: { protocol: 'https:', origin: 'http://localhost' },
      fetch: jest.fn().mockResolvedValue({ ok: true }),
      console,
    });
    expect(scope.window._vipApp).toBeNull();
    doc._fire('DOMContentLoaded');
    expect(scope.window._vipApp).toBeInstanceOf(MockVIP);
  });

  test('boots immediately when readyState is "complete"', () => {
    const scope = runVipBoot({
      window: { _vipApp: null, vip: null },
      document: makeDocument('complete'),
      VoiceIsolatePro: MockVIP,
      location: { protocol: 'https:', origin: 'http://localhost' },
      fetch: jest.fn().mockResolvedValue({ ok: true }),
    });
    expect(scope.window._vipApp).toBeInstanceOf(MockVIP);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. index.html structure tests for the new safety-net <script> block
// ═════════════════════════════════════════════════════════════════════════════

describe('index.html — safety-net script block structure', () => {
  test('safety-net script block is present in index.html', () => {
    expect(indexHtmlSrc).toContain('_vipSafetyNet');
  });

  test('safety-net script appears after vip-boot.js <script> tag', () => {
    const vipBootPos    = indexHtmlSrc.indexOf('vip-boot.js');
    const safetyNetPos  = indexHtmlSrc.indexOf('_vipSafetyNet');
    expect(vipBootPos).toBeGreaterThan(-1);
    expect(safetyNetPos).toBeGreaterThan(vipBootPos);
  });

  test('safety-net script appears after app.js <script> tag', () => {
    const appJsPos      = indexHtmlSrc.indexOf('"./app.js"');
    const safetyNetPos  = indexHtmlSrc.indexOf('_vipSafetyNet');
    expect(appJsPos).toBeGreaterThan(-1);
    expect(safetyNetPos).toBeGreaterThan(appJsPos);
  });

  test('safety-net checks for window._vipApp before instantiating', () => {
    expect(indexHtmlSrc).toContain('window._vipApp');
  });

  test('safety-net guards Auth.init() with isLoggedIn and currentUser checks', () => {
    expect(indexHtmlSrc).toContain('Auth.isLoggedIn');
    expect(indexHtmlSrc).toContain('Auth.currentUser');
  });

  test('safety-net uses { once: true } for its DOMContentLoaded listener', () => {
    // Ensure the once flag is present in the safety-net block specifically
    const safetyNetStart = indexHtmlSrc.indexOf('_vipSafetyNet');
    const safetyNetEnd   = indexHtmlSrc.indexOf('</script>', safetyNetStart);
    const safetyNetBlock = indexHtmlSrc.slice(safetyNetStart, safetyNetEnd);
    expect(safetyNetBlock).toContain('{ once: true }');
  });

  test('safety-net wraps instantiation in a try/catch', () => {
    const safetyNetStart = indexHtmlSrc.indexOf('_vipSafetyNet');
    const safetyNetEnd   = indexHtmlSrc.indexOf('</script>', safetyNetStart);
    const safetyNetBlock = indexHtmlSrc.slice(safetyNetStart, safetyNetEnd);
    expect(safetyNetBlock).toContain('catch');
  });

  test('safety-net calls app.init() after instantiation', () => {
    const safetyNetStart = indexHtmlSrc.indexOf('_vipSafetyNet');
    const safetyNetEnd   = indexHtmlSrc.indexOf('</script>', safetyNetStart);
    const safetyNetBlock = indexHtmlSrc.slice(safetyNetStart, safetyNetEnd);
    expect(safetyNetBlock).toContain('app.init()');
  });
});