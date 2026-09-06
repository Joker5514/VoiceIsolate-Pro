'use strict';

/**
 * Tests for the changed sections of vip-boot.js:
 *
 *  1. _callAuthInit() — new helper that conditionally calls Auth.init().
 *  2. aliasOrCreate() — updated to call _callAuthInit() in every branch and
 *     to invoke app.init() when aliasing window.vip → window._vipApp.
 *  3. Boot sequence — invokes both runDiagnostics() (async) and aliasOrCreate().
 *
 * We load the script by injecting it into a Function with mocked browser
 * globals, matching the pattern used in pipeline-orchestrator.test.js.
 */

const fs   = require('fs');
const path = require('path');

const vipBootSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/vip-boot.js'),
  'utf8'
);

const bootWindows = new Set();

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  try {
    for (const win of bootWindows) win._vipPillDriverCleanup?.();
    // Execute the finite diagnostics grace period, then prove cleanup left no
    // recurring work. Do not clear all timers or force the Jest process to exit.
    jest.runOnlyPendingTimers();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    bootWindows.clear();
    jest.useRealTimers();
  }
});

// ── Mock factories ────────────────────────────────────────────────────────────

function makeDocument(readyState = 'complete') {
  const listeners = {};
  return {
    readyState,
    getElementById: jest.fn().mockReturnValue(null),
    addEventListener: jest.fn((event, cb) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    removeEventListener: jest.fn(),
    _triggerEvent(event) {
      (listeners[event] || []).forEach(cb => cb());
    },
  };
}

function makeLocation(protocol = 'http:') {
  return { protocol, origin: 'http://localhost' };
}

function makeConsole() {
  return {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    log:   jest.fn(),
  };
}

function makeAuth(overrides = {}) {
  return Object.assign(
    {
      init: jest.fn().mockResolvedValue(undefined),
      isLoggedIn: false,
      currentUser: null,
    },
    overrides
  );
}

/**
 * Run vip-boot.js in a controlled environment.
 *
 * @param {object} opts
 * @param {string}   opts.readyState
 * @param {object}   opts.windowExtras      Extra properties to add to the fake window
 * @param {Function} opts.VoiceIsolatePro   Constructor (or undefined to simulate missing)
 * @param {object}   opts.Auth              Auth mock (or undefined)
 * @param {string}   opts.protocol          location.protocol
 * @param {object}   opts.fetchMock         Mock for the global fetch
 * @returns {{ win, doc, con }}
 */
function runVipBoot({ readyState = 'complete', windowExtras = {}, VoiceIsolatePro, Auth, protocol = 'http:', fetchMock } = {}) {
  const doc = makeDocument(readyState);
  const con = makeConsole();
  const loc = makeLocation(protocol);

  // Default fetch that simulates a reachable server
  const defaultFetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

  const win = Object.assign({ _vipApp: undefined, vip: undefined }, windowExtras);
  bootWindows.add(win);

  const fn = new Function(
    'window',
    'document',
    'location',
    'fetch',
    'VoiceIsolatePro',
    'Auth',
    'console',
    vipBootSrc
  );

  fn(win, doc, loc, fetchMock || defaultFetch, VoiceIsolatePro, Auth, con);

  return { win, doc, con };
}

// Helper: run and trigger DOMContentLoaded if needed
function runAndBoot(opts = {}) {
  const result = runVipBoot(opts);
  if (opts.readyState === 'loading') {
    result.doc._triggerEvent('DOMContentLoaded');
  }
  return result;
}

// ── _callAuthInit() ──────────────────────────────────────────────────────────

describe('vip-boot.js — _callAuthInit()', () => {
  test('calls Auth.init() when Auth is defined, not logged in, and currentUser is null', () => {
    const auth = makeAuth({ isLoggedIn: false, currentUser: null });
    const VIP  = jest.fn().mockImplementation(function () { this._initCalled = false; });
    runAndBoot({ VoiceIsolatePro: VIP, Auth: auth });
    expect(auth.init).toHaveBeenCalledTimes(1);
  });

  test('does NOT call Auth.init() when Auth is undefined', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { con } = runAndBoot({ VoiceIsolatePro: VIP, Auth: undefined });
    // Should emit a warning about Auth not loaded
    expect(con.warn).toHaveBeenCalledWith(
      expect.stringContaining('[vip-boot] Auth module not loaded')
    );
  });

  test('does NOT call Auth.init() and warns when Auth.isLoggedIn is truthy', () => {
    const auth = makeAuth({ isLoggedIn: true, currentUser: null });
    const VIP  = jest.fn().mockImplementation(function () {});
    runAndBoot({ VoiceIsolatePro: VIP, Auth: auth });
    expect(auth.init).not.toHaveBeenCalled();
  });

  test('does NOT call Auth.init() when Auth.currentUser is not null', () => {
    const auth = makeAuth({ isLoggedIn: false, currentUser: { uid: 'u1' } });
    const VIP  = jest.fn().mockImplementation(function () {});
    runAndBoot({ VoiceIsolatePro: VIP, Auth: auth });
    expect(auth.init).not.toHaveBeenCalled();
  });

  test('catches and warns on Auth.init() rejection', async () => {
    const rejecting = jest.fn().mockRejectedValue(new Error('auth error'));
    const auth = makeAuth({ isLoggedIn: false, currentUser: null, init: rejecting });
    const VIP  = jest.fn().mockImplementation(function () {});
    const { con } = runAndBoot({ VoiceIsolatePro: VIP, Auth: auth });

    await Promise.resolve();

    expect(con.warn).toHaveBeenCalledWith(
      expect.stringContaining('[vip-boot] Auth.init error'),
      expect.any(Error)
    );
  });
});

// ── aliasOrCreate() — window._vipApp already set ─────────────────────────────

describe('vip-boot.js — aliasOrCreate() when window._vipApp already set', () => {
  test('does not create a new instance', () => {
    const VIP      = jest.fn();
    const existing = { _initCalled: true };
    runAndBoot({ VoiceIsolatePro: VIP, windowExtras: { _vipApp: existing } });
    expect(VIP).not.toHaveBeenCalled();
  });

  test('sets window.vip to the existing _vipApp when window.vip is not set', () => {
    const VIP      = jest.fn();
    const existing = { _initCalled: true };
    const { win }  = runAndBoot({
      VoiceIsolatePro: VIP,
      windowExtras: { _vipApp: existing, vip: undefined },
    });
    expect(win.vip).toBe(existing);
  });

  test('calls _callAuthInit() (Auth.init invoked) after aliasing', () => {
    const VIP      = jest.fn();
    const existing = { _initCalled: true };
    const auth     = makeAuth({ isLoggedIn: false, currentUser: null });
    runAndBoot({
      VoiceIsolatePro: VIP,
      Auth: auth,
      windowExtras: { _vipApp: existing },
    });
    expect(auth.init).toHaveBeenCalledTimes(1);
  });
});

// ── aliasOrCreate() — window.vip instanceof VoiceIsolatePro ─────────────────

describe('vip-boot.js — aliasOrCreate() when window.vip is already a VoiceIsolatePro', () => {
  function makeVipInstance(VIP, overrides = {}) {
    const inst = new VIP();
    Object.assign(inst, overrides);
    return inst;
  }

  test('sets window._vipApp to the existing window.vip', () => {
    const VIP  = jest.fn().mockImplementation(function () { this.init = jest.fn(); this._initCalled = false; });
    const inst = makeVipInstance(VIP);
    VIP.mockClear();

    const { win } = runAndBoot({ VoiceIsolatePro: VIP, windowExtras: { vip: inst } });
    expect(win._vipApp).toBe(inst);
  });

  test('calls app.init() if it exists and _initCalled is false', () => {
    const initFn = jest.fn();
    const VIP    = jest.fn().mockImplementation(function () { this.init = initFn; this._initCalled = false; });
    const inst   = makeVipInstance(VIP);
    VIP.mockClear();

    runAndBoot({ VoiceIsolatePro: VIP, windowExtras: { vip: inst } });
    expect(initFn).toHaveBeenCalledTimes(1);
  });

  test('sets _initCalled = true after calling app.init()', () => {
    const VIP  = jest.fn().mockImplementation(function () { this.init = jest.fn(); this._initCalled = false; });
    const inst = makeVipInstance(VIP);
    VIP.mockClear();

    runAndBoot({ VoiceIsolatePro: VIP, windowExtras: { vip: inst } });
    expect(inst._initCalled).toBe(true);
  });

  test('does NOT call app.init() again if _initCalled is already true', () => {
    const initFn = jest.fn();
    const VIP    = jest.fn().mockImplementation(function () { this.init = initFn; this._initCalled = true; });
    const inst   = makeVipInstance(VIP, { _initCalled: true });
    VIP.mockClear();

    runAndBoot({ VoiceIsolatePro: VIP, windowExtras: { vip: inst } });
    expect(initFn).not.toHaveBeenCalled();
  });

  test('calls _callAuthInit() after aliasing', () => {
    const VIP  = jest.fn().mockImplementation(function () { this.init = jest.fn(); this._initCalled = false; });
    const inst = makeVipInstance(VIP);
    VIP.mockClear();
    const auth = makeAuth({ isLoggedIn: false, currentUser: null });

    runAndBoot({ VoiceIsolatePro: VIP, Auth: auth, windowExtras: { vip: inst } });
    expect(auth.init).toHaveBeenCalledTimes(1);
  });

  test('logs the aliasing info message', () => {
    const VIP  = jest.fn().mockImplementation(function () { this.init = jest.fn(); this._initCalled = false; });
    const inst = makeVipInstance(VIP);
    VIP.mockClear();
    const { con } = runAndBoot({ VoiceIsolatePro: VIP, windowExtras: { vip: inst } });
    expect(con.info).toHaveBeenCalledWith(
      expect.stringContaining('[vip-boot] Aliased window.vip → window._vipApp')
    );
  });
});

// ── aliasOrCreate() — fresh instantiation ────────────────────────────────────

describe('vip-boot.js — aliasOrCreate() fresh VoiceIsolatePro instantiation', () => {
  test('creates a new VoiceIsolatePro instance', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { win } = runAndBoot({ VoiceIsolatePro: VIP });
    expect(VIP).toHaveBeenCalledTimes(1);
    expect(win._vipApp).toBeInstanceOf(VIP);
  });

  test('sets _initCalled = true on the new instance', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { win } = runAndBoot({ VoiceIsolatePro: VIP });
    expect(win._vipApp._initCalled).toBe(true);
  });

  test('assigns both window.vip and window._vipApp to the same instance', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { win } = runAndBoot({ VoiceIsolatePro: VIP });
    expect(win.vip).toBe(win._vipApp);
  });

  test('calls _callAuthInit() after fresh instantiation', () => {
    const VIP  = jest.fn().mockImplementation(function () {});
    const auth = makeAuth({ isLoggedIn: false, currentUser: null });
    runAndBoot({ VoiceIsolatePro: VIP, Auth: auth });
    expect(auth.init).toHaveBeenCalledTimes(1);
  });

  test('logs the instantiation success message', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { con } = runAndBoot({ VoiceIsolatePro: VIP });
    expect(con.info).toHaveBeenCalledWith(
      expect.stringContaining('[vip-boot] VoiceIsolatePro instantiated')
    );
  });

  test('logs an error and does not throw when constructor throws', () => {
    const VIP = jest.fn().mockImplementation(() => { throw new Error('ctor err'); });
    const { con } = runAndBoot({ VoiceIsolatePro: VIP });
    expect(con.error).toHaveBeenCalledWith(
      expect.stringContaining('[vip-boot] Failed to instantiate VoiceIsolatePro:'),
      expect.any(Error)
    );
  });
});

// ── aliasOrCreate() — VoiceIsolatePro undefined ──────────────────────────────

describe('vip-boot.js — aliasOrCreate() when VoiceIsolatePro is undefined', () => {
  test('logs an error and does not throw', () => {
    const { con, win } = runAndBoot({ VoiceIsolatePro: undefined });
    expect(con.error).toHaveBeenCalledWith(
      expect.stringContaining('[vip-boot] VoiceIsolatePro class not found')
    );
    expect(win._vipApp).toBeUndefined();
  });
});

// ── Boot sequence — DOMContentLoaded deferral ────────────────────────────────

describe('vip-boot.js — boot sequence DOMContentLoaded deferral', () => {
  test('registers DOMContentLoaded listener when readyState is "loading"', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { doc } = runVipBoot({ readyState: 'loading', VoiceIsolatePro: VIP });

    expect(VIP).not.toHaveBeenCalled();
    expect(doc.addEventListener).toHaveBeenCalledWith(
      'DOMContentLoaded',
      expect.any(Function),
      { once: true }
    );
  });

  test('defers aliasOrCreate until DOMContentLoaded fires', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { win, doc } = runVipBoot({ readyState: 'loading', VoiceIsolatePro: VIP });

    expect(VIP).not.toHaveBeenCalled();
    doc._triggerEvent('DOMContentLoaded');
    expect(VIP).toHaveBeenCalledTimes(1);
    expect(win._vipApp).toBeInstanceOf(VIP);
  });

  test('runs immediately when readyState is "complete"', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { win } = runVipBoot({ readyState: 'complete', VoiceIsolatePro: VIP });
    expect(VIP).toHaveBeenCalledTimes(1);
    expect(win._vipApp).toBeInstanceOf(VIP);
  });

  test('runs immediately when readyState is "interactive"', () => {
    const VIP = jest.fn().mockImplementation(function () {});
    const { win } = runVipBoot({ readyState: 'interactive', VoiceIsolatePro: VIP });
    expect(VIP).toHaveBeenCalledTimes(1);
    expect(win._vipApp).toBeInstanceOf(VIP);
  });
});

describe('vip-boot.js — timer lifecycle', () => {
  test('runs diagnostics after the two-second grace period', () => {
    const { doc } = runAndBoot({ protocol: 'file:' });
    const banner = { style: {} };
    const message = {};
    doc.getElementById.mockImplementation(id => {
      if (id === 'vip-startup-banner') return banner;
      if (id === 'vip-startup-msg') return message;
      return null;
    });

    jest.advanceTimersByTime(1999);
    expect(banner.style.display).toBeUndefined();
    jest.advanceTimersByTime(1);
    expect(banner.style.display).toBe('flex');
    expect(message.innerHTML).toContain('No local server detected');
  });

  test('restarting polling replaces the previous interval', () => {
    const { win } = runAndBoot();
    const firstInterval = win._vipPillDriverIv;
    expect(jest.getTimerCount()).toBe(2);

    win._vipBootTestHooks.startPillDriver();

    expect(win._vipPillDriverIv).not.toBe(firstInterval);
    expect(jest.getTimerCount()).toBe(2);
    jest.advanceTimersByTime(2000);
    expect(jest.getTimerCount()).toBe(1);
    win._vipPillDriverCleanup();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('cleanup cancels recurring work and is idempotent', () => {
    const { win } = runAndBoot();
    const cleanup = win._vipPillDriverCleanup;
    cleanup();
    cleanup();

    expect(win._vipPillDriverIv).toBeNull();
    expect(win._vipPillDriverCleanup).toBeNull();
    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(2000);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('preserves polling in bfcache and disposes it on final pagehide', () => {
    const listeners = new Map();
    const { win } = runAndBoot({
      windowExtras: {
        addEventListener: jest.fn((event, callback) => listeners.set(event, callback)),
        removeEventListener: jest.fn((event, callback) => {
          if (listeners.get(event) === callback) listeners.delete(event);
        }),
      },
    });
    jest.advanceTimersByTime(2000);
    const onPageHide = listeners.get('pagehide');

    onPageHide({ persisted: true });
    expect(jest.getTimerCount()).toBe(1);
    expect(listeners.get('pagehide')).toBe(onPageHide);

    onPageHide({ persisted: false });
    expect(jest.getTimerCount()).toBe(0);
    expect(listeners.has('pagehide')).toBe(false);
    expect(win._vipPillDriverCleanup).toBeNull();
  });

  test.each([false, true])('caps pending polling at ten minutes (native=%s)', native => {
    const { win } = runAndBoot({
      windowExtras: { Capacitor: { isNativePlatform: () => native } },
    });
    jest.advanceTimersByTime(10 * 60 * 1000 - 1);
    expect(jest.getTimerCount()).toBe(1);

    jest.advanceTimersByTime(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(win._vipPillDriverCleanup).toBeNull();
  });
});
