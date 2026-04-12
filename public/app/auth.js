/**
 * VoiceIsolate Pro — Client Auth Module v22
 *
 * Handles login UI, session persistence (localStorage), and LicenseManager integration.
 * On successful login the JWT is passed to LicenseManager.activate() so the
 * tier-based feature gates and file limits work automatically.
 *
 * Storage key: vip_auth_v22 (username, token)
 */

/* global LicenseManager */

const VIPAuth = (() => {
  'use strict';

  const STORAGE_KEY = 'vip_auth_v22';
  let _currentUser = null;

  // ─── DOM helpers ─────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function _hide(el) { if (el) el.style.display = 'none'; }
  function _show(el, display) { if (el) el.style.display = display || 'flex'; }

  // ─── API calls ───────────────────────────────────────────────────────────────
  async function _login(username, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return res.json();
  }

  async function _fetchMe(token) {
    const res = await fetch('/api/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token },
    });
    if (!res.ok) return null;
    return res.json();
  }

  // ─── Session persistence ─────────────────────────────────────────────────────
  function _saveSession(username, token) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ username, token }));
    } catch { /* storage unavailable */ }
  }

  function _loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function _clearSession() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ok */ }
  }

  // ─── UI rendering ───────────────────────────────────────────────────────────
  function _renderLoginOverlay() {
    // Don't duplicate
    if ($('authOverlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'authOverlay';
    overlay.innerHTML = `
      <div class="auth-modal">
        <div class="auth-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M12 1v22M8 5v14M4 9v6M16 5v14M20 9v6"/>
          </svg>
        </div>
        <h2 class="auth-title">VoiceIsolate Pro</h2>
        <p class="auth-subtitle">Sign in to continue</p>
        <form id="authForm" autocomplete="on">
          <div class="auth-field">
            <label for="authUser">Username</label>
            <input type="text" id="authUser" name="username" autocomplete="username" spellcheck="false" required />
          </div>
          <div class="auth-field">
            <label for="authPass">Password</label>
            <input type="password" id="authPass" name="password" autocomplete="current-password" required />
          </div>
          <div id="authError" class="auth-error"></div>
          <button type="submit" id="authSubmit" class="auth-btn">Sign In</button>
        </form>
      </div>
    `;
    document.body.appendChild(overlay);

    $('authForm').addEventListener('submit', _handleLogin);
  }

  function _renderUserBadge(user) {
    // Remove existing badge
    const existing = $('authBadge');
    if (existing) existing.remove();

    const badge = document.createElement('div');
    badge.id = 'authBadge';
    badge.className = 'auth-badge';
    const tierClass = 'auth-tier-' + (user.tier || 'free').toLowerCase();
    badge.innerHTML = `
      <span class="auth-badge-user">${_escHtml(user.username)}</span>
      <span class="auth-badge-tier ${tierClass}">${(user.tier || 'FREE').toUpperCase()}</span>
      ${user.role === 'admin' ? '<span class="auth-badge-admin">ADMIN</span>' : ''}
      <button id="authLogoutBtn" class="auth-logout-btn" title="Sign out">&#x2715;</button>
    `;

    // Insert into header
    const hdr = document.querySelector('.hdr');
    if (hdr) {
      const toggle = $('statsToggle');
      if (toggle) hdr.insertBefore(badge, toggle);
      else hdr.appendChild(badge);
    }

    $('authLogoutBtn').addEventListener('click', _handleLogout);
  }

  function _escHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  // ─── Event handlers ──────────────────────────────────────────────────────────
  async function _handleLogin(e) {
    e.preventDefault();
    const btn = $('authSubmit');
    const errEl = $('authError');
    const username = $('authUser').value.trim();
    const password = $('authPass').value;

    if (!username || !password) {
      errEl.textContent = 'Please enter username and password.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Signing in...';
    errEl.textContent = '';

    try {
      const data = await _login(username, password);
      if (!data.success) {
        errEl.textContent = data.error || 'Login failed.';
        btn.disabled = false;
        btn.textContent = 'Sign In';
        return;
      }

      _currentUser = data.user;
      _saveSession(data.user.username, data.token);

      // Activate license via LicenseManager
      if (window.LicenseManager && typeof window.LicenseManager.activate === 'function') {
        window.LicenseManager.activate(data.token, data.user.email);
      }

      // Remove overlay, show badge
      const overlay = $('authOverlay');
      if (overlay) overlay.remove();
      _renderUserBadge(data.user);

    } catch (err) {
      errEl.textContent = 'Network error. Is the server running?';
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  }

  function _handleLogout() {
    _currentUser = null;
    _clearSession();

    // Deactivate license
    if (window.LicenseManager && typeof window.LicenseManager.deactivate === 'function') {
      window.LicenseManager.deactivate();
    }

    // Remove badge, show login
    const badge = $('authBadge');
    if (badge) badge.remove();
    _renderLoginOverlay();
  }

  // ─── Init ────────────────────────────────────────────────────────────────────
  async function init() {
    const session = _loadSession();
    if (session && session.token) {
      // Try to restore session
      try {
        const me = await _fetchMe(session.token);
        if (me && me.username) {
          _currentUser = me;

          // Re-activate license from stored token
          if (window.LicenseManager && typeof window.LicenseManager.activate === 'function') {
            window.LicenseManager.activate(session.token, me.email);
          }

          _renderUserBadge(me);
          return;
        }
      } catch { /* server unavailable — fall through to login */ }
    }

    // No valid session — show login
    _renderLoginOverlay();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────
  return {
    init,
    getUser() { return _currentUser; },
    isLoggedIn() { return !!_currentUser; },
    isAdmin() { return _currentUser && _currentUser.role === 'admin'; },
    logout: _handleLogout,
  };
})();

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => VIPAuth.init());
} else {
  VIPAuth.init();
}
