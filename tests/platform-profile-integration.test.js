/**
 * VoiceIsolate Pro — Platform-specific profile-selection integration tests
 *
 * Covers the Android and Desktop extensions added alongside the core
 * setActiveProfile → setProfile fix:
 *
 *   Android   platform.hapticConfirm('selection') is called when a profile
 *             is selected (wired via platform.hapticConfirm?.() optional chain
 *             in wireProfiles() — no-op on Browser/Desktop).
 *
 *   Desktop   keys 1–4 select Quick/Meeting/Studio/Forensic respectively via
 *             DesktopAdapter.setupKeyboardShortcuts() → selectProfile handler.
 *
 *   All       createPlatformAdapter() returns an instance whose injected
 *             sessionStore exposes setProfile, not setActiveProfile, on all
 *             three platforms.
 *
 * Tests:
 *   PA-01  AndroidAdapter.hapticConfirm exists and is callable
 *   PA-02  BrowserAdapter and DesktopAdapter do NOT expose hapticConfirm
 *          (optional-chain guard in wireProfiles must be correct)
 *   PA-03  DesktopAdapter.setupKeyboardShortcuts calls selectProfile for keys 1-4
 *   PA-04  DesktopAdapter key handler respects isTextEntry guard (no profile
 *          switch while typing in input/textarea)
 *   PA-05  DesktopAdapter key handler ignores keys 1-4 when a modifier is held
 *   PA-06  DesktopAdapter key handler ignores repeated keydown events (key held)
 *   PA-07  createPlatformAdapter injected store exposes setProfile on all platforms
 *   PA-08  premium-workspace.js source calls platform.hapticConfirm?.() in wireProfiles
 *   PA-09  DesktopAdapter.setupKeyboardShortcuts returns an unsubscribe function
 *   PA-10  BrowserAdapter.setupKeyboardShortcuts does NOT call selectProfile
 *          (profile shortcuts are desktop-only)
 */

'use strict';

const fs = require('fs');
const path = require('path');

let AndroidAdapter;
let BrowserAdapter;
let DesktopAdapter;
let AudioSessionStore;
let UIStore;
let Profiles;

beforeAll(async () => {
  ({ AndroidAdapter }    = await import('../src/platform/android/AndroidAdapter.js'));
  ({ BrowserAdapter }    = await import('../src/platform/browser/BrowserAdapter.js'));
  ({ DesktopAdapter }    = await import('../src/platform/desktop/DesktopAdapter.js'));
  ({ AudioSessionStore } = await import('../src/state/audioSessionStore.js'));
  ({ UIStore }           = await import('../src/state/uiStore.js'));
  ({ Profiles }          = await import('../src/ui/tokens/design-tokens.js'));
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeStores() {
  return {
    sessionStore: new AudioSessionStore(),
    uiStore: new UIStore(),
  };
}

/**
 * Minimal KeyboardEvent-like object for testing DesktopAdapter key dispatch.
 */
function fakeKey(key, opts = {}) {
  return {
    key,
    code: opts.code || `Key${key.toUpperCase()}`,
    ctrlKey: opts.ctrlKey || false,
    metaKey: opts.metaKey || false,
    altKey: opts.altKey || false,
    repeat: opts.repeat || false,
    preventDefault: jest.fn(),
    target: opts.target || { tagName: 'BODY', matches: () => false, contentEditable: 'false', isContentEditable: false },
  };
}

// ── PA-01: AndroidAdapter has hapticConfirm ───────────────────────────────────

describe('PA-01 AndroidAdapter.hapticConfirm', () => {
  test('hapticConfirm is a function on AndroidAdapter instances', () => {
    const { sessionStore, uiStore } = makeStores();
    const adapter = new AndroidAdapter(sessionStore, uiStore);
    expect(typeof adapter.hapticConfirm).toBe('function');
  });

  test('hapticConfirm(selection) does not throw in a Node context without navigator.vibrate', () => {
    const { sessionStore, uiStore } = makeStores();
    const adapter = new AndroidAdapter(sessionStore, uiStore);
    // Node has no navigator.vibrate — the guard must swallow that safely.
    expect(() => adapter.hapticConfirm('selection')).not.toThrow();
  });
});

// ── PA-02: BrowserAdapter and DesktopAdapter have no hapticConfirm ────────────

describe('PA-02 BrowserAdapter and DesktopAdapter do not have hapticConfirm', () => {
  test('BrowserAdapter instances do not expose hapticConfirm', () => {
    const { sessionStore, uiStore } = makeStores();
    expect(new BrowserAdapter(sessionStore, uiStore).hapticConfirm).toBeUndefined();
  });

  test('DesktopAdapter instances do not expose hapticConfirm', () => {
    const { sessionStore, uiStore } = makeStores();
    expect(new DesktopAdapter(sessionStore, uiStore).hapticConfirm).toBeUndefined();
  });

  test('calling hapticConfirm?.() on a BrowserAdapter is a silent no-op', () => {
    const { sessionStore, uiStore } = makeStores();
    const adapter = new BrowserAdapter(sessionStore, uiStore);
    expect(() => adapter.hapticConfirm?.('selection')).not.toThrow();
  });
});

// ── PA-03: DesktopAdapter keys 1-4 → selectProfile ───────────────────────────

describe('PA-03 DesktopAdapter.setupKeyboardShortcuts keys 1-4 call selectProfile', () => {
  // We need window in a minimal form for addEventListener/removeEventListener.
  let mockWindow;
  let capturedListener;

  beforeEach(() => {
    capturedListener = null;
    mockWindow = {
      addEventListener: jest.fn((ev, fn) => { if (ev === 'keydown') capturedListener = fn; }),
      removeEventListener: jest.fn(),
    };
    global.window = mockWindow;
  });

  afterEach(() => {
    delete global.window;
  });

  const profileMap = [
    ['1', 'quick'],
    ['2', 'meeting'],
    ['3', 'studio'],
    ['4', 'forensic'],
  ];

  test.each(profileMap)('key "%s" calls selectProfile with "%s"', (key, profile) => {
    const { sessionStore, uiStore } = makeStores();
    const adapter = new DesktopAdapter(sessionStore, uiStore);
    const selectProfile = jest.fn();
    adapter.setupKeyboardShortcuts({ selectProfile });
    expect(capturedListener).not.toBeNull();
    capturedListener(fakeKey(key));
    expect(selectProfile).toHaveBeenCalledWith(profile);
  });

  test('keys 5-9 do not trigger selectProfile', () => {
    const { sessionStore, uiStore } = makeStores();
    const adapter = new DesktopAdapter(sessionStore, uiStore);
    const selectProfile = jest.fn();
    adapter.setupKeyboardShortcuts({ selectProfile });
    for (const key of ['5', '6', '7', '8', '9', '0']) {
      capturedListener(fakeKey(key));
    }
    expect(selectProfile).not.toHaveBeenCalled();
  });
});

// ── PA-04: isTextEntry guard blocks profile shortcuts while typing ─────────────

describe('PA-04 DesktopAdapter profile shortcuts blocked in text inputs', () => {
  let capturedListener;
  beforeEach(() => {
    capturedListener = null;
    global.window = {
      addEventListener: jest.fn((ev, fn) => { if (ev === 'keydown') capturedListener = fn; }),
      removeEventListener: jest.fn(),
    };
  });
  afterEach(() => { delete global.window; });

  const textTargets = [
    { tagName: 'INPUT',    matches: (s) => ['input, textarea, select', 'input'].some((p) => s.includes(p.split(',')[0].trim())), contentEditable: 'false', isContentEditable: false },
    { tagName: 'TEXTAREA', matches: (s) => s.includes('textarea'), contentEditable: 'false', isContentEditable: false },
    { tagName: 'DIV',      matches: () => false, contentEditable: 'true', isContentEditable: true },
  ];

  test.each(textTargets)('key "1" is ignored when target is $tagName (text entry)', (target) => {
    const { sessionStore, uiStore } = makeStores();
    const adapter = new DesktopAdapter(sessionStore, uiStore);
    const selectProfile = jest.fn();
    adapter.setupKeyboardShortcuts({ selectProfile });
    capturedListener(fakeKey('1', { target }));
    expect(selectProfile).not.toHaveBeenCalled();
  });
});

// ── PA-05: Modifier keys suppress profile shortcuts ───────────────────────────

describe('PA-05 DesktopAdapter profile shortcuts ignored when modifier held', () => {
  let capturedListener;
  beforeEach(() => {
    capturedListener = null;
    global.window = {
      addEventListener: jest.fn((ev, fn) => { if (ev === 'keydown') capturedListener = fn; }),
      removeEventListener: jest.fn(),
    };
  });
  afterEach(() => { delete global.window; });

  test('Ctrl+1 does not call selectProfile', () => {
    const { sessionStore, uiStore } = makeStores();
    const adapter = new DesktopAdapter(sessionStore, uiStore);
    const selectProfile = jest.fn();
    adapter.setupKeyboardShortcuts({ selectProfile });
    capturedListener(fakeKey('1', { ctrlKey: true }));
    expect(selectProfile).not.toHaveBeenCalled();
  });

  test('Meta+2 does not call selectProfile', () => {
    const { sessionStore, uiStore } = makeStores();
    const adapter = new DesktopAdapter(sessionStore, uiStore);
    const selectProfile = jest.fn();
    adapter.setupKeyboardShortcuts({ selectProfile });
    capturedListener(fakeKey('2', { metaKey: true }));
    expect(selectProfile).not.toHaveBeenCalled();
  });

  test('Alt+3 does not call selectProfile', () => {
    const { sessionStore, uiStore } = makeStores();
    const adapter = new DesktopAdapter(sessionStore, uiStore);
    const selectProfile = jest.fn();
    adapter.setupKeyboardShortcuts({ selectProfile });
    capturedListener(fakeKey('3', { altKey: true }));
    expect(selectProfile).not.toHaveBeenCalled();
  });
});

// ── PA-06: Repeat keydown events are ignored ──────────────────────────────────

describe('PA-06 DesktopAdapter ignores repeated keydown for profile keys', () => {
  let capturedListener;
  beforeEach(() => {
    capturedListener = null;
    global.window = {
      addEventListener: jest.fn((ev, fn) => { if (ev === 'keydown') capturedListener = fn; }),
      removeEventListener: jest.fn(),
    };
  });
  afterEach(() => { delete global.window; });

  test('repeat:true key "1" does not call selectProfile', () => {
    const { sessionStore, uiStore } = makeStores();
    const adapter = new DesktopAdapter(sessionStore, uiStore);
    const selectProfile = jest.fn();
    adapter.setupKeyboardShortcuts({ selectProfile });
    capturedListener(fakeKey('1', { repeat: true }));
    expect(selectProfile).not.toHaveBeenCalled();
  });
});

// ── PA-07: createPlatformAdapter store has setProfile on all platforms ─────────

describe('PA-07 Injected store exposes setProfile (not setActiveProfile) on all platforms', () => {
  const platforms = ['browser', 'android', 'desktop'];

  test.each(platforms)('createPlatformAdapter("%s") injected store has setProfile', async (plat) => {
    const { createPlatformAdapter } = await import('../src/platform/index.js');
    const { sessionStore, uiStore } = makeStores();
    const adapter = createPlatformAdapter(plat, sessionStore, uiStore);
    expect(typeof adapter.sessionStore.setProfile).toBe('function');
    expect(adapter.sessionStore.setActiveProfile).toBeUndefined();
  });
});

// ── PA-08: Source-text guard — wireProfiles calls platform.hapticConfirm?.() ──

describe('PA-08 premium-workspace.js source calls platform.hapticConfirm?.() in wireProfiles', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'public', 'app', 'premium-workspace.js'),
    'utf8',
  );

  test('wireProfiles contains platform.hapticConfirm?.() call', () => {
    expect(src).toContain("platform.hapticConfirm?.('selection')");
  });

  test('hapticConfirm call appears after sessionStore.setProfile within wireProfiles', () => {
    const setProfileIdx  = src.indexOf('sessionStore.setProfile(profile)');
    const hapticIdx      = src.indexOf("platform.hapticConfirm?.('selection')");
    const wireProfilesEnd = src.indexOf('// Apply profile to existing DSP controls');
    expect(setProfileIdx).toBeGreaterThan(-1);
    expect(hapticIdx).toBeGreaterThan(setProfileIdx);
    expect(hapticIdx).toBeLessThan(wireProfilesEnd);
  });
});

// ── PA-09: DesktopAdapter.setupKeyboardShortcuts returns an unsubscribe fn ────

describe('PA-09 DesktopAdapter.setupKeyboardShortcuts returns an unsubscribe function', () => {
  let capturedListener;
  beforeEach(() => {
    capturedListener = null;
    global.window = {
      addEventListener: jest.fn((ev, fn) => { if (ev === 'keydown') capturedListener = fn; }),
      removeEventListener: jest.fn(),
    };
  });
  afterEach(() => { delete global.window; });

  test('returns a function that removes the keydown listener', () => {
    const { sessionStore, uiStore } = makeStores();
    const adapter = new DesktopAdapter(sessionStore, uiStore);
    const unsub = adapter.setupKeyboardShortcuts({});
    expect(typeof unsub).toBe('function');
    unsub();
    expect(global.window.removeEventListener).toHaveBeenCalledWith('keydown', expect.any(Function));
  });
});

// ── PA-10: BrowserAdapter has no profile key shortcuts ────────────────────────

describe('PA-10 BrowserAdapter.setupKeyboardShortcuts does not dispatch profile shortcuts', () => {
  let capturedListener;
  beforeEach(() => {
    capturedListener = null;
    global.window = {
      addEventListener: jest.fn((ev, fn) => { if (ev === 'keydown') capturedListener = fn; }),
      removeEventListener: jest.fn(),
    };
  });
  afterEach(() => { delete global.window; });

  test('keys 1-4 in BrowserAdapter do not invoke selectProfile', () => {
    const { sessionStore, uiStore } = makeStores();
    const adapter = new BrowserAdapter(sessionStore, uiStore);
    const selectProfile = jest.fn();
    adapter.setupKeyboardShortcuts({ selectProfile });
    for (const k of ['1', '2', '3', '4']) {
      capturedListener?.(fakeKey(k));
    }
    expect(selectProfile).not.toHaveBeenCalled();
  });
});
