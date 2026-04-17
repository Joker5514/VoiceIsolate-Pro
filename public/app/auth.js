// ─────────────────────────────────────────────────────────────────────────────
//  auth.js  —  VoiceIsolate Pro v24.0 / Threads from Space v12
//  100% local, tab-scoped session. No network calls. No cookies.
//  SHA-256 password hashing via SubtleCrypto (built into every modern browser).
//  DEV/TEST MODE: All sessions forced to ENTERPRISE tier — no limits.
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. User Credential Store ─────────────────────────────────────────────────
const USERS = [
  {
    username:     'joker5514',
    displayName:  'Randy Jordan',
    passHash:     'fc157fd1df28bbac5e71f6c38d64c6ecae40f45318a866989947196aba244c03',
    tier:         'ENTERPRISE',
    role:         'admin',
    filesUsed:    0,
    filesAllowed: Infinity,
  },
  {
    username:     'test_free',
    displayName:  'Free Test User',
    passHash:     '7d2d9e1ce9bf847d900f72ab5da00972d584b41fec53854d05488acc979ea27a',
    tier:         'ENTERPRISE', // forced up for testing
    role:         'user',
    filesUsed:    0,
    filesAllowed: Infinity,
  },
  {
    username:     'test_pro',
    displayName:  'Pro Test User',
    passHash:     '7461f3545d99833b86bd16c4ccdeaa8c413158cd66befb95296be110307ef950',
    tier:         'ENTERPRISE', // forced up for testing
    role:         'user',
    filesUsed:    0,
    filesAllowed: Infinity,
  },
  {
    username:     'test_studio',
    displayName:  'Studio Test User',
    passHash:     '30f8dc347b710b75c826f3f4a157ec2c3fcdfb3d2b7b1bb098ba2e65c7f5290f',
    tier:         'ENTERPRISE', // forced up for testing
    role:         'user',
    filesUsed:    0,
    filesAllowed: Infinity,
  },
  {
    username:     'test_enterprise',
    displayName:  'Enterprise Test User',
    passHash:     '3d1a00956888609e2555f4bb4d49c3365c47fc05cd97384b79ec67b887a44078',
    tier:         'ENTERPRISE',
    role:         'user',
    filesUsed:    0,
    filesAllowed: Infinity,
  },
  {
    username:     'demo',
    displayName:  'Demo User',
    passHash:     '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    tier:         'ENTERPRISE', // forced up for testing
    role:         'user',
    filesUsed:    0,
    filesAllowed: Infinity,
  },
];

// ── 2. Tier Capability Map ───────────────────────────────────────────────────
const TIER_CAPS = {
  FREE: {
    maxFileSizeMB:   Infinity,
    filesPerMonth:   Infinity,
    maxStages:       32,
    mlModels:        ['silero-vad', 'rnnoise', 'demucs-v4', 'ecapa-tdnn', 'voicefixer'],
    exportFormats:   ['wav', 'flac', 'opus', 'mp3', 'mov'],
    batchMax:        1000,
    liveMode:        true,
    engineerPanel:   true,
    forensicMode:    true,
  },
  PRO: {
    maxFileSizeMB:   Infinity,
    filesPerMonth:   Infinity,
    maxStages:       32,
    mlModels:        ['silero-vad', 'rnnoise', 'demucs-v4', 'ecapa-tdnn', 'voicefixer'],
    exportFormats:   ['wav', 'flac', 'opus', 'mp3', 'mov'],
    batchMax:        1000,
    liveMode:        true,
    engineerPanel:   true,
    forensicMode:    true,
  },
  STUDIO: {
    maxFileSizeMB:   Infinity,
    filesPerMonth:   Infinity,
    maxStages:       32,
    mlModels:        ['silero-vad', 'rnnoise', 'demucs-v4', 'ecapa-tdnn', 'voicefixer'],
    exportFormats:   ['wav', 'flac', 'opus', 'mp3', 'mov'],
    batchMax:        1000,
    liveMode:        true,
    engineerPanel:   true,
    forensicMode:    true,
  },
  ENTERPRISE: {
    maxFileSizeMB:   Infinity,
    filesPerMonth:   Infinity,
    maxStages:       32,
    mlModels:        ['silero-vad', 'rnnoise', 'demucs-v4', 'ecapa-tdnn', 'voicefixer'],
    exportFormats:   ['wav', 'flac', 'opus', 'mp3', 'mov'],
    batchMax:        1000,
    liveMode:        true,
    engineerPanel:   true,
    forensicMode:    true,
  },
};

const TIER_ORDER = ['FREE', 'PRO', 'STUDIO', 'ENTERPRISE'];

// ── 3. Internal helpers ──────────────────────────────────────────────────────
const SESSION_KEY = 'vip_session_v1';

async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function saveSession(user) {
  const sess = {
    username:    user.username,
    displayName: user.displayName,
    tier:        'ENTERPRISE', // ALWAYS force ENTERPRISE during testing
    role:        user.role,
    filesUsed:   0,
    loginTime:   Date.now(),
  };
  // Save to BOTH sessionStorage and localStorage so login persists across refreshes
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess)); } catch {}
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(sess)); } catch {}
  return sess;
}

function loadSession() {
  try {
    // Try sessionStorage first, fall back to localStorage (survives page refresh)
    const raw = sessionStorage.getItem(SESSION_KEY) || localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const sess = JSON.parse(raw);
    // Always force ENTERPRISE tier — never let a stale session downgrade
    sess.tier = 'ENTERPRISE';
    // Sync back so it's always current
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess)); } catch {}
    return sess;
  } catch {
    return null;
  }
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch {}
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// ── 4. DOM: Login Modal ──────────────────────────────────────────────────────
function renderLoginModal() {
  const style = document.createElement('style');
  style.textContent = `
    #vip-auth-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.85);
      display: flex; align-items: center; justify-content: center;
      z-index: 99999; font-family: system-ui, sans-serif;
    }
    #vip-auth-box {
      background: #111318; border: 1px solid #dc2626;
      border-radius: 16px; padding: 36px 32px; width: 380px;
      box-shadow: 0 0 60px rgba(220,38,38,0.25);
    }
    #vip-auth-box h2 { margin: 0 0 6px; font-size: 1.4rem; color: #f3f3f5; }
    #vip-auth-box p  { margin: 0 0 24px; font-size: 0.82rem; color: #8a8aa0; }
    .vip-auth-field { margin-bottom: 16px; }
    .vip-auth-field label {
      display: block; font-size: 0.8rem; color: #8a8aa0; margin-bottom: 6px;
    }
    .vip-auth-field input {
      width: 100%; padding: 10px 14px; box-sizing: border-box;
      background: #0b0b10; border: 1px solid rgba(220,38,38,0.3);
      border-radius: 8px; color: #f3f3f5; font-size: 0.95rem;
      outline: none; transition: border-color 0.2s;
    }
    .vip-auth-field input:focus { border-color: #dc2626; }
    #vip-auth-submit {
      width: 100%; padding: 12px; background: #dc2626;
      border: none; border-radius: 8px; color: #fff;
      font-size: 1rem; font-weight: 700; cursor: pointer;
      transition: background 0.2s;
    }
    #vip-auth-submit:hover { background: #ef4444; }
    #vip-auth-error {
      margin-top: 12px; font-size: 0.82rem; color: #ef4444;
      text-align: center; min-height: 18px;
    }
    .vip-auth-tier-hint {
      margin-top: 20px; padding: 10px 12px;
      background: rgba(220,38,38,0.08);
      border: 1px solid rgba(220,38,38,0.2);
      border-radius: 8px; font-size: 0.76rem; color: #8a8aa0;
    }
    .vip-dev-badge {
      display: inline-block; margin-bottom: 12px;
      padding: 3px 10px; border-radius: 20px;
      background: rgba(245,158,11,0.15); border: 1px solid rgba(245,158,11,0.4);
      color: #f59e0b; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em;
    }
    @keyframes auth-shake {
      0%,100%{transform:translateX(0)}
      20%,60%{transform:translateX(-8px)}
      40%,80%{transform:translateX(8px)}
    }
  `;
  document.head.appendChild(style);

  // Pre-fill last used username from localStorage
  const lastUser = (() => { try { return localStorage.getItem('vip_last_user') || ''; } catch { return ''; } })();

  const overlay = document.createElement('div');
  overlay.id = 'vip-auth-overlay';
  overlay.innerHTML = `
    <div id="vip-auth-box">
      <div class="vip-dev-badge">⚡ DEV MODE · ALL LIMITS DISABLED · ENTERPRISE</div>
      <h2>🎙 VoiceIsolate Pro v24.0</h2>
      <p>Threads from Space v12 · Sign in to continue</p>
      <div class="vip-auth-field">
        <label for="vip-username">Username</label>
        <input id="vip-username" type="text" autocomplete="username"
               placeholder="your username" spellcheck="false" value="${lastUser}" />
      </div>
      <div class="vip-auth-field">
        <label for="vip-password">Password</label>
        <input id="vip-password" type="password" autocomplete="current-password"
               placeholder="••••••••" />
      </div>
      <button id="vip-auth-submit">Sign In → Enterprise</button>
      <div id="vip-auth-error"></div>
      <div class="vip-auth-tier-hint">
        <strong style="color:#f3f3f5">Quick access:</strong><br/>
        joker5514 / Admin8052 &nbsp;·&nbsp; demo / hello<br/>
        test_enterprise / TestEnterprise123
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

// ── 5. Core: requireAuth ─────────────────────────────────────────────────────
export async function requireAuth() {
  const existing = loadSession();
  if (existing) {
    applyTierToDOM(existing.tier, existing.role);
    return existing;
  }

  return new Promise((resolve) => {
    const overlay = renderLoginModal();

    async function attemptLogin() {
      const username = document.getElementById('vip-username').value.trim();
      const password = document.getElementById('vip-password').value;
      const errEl    = document.getElementById('vip-auth-error');

      if (!username || !password) {
        errEl.textContent = 'Please enter username and password.';
        return;
      }

      const hash = await sha256(password);
      const user = USERS.find(u => u.username === username && u.passHash === hash);

      if (!user) {
        errEl.textContent = 'Invalid credentials. Try again.';
        const box = document.getElementById('vip-auth-box');
        box.style.animation = 'auth-shake 0.4s ease';
        setTimeout(() => { box.style.animation = ''; }, 400);
        return;
      }

      // Remember username for next time
      try { localStorage.setItem('vip_last_user', username); } catch {}

      const sess = saveSession(user);
      overlay.remove();
      applyTierToDOM(sess.tier, sess.role);
      window.dispatchEvent(new CustomEvent('auth:login', { detail: sess }));
      resolve(sess);
    }

    document.getElementById('vip-auth-submit').addEventListener('click', attemptLogin);
    document.getElementById('vip-password').addEventListener('keydown', e => {
      if (e.key === 'Enter') attemptLogin();
    });
    document.getElementById('vip-username').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('vip-password').focus();
    });

    // Auto-focus password if username already filled
    setTimeout(() => {
      const uEl = document.getElementById('vip-username');
      if (uEl && uEl.value) document.getElementById('vip-password')?.focus();
      else uEl?.focus();
    }, 80);
  });
}

// ── 6. Logout ────────────────────────────────────────────────────────────────
export function logout() {
  clearSession();
  window.location.reload();
}

// ── 7. Capability Accessors ──────────────────────────────────────────────────
export function getCaps(tier) {
  // Always return ENTERPRISE caps regardless of tier argument
  return TIER_CAPS['ENTERPRISE'];
}

export function canUseModel(modelId) {
  return true; // all models unlocked
}

export function getAllowedStages() {
  return 32; // max stages always
}

export function checkFileSizeLimit(sizeMB) {
  return true; // no file size limit
}

export function checkFilesRemaining() {
  return true; // unlimited files
}

export function incrementFileUsage() {
  // no-op during testing — don't count against any quota
}

// ── 8. DOM Tier Enforcement ───────────────────────────────────────────────────
export function applyTierToDOM(tier, role) {
  // Always enforce ENTERPRISE visually regardless of passed tier
  const forcedTier = 'ENTERPRISE';
  const forcedRole = role || 'admin';

  // Update tier badge
  const badge = document.getElementById('tier-badge');
  if (badge) {
    badge.textContent = '⚡ ENTERPRISE';
    badge.style.background = '#f59e0b';
    badge.style.color = '#111';
  }

  // Update user display
  const sess = loadSession();
  const userDisplay = document.getElementById('user-display');
  if (userDisplay && sess) {
    userDisplay.textContent = `${sess.displayName} · ENTERPRISE`;
  }

  // Unlock ALL tier-gated elements
  document.querySelectorAll('[data-requires-tier]').forEach(el => {
    el.classList.remove('tier-locked');
    el.removeAttribute('disabled');
    el.title = '';
  });

  // Show all panels
  const engPanel = document.getElementById('engineer-panel');
  if (engPanel) engPanel.style.display = 'block';

  const forensicBtn = document.getElementById('btn-forensic-mode');
  if (forensicBtn) forensicBtn.style.display = 'inline-flex';

  const adminPanel = document.getElementById('admin-panel');
  if (adminPanel) adminPanel.style.display = forcedRole === 'admin' ? 'block' : 'none';

  const mlTab = document.querySelector('[data-tab="ml"]');
  if (mlTab) mlTab.style.display = 'inline-flex';
}

// ── 9. Auth object (non-module compat shim) ───────────────────────────────────
// Allows classic <script> files to call Auth.init(), Auth.isLoggedIn, etc.
const Auth = {
  currentUser: null,
  isLoggedIn: false,

  async init() {
    const sess = loadSession();
    if (sess) {
      this.currentUser = sess;
      this.isLoggedIn = true;
      applyTierToDOM(sess.tier, sess.role);
      return sess;
    }
    // No session — show login
    const result = await requireAuth();
    this.currentUser = result;
    this.isLoggedIn = true;
    return result;
  },

  logout() { logout(); },
  getCaps() { return getCaps(); },
  canUseModel(m) { return true; },
  checkFileSizeLimit() { return true; },
  checkFilesRemaining() { return true; },
  incrementFileUsage() {},
};

if (typeof window !== 'undefined') {
  window.Auth = Auth;
}
