'use strict';

/**
 * Tests for the _vipBootstrap IIFE added at the bottom of app.js.
 *
 * This bootstrap block is responsible for:
 *  - Instantiating VoiceIsolatePro and assigning it to window.vip / window._vipApp
 *    when vip-boot.js has not already done so.
 *  - Conditionally calling Auth.init() as a safety-net fallback.
 *  - Deferring via DOMContentLoaded when document.readyState === 'loading'.
 *  - Running immediately when the DOM is already ready.
 *
 * Because app.js is a browser-targeted non-module script, we extract only the
 * bootstrap block (everything after `module.exports = VoiceIsolatePro;`) and
 * evaluate it inside a tightly controlled environment.
 */

const fs   = require('fs');
const path = require('path');

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the _vipBootstrap IIFE source from app.js.
 * We take everything after the module.exports line so that we don't need to
 * instantiate the full VoiceIsolatePro class in this test file.
 */
function extractBootstrapBlock() {
  const src = fs.readFileSync(
    path.join(__dirname, '../public/app/app.js'),
    'utf8'
  );
  const marker = 'if (typeof module !== \'undefined\') module.exports = VoiceIsolatePro;';
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error('Could not locate module.exports marker in app.js');
  return src.slice(idx + marker.length);
}

const bootstrapSrc = extractBootstrapBlock();

/**
 * Run the bootstrap block in a sandboxed scope.
 *
 * @param {object} opts
 * @param {object}   opts.window           - The fake window object
 * @param {object}   opts.document         - The fake document object
 * @param {Function} opts.VoiceIsolatePro  - Constructor to use (or undefined)
 * @param {object}   opts.Auth             - Auth module mock (or undefined)
 * @param {object}   opts.console          - Console mock
 */
function runBootstrap({ window, document, VoiceIsolatePro, Auth, console: consoleMock }) {
  // Build the source injected into the function:
  // we need to expose `window`, `document`, `VoiceIsolatePro`, and optionally
  // `Auth` as local bindings so the IIFE can reference them.
  const fn = new Function(
    'window',
    'document',
    'VoiceIsolatePro',
    'Auth',
    'console',
    bootstrapSrc
  );
  fn(window, document, VoiceIsolatePro, Auth, consoleMock);
}

// ── Mock factories ────────────────────────────────────────────────────────────

function makeDocument(readyState = 'complete') {
  const listeners = {};
  return {
    readyState,
    addEventListener: jest.fn((event, cb, opts) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(cb);
    }),
    removeEventListener: jest.fn(),
    _triggerEvent(event) {
      (listeners[event] || []).forEach(cb => cb());
    },
  };
}

function makeWindow(overrides = {}) {
  return Object.assign({ _vipApp: undefined, vip: undefined }, overrides);
}

function makeVoiceIsolatePro(overrides = {}) {
  return jest.fn().mockImplementation(function () {
    Object.assign(this, overrides);
  });
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

function makeConsole() {
  return {
    info:  jest.fn(),
    warn:  jest.fn(),
    error: jest.fn(),
    log:   jest.fn(),
  };
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('_vipBootstrap (app.js) — DOM ready immediately', () => {
  test('instantiates VoiceIsolatePro and assigns window.vip + window._vipApp', () => {
    const VIP   = makeVoiceIsolatePro();
    const win   = makeWindow();
    const doc   = makeDocument('complete');
    const con   = makeConsole();

    runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: undefined, console: con });

    expect(VIP).toHaveBeenCalledTimes(1);
    expect(win._vipApp).toBeInstanceOf(VIP);
    expect(win.vip).toBe(win._vipApp);
  });

  test('sets _initCalled = true on the created instance', () => {
    const VIP = makeVoiceIsolatePro();
    const win = makeWindow();
    const doc = makeDocument('complete');
    const con = makeConsole();

    runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: undefined, console: con });

    expect(win._vipApp._initCalled).toBe(true);
  });

  test('skips instantiation when window._vipApp is already set', () => {
    const existing = { _initCalled: true };
    const VIP = makeVoiceIsolatePro();
    const win = makeWindow({ _vipApp: existing });
    const doc = makeDocument('complete');
    const con = makeConsole();

    runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: undefined, console: con });

    expect(VIP).not.toHaveBeenCalled();
    expect(win._vipApp).toBe(existing);
  });

  test('calls Auth.init() when Auth is present, not logged in, and currentUser is null', () => {
    const VIP  = makeVoiceIsolatePro();
    const win  = makeWindow();
    const doc  = makeDocument('complete');
    const auth = makeAuth({ isLoggedIn: false, currentUser: null });
    const con  = makeConsole();

    runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: auth, console: con });

    expect(auth.init).toHaveBeenCalledTimes(1);
  });

  test('does NOT call Auth.init() when Auth.isLoggedIn is truthy', () => {
    const VIP  = makeVoiceIsolatePro();
    const win  = makeWindow();
    const doc  = makeDocument('complete');
    const auth = makeAuth({ isLoggedIn: true, currentUser: null });
    const con  = makeConsole();

    runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: auth, console: con });

    expect(auth.init).not.toHaveBeenCalled();
  });

  test('does NOT call Auth.init() when Auth.currentUser is not null', () => {
    const VIP  = makeVoiceIsolatePro();
    const win  = makeWindow();
    const doc  = makeDocument('complete');
    const auth = makeAuth({ isLoggedIn: false, currentUser: { uid: 'abc' } });
    const con  = makeConsole();

    runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: auth, console: con });

    expect(auth.init).not.toHaveBeenCalled();
  });

  test('does NOT call Auth.init() when Auth is undefined', () => {
    const VIP = makeVoiceIsolatePro();
    const win = makeWindow();
    const doc = makeDocument('complete');
    const con = makeConsole();

    // Should not throw
    expect(() => {
      runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: undefined, console: con });
    }).not.toThrow();
  });

  test('catches VoiceIsolatePro constructor errors and logs them', () => {
    const VIP = jest.fn().mockImplementation(() => { throw new Error('ctor fail'); });
    const win = makeWindow();
    const doc = makeDocument('complete');
    const con = makeConsole();

    expect(() => {
      runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: undefined, console: con });
    }).not.toThrow();

    expect(con.error).toHaveBeenCalledWith(
      expect.stringContaining('[app] Bootstrap failed:'),
      expect.any(Error)
    );
    expect(win._vipApp).toBeUndefined();
  });

  test('logs success info message after successful bootstrap', () => {
    const VIP = makeVoiceIsolatePro();
    const win = makeWindow();
    const doc = makeDocument('complete');
    const con = makeConsole();

    runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: undefined, console: con });

    expect(con.info).toHaveBeenCalledWith(
      expect.stringContaining('[app] VoiceIsolatePro ready')
    );
  });
});

describe('_vipBootstrap (app.js) — DOM still loading', () => {
  test('registers DOMContentLoaded listener when readyState is "loading"', () => {
    const VIP = makeVoiceIsolatePro();
    const win = makeWindow();
    const doc = makeDocument('loading');
    const con = makeConsole();

    runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: undefined, console: con });

    // Constructor must not be called yet
    expect(VIP).not.toHaveBeenCalled();
    expect(doc.addEventListener).toHaveBeenCalledWith(
      'DOMContentLoaded',
      expect.any(Function),
      { once: true }
    );
  });

  test('defers instantiation until DOMContentLoaded fires', () => {
    const VIP = makeVoiceIsolatePro();
    const win = makeWindow();
    const doc = makeDocument('loading');
    const con = makeConsole();

    runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: undefined, console: con });

    expect(VIP).not.toHaveBeenCalled();

    // Simulate the browser firing DOMContentLoaded
    doc._triggerEvent('DOMContentLoaded');

    expect(VIP).toHaveBeenCalledTimes(1);
    expect(win._vipApp).toBeInstanceOf(VIP);
  });

  test('skips instantiation in deferred path when window._vipApp is already set', () => {
    const existing = { _initCalled: true };
    const VIP = makeVoiceIsolatePro();
    const win = makeWindow({ _vipApp: existing });
    const doc = makeDocument('loading');
    const con = makeConsole();

    runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: undefined, console: con });
    doc._triggerEvent('DOMContentLoaded');

    expect(VIP).not.toHaveBeenCalled();
    expect(win._vipApp).toBe(existing);
  });

  test('calls Auth.init() in deferred path when conditions are met', () => {
    const VIP  = makeVoiceIsolatePro();
    const win  = makeWindow();
    const doc  = makeDocument('loading');
    const auth = makeAuth({ isLoggedIn: false, currentUser: null });
    const con  = makeConsole();

    runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: auth, console: con });
    doc._triggerEvent('DOMContentLoaded');

    expect(auth.init).toHaveBeenCalledTimes(1);
  });
});

describe('_vipBootstrap (app.js) — Auth.init() error handling', () => {
  test('catches and warns on Auth.init() rejection', async () => {
    const VIP  = makeVoiceIsolatePro();
    const win  = makeWindow();
    const doc  = makeDocument('complete');
    const con  = makeConsole();
    const auth = makeAuth({
      isLoggedIn: false,
      currentUser: null,
      init: jest.fn().mockRejectedValue(new Error('auth fail')),
    });

    runBootstrap({ window: win, document: doc, VoiceIsolatePro: VIP, Auth: auth, console: con });

    // Let the promise rejection propagate
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(con.warn).toHaveBeenCalledWith(
      expect.stringContaining('[app] Auth.init error:'),
      expect.any(Error)
    );
  });
});