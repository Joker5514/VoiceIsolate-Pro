/**
 * VoiceIsolate Pro — public/app/auth.js
 * Client-side authentication module.
 *
 * Talks to the Express API at /api/auth/*
 * Persists JWT in localStorage.
 * Integrates with LicenseManager (window.LicenseManager) if present.
 *
 * Usage (called from app.js after DOMContentLoaded):
 *   import Auth from './auth.js';
 *   Auth.init();
 */
'use strict';

const Auth = (() => {
  // ── Config ────────────────────────────────────────────────────────────
  const API_BASE   = '/api/auth';
  const TOKEN_KEY  = 'vip_auth_token';
  const USER_KEY   = 'vip_auth_user';

  // ── State ─────────────────────────────────────────────────────────────
  let _token = null;
  let _user  = null;
  let _modal = null;

  // ── DOM helpers ───────────────────────────────────────────────────────
  const el = id => document.getElementById(id);

  // ── Token persistence ─────────────────────────────────────────────────
  function _saveSession(token, user) {
    _token = token;
    _user  = user;
    try {
      localStorage.setItem(TOKEN_KEY, token);
      localStorage.setItem(USER_KEY, JSON.stringify(user));
    } catch (_) { /* private/incognito may block */ }
  }

  function _clearSession() {
    _token = null;
    _user  = null;
    try {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
    } catch (_) {}
  }

  function _restoreSession() {
    try {
      _token = localStorage.getItem(TOKEN_KEY);
      const raw = localStorage.getItem(USER_KEY);
      _user  = raw ? JSON.parse(raw) : null;
    } catch (_) {
      _token = null;
      _user  = null;
    }
  }

  // ── API calls ─────────────────────────────────────────────────────────
  async function _apiLogin(username, password) {
    const res = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    return res.json().then(data => ({ ok: res.ok, status: res.status, data }));
  }

  async function _apiMe() {
    if (!_token) return null;
    try {
      const res = await fetch(`${API_BASE}/me`, {
        headers: { 'Authorization': `Bearer ${_token}` },
      });
      if (!res.ok) return null;
      return res.json();
    } catch (_) { return null; }
  }

  async function _apiLogout() {
    if (!_token) return;
    try {
      await fetch(`${API_BASE}/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${_token}` },
      });
    } catch (_) {}
  }

  // ── License integration ───────────────────────────────────────────────
  function _syncLicense(user) {
    if (!user) return;
    if (typeof window.LicenseManager !== 'undefined') {
      try {
        // Activate via token if LicenseManager supports it
        if (typeof window.LicenseManager.activateFromAuth === 'function') {
          window.LicenseManager.activateFromAuth(_token, user);
        } else if (typeof window.LicenseManager.setTier === 'function') {
          window.LicenseManager.setTier(user.tier);
        }
      } catch (e) {
        console.warn('[Auth] LicenseManager sync failed:', e);
      }
    }
  }

  // ── UI: Modal ─────────────────────────────────────────────────────────
  function _injectModal() {
    if (el('vip-auth-modal')) return; // already injected

    // Inject styles
    const style = document.createElement('style');
    style.textContent = `
      #vip-auth-modal {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(10,8,12,0.94); backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center;
        font-family: 'Segoe UI', system-ui, sans-serif;
      }
      #vip-auth-modal.vip-hidden { display: none !important; }
      .vip-auth-card {
        background: #1e1e26; border: 1px solid rgba(220,38,38,.25);
        border-radius: 12px; padding: 32px 28px; width: 100%; max-width: 360px;
        display: flex; flex-direction: column; gap: 14px;
        box-shadow: 0 0 48px rgba(220,38,38,.12);
        color: #f0f0f2;
      }
      .vip-auth-logo { text-align: center; }
      .vip-auth-logo .vip-title { display: block; font-size: 20px; font-weight: 800; color: #ef4444; }
      .vip-auth-logo .vip-sub   { display: block; font-size: 11px; color: #888; margin-top: 3px; }
      .vip-auth-field {
        display: flex; flex-direction: column; gap: 8px;
      }
      .vip-auth-field input {
        background: #0c0c10; border: 1px solid rgba(220,38,38,.2);
        color: #f0f0f2; border-radius: 7px; padding: 10px 12px;
        font-size: 13px; outline: none; width: 100%; box-sizing: border-box;
        transition: border-color .15s;
      }
      .vip-auth-field input:focus { border-color: #dc2626; }
      .vip-auth-btns { display: flex; gap: 8px; }
      .vip-auth-btn {
        flex: 1; padding: 10px; border-radius: 7px; font-size: 13px;
        font-weight: 700; cursor: pointer; border: none; transition: .15s;
      }
      .vip-btn-primary   { background: #dc2626; color: #fff; }
      .vip-btn-primary:hover:not(:disabled) { background: #ef4444; }
      .vip-btn-secondary { background: transparent; color: #f0f0f2; border: 1px solid rgba(220,38,38,.3); }
      .vip-btn-secondary:hover:not(:disabled) { border-color: #dc2626; color: #ef4444; }
      .vip-auth-btn:disabled { opacity: .4; cursor: not-allowed; }
      .vip-auth-status {
        font-size: 12px; text-align: center; min-height: 16px;
        padding: 6px 10px; border-radius: 5px;
      }
      .vip-status-error { background: rgba(220,38,38,.12); color: #ef4444; }
      .vip-status-warn  { background: rgba(245,158,11,.1);  color: #f59e0b; }
      .vip-status-ok    { background: rgba(16,185,129,.12); color: #10b981; }
      .vip-auth-hint { font-size: 10px; color: #555; text-align: center; line-height: 1.5; }
      #vip-user-badge {
        display: none; align-items: center; gap: 8px;
        font-size: 11px; color: #888; padding: 0 4px;
      }
      #vip-user-badge.vip-visible { display: flex; }
      #vip-user-name { color: #06b6d4; font-weight: 700; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #vip-user-tier { font-size: 10px; color: #ef4444; font-weight: 700; }
      #vip-signout-btn {
        background: transparent; border: 1px solid rgba(220,38,38,.2);
        color: #666; font-size: 10px; padding: 2px 7px; border-radius: 4px;
        cursor: pointer; transition: .15s;
      }
      #vip-signout-btn:hover { border-color: #dc2626; color: #ef4444; }
    `;
    document.head.appendChild(style);

    // Modal HTML
    const modal = document.createElement('div');
    modal.id = 'vip-auth-modal';
    modal.innerHTML = `
      <div class="vip-auth-card">
        <div class="vip-auth-logo">
          <span class="vip-title">VoiceIsolate Pro</span>
          <span class="vip-sub">Engineer Mode — Sign In</span>
        </div>

        <div class="vip-auth-field">
          <input id="vip-username" type="text"     placeholder="Username" autocomplete="username"         />
          <input id="vip-password" type="password" placeholder="Password" autocomplete="current-password"/>
        </div>

        <div class="vip-auth-btns">
          <button id="vip-login-btn"  class="vip-auth-btn vip-btn-primary"  >Sign In</button>
          <button id="vip-guest-btn"  class="vip-auth-btn vip-btn-secondary">Guest</button>
        </div>

        <div id="vip-auth-status" class="vip-auth-status"></div>

        <div class="vip-auth-hint">
          Test accounts: <strong>joker5514</strong> / Admin8052 &nbsp;·&nbsp;
          test_pro / TestPro123 &nbsp;·&nbsp; test_free / TestFree123
        </div>
      </div>
    `;
    document.body.prepend(modal);
    _modal = modal;

    // User badge — inject into header if it exists
    const badge = document.createElement('div');
    badge.id = 'vip-user-badge';
    badge.innerHTML = `
      <span id="vip-user-name"></span>
      <span id="vip-user-tier"></span>
      <button id="vip-signout-btn">Sign Out</button>
    `;
    const hdr = document.querySelector('#hdr, header, .header');
    if (hdr) hdr.appendChild(badge);
    else document.body.prepend(badge);

    // Bind events
    el('vip-login-btn')?.addEventListener('click', _handleLogin);
    el('vip-guest-btn')?.addEventListener('click', _handleGuest);
    el('vip-signout-btn')?.addEventListener('click', _handleSignOut);
    el('vip-password')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') _handleLogin();
    });
  }

  function _showModal() {
    _modal?.classList.remove('vip-hidden');
  }

  function _hideModal() {
    _modal?.classList.add('vip-hidden');
  }

  function _setStatus(msg, type = 'warn') {
    const statusEl = el('vip-auth-status');
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.className = `vip-auth-status vip-status-${type}`;
  }

  function _setButtonsDisabled(disabled) {
    const loginBtn = el('vip-login-btn');
    const guestBtn = el('vip-guest-btn');
    if (loginBtn) loginBtn.disabled = disabled;
    if (guestBtn) guestBtn.disabled = disabled;
  }

  function _renderBadge(user) {
    const badge  = el('vip-user-badge');
    const nameEl = el('vip-user-name');
    const tierEl = el('vip-user-tier');
    if (!badge) return;
    if (user) {
      if (nameEl) nameEl.textContent = user.username || 'User';
      if (tierEl) tierEl.textContent = user.tier || '';
      badge.classList.add('vip-visible');
    } else {
      badge.classList.remove('vip-visible');
    }
  }

  // ── Event handlers ────────────────────────────────────────────────────
  async function _handleLogin() {
    const username = el('vip-username')?.value?.trim();
    const password = el('vip-password')?.value;

    if (!username || !password) {
      _setStatus('Username and password are required.', 'error');
      return;
    }

    _setButtonsDisabled(true);
    _setStatus('Signing in…', 'warn');

    try {
      const { ok, data } = await _apiLogin(username, password);

      if (!ok) {
        _setStatus(data?.error || 'Login failed. Check credentials.', 'error');
        _setButtonsDisabled(false);
        return;
      }

      _saveSession(data.token, data.user);
      _syncLicense(data.user);
      _setStatus(`Welcome, ${data.user.username}!`, 'ok');
      _renderBadge(data.user);

      setTimeout(() => _hideModal(), 800);
    } catch (err) {
      _setStatus('Network error — server unreachable.', 'error');
      console.error('[Auth] login error:', err);
      _setButtonsDisabled(false);
    }
  }

  function _handleGuest() {
    const guestUser = { username: 'Guest', tier: 'FREE', role: 'guest', id: 'guest' };
    _saveSession('guest_token', guestUser);
    _syncLicense(guestUser);
    _renderBadge(guestUser);
    _hideModal();
  }

  async function _handleSignOut() {
    await _apiLogout();
    _clearSession();
    _renderBadge(null);
    // Clear password field
    const passEl = el('vip-password');
    if (passEl) passEl.value = '';
    _setStatus('', '');
    _setButtonsDisabled(false);
    _showModal();
  }

  // ── Public API ────────────────────────────────────────────────────────
  async function init() {
    _injectModal();
    _restoreSession();

    if (_token && _token !== 'guest_token') {
      // Validate token is still good against the server
      const user = await _apiMe();
      if (user) {
        _user = user;
        _syncLicense(user);
        _renderBadge(user);
        _hideModal();
        return;
      }
      // Token expired/invalid — clear and show modal
      _clearSession();
    } else if (_token === 'guest_token' && _user) {
      _syncLicense(_user);
      _renderBadge(_user);
      _hideModal();
      return;
    }

    // No valid session — show login
    _showModal();
  }

  return {
    init,
    get currentUser()  { return _user; },
    get token()        { return _token; },
    get isLoggedIn()   { return !!_token; },
    get isGuest()      { return _token === 'guest_token'; },
    signOut: _handleSignOut,
  };
})();

export default Auth;
