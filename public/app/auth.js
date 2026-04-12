/**
 * VoiceIsolate Pro — public/app/auth.js
 * Client-side authentication module.
 *
 * Exposes window.VIPAuth with:
 *   init()         — restore session from localStorage or show login overlay
 *   isLoggedIn()   — returns true when a session token is held in memory
 *   getUser()      — returns the current user object (or null)
 *   isAdmin()      — returns true when the current user has role='admin'
 *   logout()       — clears the session and shows the login overlay again
 *
 * Integrates with window.LicenseManager if present:
 *   LicenseManager.activate(token, email) — called on login / session restore
 *   LicenseManager.deactivate()           — called on logout
 */
(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────
  var SESSION_KEY = 'vip_auth_v22';
  var API_BASE    = '/api/auth';

  // ── State ─────────────────────────────────────────────────────────────
  var _token       = null;
  var _currentUser = null;

  // ── Session persistence ───────────────────────────────────────────────
  function _saveSession(token, user) {
    _token       = token;
    _currentUser = user;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ username: user.username, token: token }));
    } catch (_) {}
  }

  function _loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function _clearSession() {
    _token       = null;
    _currentUser = null;
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch (_) {}
  }

  // ── XSS protection ────────────────────────────────────────────────────
  function _escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── LicenseManager integration ────────────────────────────────────────
  function _activateLicense(token, email) {
    try {
      if (window.LicenseManager && typeof window.LicenseManager.activate === 'function') {
        window.LicenseManager.activate(token, email);
      }
    } catch (_) {}
  }

  function _deactivateLicense() {
    try {
      if (window.LicenseManager && typeof window.LicenseManager.deactivate === 'function') {
        window.LicenseManager.deactivate();
      }
    } catch (_) {}
  }

  // ── DOM helpers ───────────────────────────────────────────────────────
  function _renderLoginOverlay() {
    if (document.getElementById('authOverlay')) return;

    var overlay = document.createElement('div');
    overlay.id = 'authOverlay';
    overlay.innerHTML =
      '<form id="authForm">' +
      '<input id="authUser" type="text" placeholder="Username" autocomplete="username" />' +
      '<input id="authPass" type="password" placeholder="Password" autocomplete="current-password" />' +
      '<button id="authSubmit" type="submit">Sign In</button>' +
      '<div id="authError"></div>' +
      '</form>';
    document.body.appendChild(overlay);

    document.getElementById('authForm').addEventListener('submit', _handleLogin);
  }

  function _removeLoginOverlay() {
    var overlay = document.getElementById('authOverlay');
    if (overlay) overlay.remove();
  }

  function _renderUserBadge(user) {
    var existing = document.getElementById('authBadge');
    if (existing) existing.remove();

    var badge = document.createElement('div');
    badge.id = 'authBadge';

    var adminHtml = user.role === 'admin'
      ? '<span class="auth-admin-label">ADMIN</span>'
      : '';

    badge.innerHTML =
      '<span class="auth-username">' + _escHtml(user.username) + '</span>' +
      '<span class="auth-tier">' + _escHtml(String(user.tier || '').toUpperCase()) + '</span>' +
      adminHtml +
      '<button id="authLogoutBtn">Logout</button>';

    document.body.appendChild(badge);

    var logoutBtn = document.getElementById('authLogoutBtn');
    if (logoutBtn) logoutBtn.addEventListener('click', logout);
  }

  function _removeUserBadge() {
    var badge = document.getElementById('authBadge');
    if (badge) badge.remove();
  }

  // ── Login form handler ────────────────────────────────────────────────
  async function _handleLogin(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();

    var userInput = document.getElementById('authUser');
    var passInput = document.getElementById('authPass');
    var submitBtn = document.getElementById('authSubmit');
    var errEl     = document.getElementById('authError');

    var username = (userInput && userInput.value) ? userInput.value.trim() : '';
    var password  = passInput ? passInput.value : '';

    if (!username || !password) {
      if (errEl) errEl.textContent = 'Please enter username and password';
      return;
    }

    if (submitBtn) {
      submitBtn.disabled    = true;
      submitBtn.textContent = 'Signing in...';
    }
    if (errEl) errEl.textContent = '';

    try {
      var res  = await fetch(API_BASE + '/login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ username: username, password: password }),
      });
      var data = await res.json();

      if (!data.success) {
        if (errEl) errEl.textContent = data.error || 'Login failed.';
        if (submitBtn) {
          submitBtn.disabled    = false;
          submitBtn.textContent = 'Sign In';
        }
        return;
      }

      // Successful login
      _saveSession(data.token, data.user);
      _activateLicense(data.token, data.user.email);
      _removeLoginOverlay();
      _renderUserBadge(data.user);

    } catch (err) {
      if (errEl) errEl.textContent = 'Network error — please try again.';
      if (submitBtn) {
        submitBtn.disabled    = false;
        submitBtn.textContent = 'Sign In';
      }
    }
  }

  // ── Public: logout ────────────────────────────────────────────────────
  function logout() {
    _deactivateLicense();
    _clearSession();
    _removeUserBadge();
    _renderLoginOverlay();
  }

  // ── Public: init ──────────────────────────────────────────────────────
  async function init() {
    var session = _loadSession();

    if (session && session.token) {
      try {
        var res = await fetch(API_BASE + '/me', {
          headers: { 'Authorization': 'Bearer ' + session.token },
        });

        if (res.ok) {
          var user   = await res.json();
          _token       = session.token;
          _currentUser = user;
          _activateLicense(session.token, user.email);
          _renderUserBadge(user);
          return;
        }

        _clearSession();
      } catch (_) {
        _clearSession();
      }
    }

    _renderLoginOverlay();
  }

  // ── Public API ────────────────────────────────────────────────────────
  var VIPAuth = {
    init:       init,
    isLoggedIn: function () { return !!_token; },
    getUser:    function () { return _currentUser; },
    isAdmin:    function () { return !!(_currentUser && _currentUser.role === 'admin'); },
    logout:     logout,
  };

  window.VIPAuth = VIPAuth;

})();

// Auto-init — call init() once the DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.VIPAuth.init(); });
} else {
  window.VIPAuth.init();
}
