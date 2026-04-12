/**
 * VoiceIsolate Pro — VIPAuth Client Module Tests
 *
 * Tests the browser-side auth module (public/app/auth.js):
 *   - Session persistence helpers (_saveSession / _loadSession / _clearSession)
 *   - _escHtml XSS protection
 *   - VIPAuth public API: getUser(), isLoggedIn(), isAdmin(), logout()
 *   - _renderLoginOverlay() / _renderUserBadge() DOM rendering
 *   - _handleLogin() form submission logic
 *   - init() session-restore and fallback-to-login flows
 *
 * Uses a jsdom-based environment (jest-environment-jsdom) for DOM APIs.
 *
 * @jest-environment jsdom
 */

'use strict';

// ── Minimal stubs expected by auth.js at parse time ───────────────────────────
// auth.js calls VIPAuth.init() immediately when document.readyState !== 'loading'.
// We intercept fetch before loading the module so init() does not actually hit
// the network.

// Keep a handle on the fetch mock so individual tests can override the implementation.
let fetchMock;

beforeAll(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock;

  // auth.js reads document.readyState to decide when to init. JSDOM typically
  // sets it to 'complete' so the else-branch fires and calls VIPAuth.init()
  // synchronously. We stub it to 'loading' so the module loads without
  // triggering init() automatically.
  Object.defineProperty(document, 'readyState', {
    configurable: true,
    get: () => 'loading',
  });
});

afterEach(() => {
  // Clean up any injected DOM elements between tests
  const overlay = document.getElementById('authOverlay');
  if (overlay) overlay.remove();
  const badge = document.getElementById('authBadge');
  if (badge) badge.remove();

  localStorage.clear();
  jest.clearAllMocks();
  global.window.LicenseManager = undefined;
});

// ── Load VIPAuth module ───────────────────────────────────────────────────────
// Use fs + eval so we can load the IIFE in the jsdom global scope.
const fs   = require('fs');
const path = require('path');

const authSrc = fs.readFileSync(
  path.join(__dirname, '../public/app/auth.js'),
  'utf8'
);

// Evaluate in global scope once — the IIFE assigns to `const VIPAuth` at the
// module top level so we must eval in global scope to access it from tests.
// We strip the DOMContentLoaded auto-init block and call init() manually.
const srcWithoutAutoInit = authSrc
  .replace(/\/\/ Auto-init[\s\S]*$/, '');  // remove trailing auto-init block

eval(srcWithoutAutoInit); // eslint-disable-line no-eval

// VIPAuth is now available as a global in this test file's scope

// ── localStorage session helpers (tested via VIPAuth behaviour) ───────────────
describe('Session persistence', () => {
  test('isLoggedIn() returns false when no session is stored', () => {
    localStorage.clear();
    expect(VIPAuth.isLoggedIn()).toBe(false);
  });

  test('getUser() returns null when not logged in', () => {
    expect(VIPAuth.getUser()).toBeNull();
  });

  test('isAdmin() returns false when not logged in', () => {
    expect(VIPAuth.isAdmin()).toBe(false);
  });
});

// ── _renderLoginOverlay ───────────────────────────────────────────────────────
describe('_renderLoginOverlay()', () => {
  test('init() renders the auth overlay when no session exists', async () => {
    localStorage.clear();
    fetchMock.mockRejectedValue(new Error('no server'));

    await VIPAuth.init();

    expect(document.getElementById('authOverlay')).not.toBeNull();
  });

  test('overlay contains the login form elements', async () => {
    localStorage.clear();
    fetchMock.mockRejectedValue(new Error('no server'));

    await VIPAuth.init();

    expect(document.getElementById('authForm')).not.toBeNull();
    expect(document.getElementById('authUser')).not.toBeNull();
    expect(document.getElementById('authPass')).not.toBeNull();
    expect(document.getElementById('authSubmit')).not.toBeNull();
    expect(document.getElementById('authError')).not.toBeNull();
  });

  test('overlay is not duplicated on a second init() call', async () => {
    localStorage.clear();
    fetchMock.mockRejectedValue(new Error('no server'));

    await VIPAuth.init();
    await VIPAuth.init();

    const overlays = document.querySelectorAll('#authOverlay');
    expect(overlays.length).toBe(1);
  });
});

// ── _handleLogin — form submission ────────────────────────────────────────────
describe('_handleLogin()', () => {
  async function renderAndGetForm() {
    localStorage.clear();
    fetchMock.mockRejectedValue(new Error('no server'));
    await VIPAuth.init();
    return {
      form:     document.getElementById('authForm'),
      userInput: document.getElementById('authUser'),
      passInput: document.getElementById('authPass'),
      submitBtn: document.getElementById('authSubmit'),
      errEl:    document.getElementById('authError'),
    };
  }

  test('shows validation error when username is empty', async () => {
    const { form, userInput, passInput, errEl } = await renderAndGetForm();
    userInput.value = '';
    passInput.value = 'somepass';

    form.dispatchEvent(new Event('submit'));
    await Promise.resolve();

    expect(errEl.textContent).toContain('Please enter username and password');
  });

  test('shows validation error when password is empty', async () => {
    const { form, userInput, passInput, errEl } = await renderAndGetForm();
    userInput.value = 'testuser';
    passInput.value = '';

    form.dispatchEvent(new Event('submit'));
    await Promise.resolve();

    expect(errEl.textContent).toContain('Please enter username and password');
  });

  test('disables submit button while signing in', async () => {
    const { form, userInput, passInput, submitBtn } = await renderAndGetForm();
    userInput.value = 'testuser';
    passInput.value = 'testpass';

    // Mock fetch to never resolve so we can observe the in-flight state
    fetchMock.mockReturnValue(new Promise(() => {}));

    form.dispatchEvent(new Event('submit'));
    await Promise.resolve();   // let microtask queue flush

    expect(submitBtn.disabled).toBe(true);
    expect(submitBtn.textContent).toBe('Signing in...');
  });

  test('shows API error message on failed login', async () => {
    const { form, userInput, passInput, errEl } = await renderAndGetForm();
    userInput.value = 'baduser';
    passInput.value = 'badpass';

    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({ success: false, error: 'Invalid username or password.' }),
    });

    form.dispatchEvent(new Event('submit'));
    await new Promise((r) => setTimeout(r, 50));

    expect(errEl.textContent).toBe('Invalid username or password.');
  });

  test('re-enables submit button after failed login', async () => {
    const { form, userInput, passInput, submitBtn } = await renderAndGetForm();
    userInput.value = 'baduser';
    passInput.value = 'badpass';

    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({ success: false, error: 'Invalid username or password.' }),
    });

    form.dispatchEvent(new Event('submit'));
    await new Promise((r) => setTimeout(r, 50));

    expect(submitBtn.disabled).toBe(false);
    expect(submitBtn.textContent).toBe('Sign In');
  });

  test('shows network error message when fetch throws', async () => {
    const { form, userInput, passInput, errEl } = await renderAndGetForm();
    userInput.value = 'testuser';
    passInput.value = 'testpass';

    fetchMock.mockRejectedValue(new Error('Network failure'));

    form.dispatchEvent(new Event('submit'));
    await new Promise((r) => setTimeout(r, 50));

    expect(errEl.textContent).toContain('Network error');
  });

  test('removes overlay and renders badge on successful login', async () => {
    const { form, userInput, passInput } = await renderAndGetForm();
    userInput.value = 'test_pro';
    passInput.value = 'TestPro123';

    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        token:   'header.payload.sig',
        user:    { id: 'usr_test_pro', username: 'test_pro', email: 'pro@test.com', tier: 'PRO', role: 'user' },
      }),
    });

    form.dispatchEvent(new Event('submit'));
    await new Promise((r) => setTimeout(r, 50));

    expect(document.getElementById('authOverlay')).toBeNull();
    expect(document.getElementById('authBadge')).not.toBeNull();
  });

  test('saves session to localStorage on successful login', async () => {
    const { form, userInput, passInput } = await renderAndGetForm();
    userInput.value = 'test_pro';
    passInput.value = 'TestPro123';

    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        token:   'mytoken123',
        user:    { id: 'usr_test_pro', username: 'test_pro', email: 'pro@test.com', tier: 'PRO', role: 'user' },
      }),
    });

    form.dispatchEvent(new Event('submit'));
    await new Promise((r) => setTimeout(r, 50));

    const stored = JSON.parse(localStorage.getItem('vip_auth_v22'));
    expect(stored.username).toBe('test_pro');
    expect(stored.token).toBe('mytoken123');
  });

  test('calls LicenseManager.activate with token and email on successful login', async () => {
    const activate = jest.fn();
    global.window.LicenseManager = { activate };

    const { form, userInput, passInput } = await renderAndGetForm();
    userInput.value = 'test_pro';
    passInput.value = 'TestPro123';

    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        token:   'mytoken456',
        user:    { id: 'usr_test_pro', username: 'test_pro', email: 'pro@test.com', tier: 'PRO', role: 'user' },
      }),
    });

    form.dispatchEvent(new Event('submit'));
    await new Promise((r) => setTimeout(r, 50));

    expect(activate).toHaveBeenCalledWith('mytoken456', 'pro@test.com');
  });

  test('updates _currentUser after successful login', async () => {
    const { form, userInput, passInput } = await renderAndGetForm();
    userInput.value = 'test_studio';
    passInput.value = 'TestStudio123';

    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({
        success: true,
        token:   'tok',
        user:    { id: 'usr_test_studio', username: 'test_studio', email: 'studio@test.com', tier: 'STUDIO', role: 'user' },
      }),
    });

    form.dispatchEvent(new Event('submit'));
    await new Promise((r) => setTimeout(r, 50));

    expect(VIPAuth.isLoggedIn()).toBe(true);
    expect(VIPAuth.getUser().username).toBe('test_studio');
  });
});

// ── _renderUserBadge DOM output ───────────────────────────────────────────────
describe('_renderUserBadge()', () => {
  async function loginSuccessfully(user) {
    localStorage.clear();
    fetchMock.mockRejectedValue(new Error('no session'));
    await VIPAuth.init();

    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({ success: true, token: 'tok', user }),
    });

    const form = document.getElementById('authForm');
    document.getElementById('authUser').value = user.username;
    document.getElementById('authPass').value = 'pass';
    form.dispatchEvent(new Event('submit'));
    await new Promise((r) => setTimeout(r, 50));
  }

  test('badge displays the correct username', async () => {
    await loginSuccessfully({
      id: 'u1', username: 'test_pro', email: 'p@t.com', tier: 'PRO', role: 'user',
    });
    const badge = document.getElementById('authBadge');
    expect(badge).not.toBeNull();
    expect(badge.innerHTML).toContain('test_pro');
  });

  test('badge displays uppercased tier', async () => {
    await loginSuccessfully({
      id: 'u2', username: 'test_studio', email: 's@t.com', tier: 'STUDIO', role: 'user',
    });
    const badge = document.getElementById('authBadge');
    expect(badge.innerHTML).toContain('STUDIO');
  });

  test('badge shows ADMIN label for admin role', async () => {
    await loginSuccessfully({
      id: 'u3', username: 'joker5514', email: 'a@t.com', tier: 'ENTERPRISE', role: 'admin',
    });
    const badge = document.getElementById('authBadge');
    expect(badge.innerHTML).toContain('ADMIN');
  });

  test('badge does not show ADMIN label for regular user', async () => {
    await loginSuccessfully({
      id: 'u4', username: 'test_free', email: 'f@t.com', tier: 'FREE', role: 'user',
    });
    const badge = document.getElementById('authBadge');
    expect(badge.innerHTML).not.toContain('ADMIN');
  });

  test('_escHtml prevents XSS in username', async () => {
    await loginSuccessfully({
      id: 'u5', username: '<script>alert(1)</script>', email: 'x@t.com', tier: 'PRO', role: 'user',
    });
    const badge = document.getElementById('authBadge');
    // Raw script tag must not appear unescaped in the badge HTML
    expect(badge.innerHTML).not.toContain('<script>');
    expect(badge.innerHTML).toContain('&lt;script&gt;');
  });
});

// ── _handleLogout ─────────────────────────────────────────────────────────────
describe('logout()', () => {
  async function setupLoggedIn() {
    localStorage.clear();
    fetchMock.mockRejectedValue(new Error('no session'));
    await VIPAuth.init();

    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({
        success: true, token: 'tok',
        user: { id: 'u1', username: 'test_pro', email: 'p@t.com', tier: 'PRO', role: 'user' },
      }),
    });

    const form = document.getElementById('authForm');
    document.getElementById('authUser').value = 'test_pro';
    document.getElementById('authPass').value = 'pass';
    form.dispatchEvent(new Event('submit'));
    await new Promise((r) => setTimeout(r, 50));
  }

  test('isLoggedIn() returns false after logout()', async () => {
    await setupLoggedIn();
    expect(VIPAuth.isLoggedIn()).toBe(true);
    VIPAuth.logout();
    expect(VIPAuth.isLoggedIn()).toBe(false);
  });

  test('getUser() returns null after logout()', async () => {
    await setupLoggedIn();
    VIPAuth.logout();
    expect(VIPAuth.getUser()).toBeNull();
  });

  test('clears localStorage session on logout', async () => {
    await setupLoggedIn();
    expect(localStorage.getItem('vip_auth_v22')).not.toBeNull();
    VIPAuth.logout();
    expect(localStorage.getItem('vip_auth_v22')).toBeNull();
  });

  test('removes the badge from the DOM on logout', async () => {
    await setupLoggedIn();
    expect(document.getElementById('authBadge')).not.toBeNull();
    VIPAuth.logout();
    expect(document.getElementById('authBadge')).toBeNull();
  });

  test('renders login overlay again after logout', async () => {
    await setupLoggedIn();
    VIPAuth.logout();
    expect(document.getElementById('authOverlay')).not.toBeNull();
  });

  test('calls LicenseManager.deactivate() on logout if available', async () => {
    await setupLoggedIn();
    const deactivate = jest.fn();
    global.window.LicenseManager = { deactivate };
    VIPAuth.logout();
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  test('does not throw when LicenseManager.deactivate is absent', () => {
    global.window.LicenseManager = undefined;
    expect(() => VIPAuth.logout()).not.toThrow();
  });
});

// ── init() — session restore ──────────────────────────────────────────────────
describe('init() — session restore', () => {
  test('restores session from localStorage when /me returns valid user', async () => {
    localStorage.setItem('vip_auth_v22', JSON.stringify({
      username: 'test_pro',
      token:    'valid-token',
    }));

    fetchMock.mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve({
        id: 'usr_test_pro', username: 'test_pro', email: 'pro@test.com',
        tier: 'PRO', role: 'user', isAdmin: false, expiresAt: Date.now() + 999999,
      }),
    });

    await VIPAuth.init();

    expect(VIPAuth.isLoggedIn()).toBe(true);
    expect(VIPAuth.getUser().username).toBe('test_pro');
    expect(document.getElementById('authOverlay')).toBeNull();
  });

  test('shows login overlay when stored token is rejected by /me', async () => {
    localStorage.setItem('vip_auth_v22', JSON.stringify({
      username: 'test_pro',
      token:    'expired-token',
    }));

    fetchMock.mockResolvedValue({
      ok:   false,
      json: () => Promise.resolve({ error: 'Invalid or expired token.' }),
    });

    await VIPAuth.init();

    expect(document.getElementById('authOverlay')).not.toBeNull();
  });

  test('shows login overlay when localStorage has no session', async () => {
    localStorage.clear();
    await VIPAuth.init();
    expect(document.getElementById('authOverlay')).not.toBeNull();
  });

  test('calls LicenseManager.activate on session restore', async () => {
    const activate = jest.fn();
    global.window.LicenseManager = { activate };

    localStorage.setItem('vip_auth_v22', JSON.stringify({
      username: 'test_enterprise',
      token:    'stored-token',
    }));

    fetchMock.mockResolvedValue({
      ok:   true,
      json: () => Promise.resolve({
        id: 'usr_test_enterprise', username: 'test_enterprise',
        email: 'enterprise@test.com', tier: 'ENTERPRISE', role: 'user',
        isAdmin: false, expiresAt: Date.now() + 999999,
      }),
    });

    await VIPAuth.init();

    expect(activate).toHaveBeenCalledWith('stored-token', 'enterprise@test.com');
  });

  test('falls through to login overlay when fetch throws (server down)', async () => {
    localStorage.setItem('vip_auth_v22', JSON.stringify({
      username: 'test_pro',
      token:    'some-token',
    }));

    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await VIPAuth.init();

    expect(document.getElementById('authOverlay')).not.toBeNull();
  });
});

// ── isAdmin() ─────────────────────────────────────────────────────────────────
describe('isAdmin()', () => {
  test('returns false for a regular user', async () => {
    localStorage.clear();
    fetchMock.mockRejectedValue(new Error('no session'));
    await VIPAuth.init();

    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({
        success: true, token: 'tok',
        user: { id: 'u1', username: 'test_pro', email: 'p@t.com', tier: 'PRO', role: 'user' },
      }),
    });

    const form = document.getElementById('authForm');
    document.getElementById('authUser').value = 'test_pro';
    document.getElementById('authPass').value = 'pass';
    form.dispatchEvent(new Event('submit'));
    await new Promise((r) => setTimeout(r, 50));

    expect(VIPAuth.isAdmin()).toBe(false);
  });

  test('returns true for an admin user', async () => {
    localStorage.clear();
    fetchMock.mockRejectedValue(new Error('no session'));
    await VIPAuth.init();

    fetchMock.mockResolvedValue({
      json: () => Promise.resolve({
        success: true, token: 'tok',
        user: { id: 'u3', username: 'joker5514', email: 'admin@t.com', tier: 'ENTERPRISE', role: 'admin' },
      }),
    });

    const form = document.getElementById('authForm');
    document.getElementById('authUser').value = 'joker5514';
    document.getElementById('authPass').value = 'pass';
    form.dispatchEvent(new Event('submit'));
    await new Promise((r) => setTimeout(r, 50));

    expect(VIPAuth.isAdmin()).toBe(true);
  });
});