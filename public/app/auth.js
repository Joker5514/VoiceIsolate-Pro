// ─────────────────────────────────────────────────────────────────────────────
//  auth.js  —  VoiceIsolate Pro v24.0 / Threads from Space v12
//  auth.js  —  VoiceIsolate Pro v24.0 · Threads from Space v12
//  100% local, tab-scoped session. No network calls. No cookies.
//  SHA-256 password hashing via SubtleCrypto (built into every modern browser).
// ─────────────────────────────────────────────────────────────────────────────

// ── 1. User Credential Store ─────────────────────────────────────────────────
// To generate a SHA-256 hash in DevTools:
//   const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('yourpassword'));
//   console.log([...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,'0')).join(''));
//
// Passwords match the seeded accounts in api/auth.js for consistency.

const USERS = [
  {
    username:     'joker5514',
    displayName:  'Randy Jordan',
    passHash:     'fc157fd1df28bbac5e71f6c38d64c6ecae40f45318a866989947196aba244c03', // SHA-256("Admin8052")
    tier:         'ENTERPRISE',
    role:         'admin',
    filesUsed:    0,
    filesAllowed: Infinity,
  },
  {
    username:     'test_free',
    displayName:  'Free Test User',
    passHash:     '7d2d9e1ce9bf847d900f72ab5da00972d584b41fec53854d05488acc979ea27a', // SHA-256("TestFree123")
    tier:         'FREE',
    role:         'user',
    filesUsed:    0,
    filesAllowed: Infinity,
  },
  {
    username:     'test_pro',
    displayName:  'Pro Test User',
    passHash:     '7461f3545d99833b86bd16c4ccdeaa8c413158cd66befb95296be110307ef950', // SHA-256("TestPro123")
    tier:         'PRO',
    role:         'user',
    filesUsed:    0,
    filesAllowed: 50,
  },
  {
    username:     'test_studio',
    displayName:  'Studio Test User',
    passHash:     '30f8dc347b710b75c826f3f4a157ec2c3fcdfb3d2b7b1bb098ba2e65c7f5290f', // SHA-256("TestStudio123")
    tier:         'STUDIO',
    role:         'user',
    filesUsed:    0,
    filesAllowed: Infinity,
  },
  {
    username:     'test_enterprise',
    displayName:  'Enterprise Test User',
    passHash:     '3d1a00956888609e2555f4bb4d49c3365c47fc05cd97384b79ec67b887a44078', // SHA-256("TestEnterprise123")
    tier:         'ENTERPRISE',
    role:         'user',
    filesUsed:    0,
    filesAllowed: Infinity,
  },
  {
    username:     'demo',
    displayName:  'Demo User',
    passHash:     '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', // SHA-256("hello")
    tier:         'FREE',
    role:         'user',
    filesUsed:    0,
    filesAllowed: Infinity,

// ── 2. Tier Capability Map ───────────────────────────────────────────────────
const TIER_CAPS = {
  FREE: {
    maxFileSizeMB:   Infinity,
    filesPerMonth:   Infinity,
    maxStages:       8,
    mlModels:        [],
    exportFormats:   ['wav'],
    batchMax:        1,
    liveMode:        true,
    engineerPanel:   false,
    forensicMode:    false,
  },
  PRO: {
    maxFileSizeMB:   Infinity,
    filesPerMonth:   50,
    maxStages:       18,
    mlModels:        ['silero-vad', 'rnnoise'],
    exportFormats:   ['wav', 'flac', 'opus'],
    batchMax:        5,
    liveMode:        true,
    engineerPanel:   true,
    forensicMode:    false,
  },
  STUDIO: {
    maxFileSizeMB:   Infinity,
    filesPerMonth:   Infinity,
    maxStages:       32,
    mlModels:        ['silero-vad', 'rnnoise', 'demucs-v4', 'ecapa-tdnn'],
    exportFormats:   ['wav', 'flac', 'opus', 'mp3'],
    batchMax:        50,
    liveMode:        true,
    engineerPanel:   true,
    forensicMode:    false,
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
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(str)
  );
  return [...new Uint8Array(buf)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function saveSession(user) {
  const sess = {
    username:    user.username,
    displayName: user.displayName,
    tier:        user.tier,
    role:        user.role,
    filesUsed:   user.filesUsed,
    loginTime:   Date.now(),
  };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
  return sess;
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
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
    @keyframes auth-shake {
      0%,100%{transform:translateX(0)}
      20%,60%{transform:translateX(-8px)}
      40%,80%{transform:translateX(8px)}
    }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement('div');
  overlay.id = 'vip-auth-overlay';
  overlay.innerHTML = `
    <div id="vip-auth-box">
      <h2>🎙 VoiceIsolate Pro v24.0</h2>
      <h2>🎙 VoiceIsolate Pro</h2>
      <p>Threads from Space v12 · Sign in to continue</p>
      <div class="vip-auth-field">
        <label for="vip-username">Username</label>
        <input id="vip-username" type="text" autocomplete="username"
               placeholder="your username" spellcheck="false" />
      </div>
      <div class="vip-auth-field">
        <label for="vip-password">Password</label>
        <input id="vip-password" type="password" autocomplete="current-password"
               placeholder="••••••••" />
      </div>
      <button id="vip-auth-submit">Sign In</button>
      <div id="vip-auth-error"></div>
      <div class="vip-auth-tier-hint">
        <strong style="color:#f3f3f5">Test accounts:</strong>
        joker5514 (ENTERPRISE · admin) &nbsp;·&nbsp;
        test_enterprise / test_studio / test_pro / test_free / demo
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  return overlay;
}

// ── 5. Core: requireAuth ─────────────────────────────────────────────────────
/**
 * Call at the top of app.js (with await, at module top-level).
 * Returns the session object if already logged in, or
 * shows the login modal and resolves when auth succeeds.
 */
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
      const user = USERS.find(
        u => u.username === username && u.passHash === hash
      );

      if (!user) {
        errEl.textContent = 'Invalid credentials. Try again.';
        const box = document.getElementById('vip-auth-box');
        box.style.animation = 'auth-shake 0.4s ease';
        setTimeout(() => { box.style.animation = ''; }, 400);
        return;
      }

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

    setTimeout(() => document.getElementById('vip-username')?.focus(), 80);
  });
}

// ── 6. Logout ────────────────────────────────────────────────────────────────
export function logout() {
  clearSession();
  window.location.reload();
}

// ── 7. Capability Accessors ──────────────────────────────────────────────────
export function getCaps(tier) {
  const sess = loadSession();
  const t = tier || sess?.tier || 'FREE';
  return TIER_CAPS[t] || TIER_CAPS.FREE;
}

export function canUseModel(modelId) {
  return getCaps().mlModels.includes(modelId);
}

export function getAllowedStages() {
  return getCaps().maxStages;
}

export function checkFileSizeLimit(sizeMB) {
  const caps = getCaps();
  return caps.maxFileSizeMB === Infinity || sizeMB <= caps.maxFileSizeMB;
}

export function checkFilesRemaining() {
  const sess = loadSession();
  if (!sess) return false;
  const caps = getCaps(sess.tier);
  if (caps.filesPerMonth === Infinity) return true;
  return sess.filesUsed < caps.filesPerMonth;
}

export function incrementFileUsage() {
  const sess = loadSession();
  if (!sess) return;
  sess.filesUsed = (sess.filesUsed || 0) + 1;
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(sess));
}

// ── 8. DOM Tier Enforcement ───────────────────────────────────────────────────
/**
 * Walks the DOM and applies tier-gate locking to elements with
 * data-requires-tier="STUDIO" (or PRO, ENTERPRISE).
 * Also shows/hides admin, engineer, forensic UI sections.
 */
export function applyTierToDOM(tier, role) {
  const tierIdx = TIER_ORDER.indexOf(tier);

  const badge = document.getElementById('tier-badge');
  if (badge) {
    badge.textContent = tier;
    const colors = {
      FREE:       '#888',
      PRO:        '#10b981',
      STUDIO:     '#6366f1',
      ENTERPRISE: '#f59e0b',
    };
    badge.style.background = colors[tier] || '#888';
    badge.style.color = tier === 'FREE' ? '#111' : '#fff';
  }

  const sess = loadSession();
  const userDisplay = document.getElementById('user-display');
  if (userDisplay && sess) userDisplay.textContent = `${sess.displayName} (${tier})`;

  document.querySelectorAll('[data-requires-tier]').forEach(el => {
    const required = el.getAttribute('data-requires-tier');
    const reqIdx   = TIER_ORDER.indexOf(required);
    if (tierIdx < reqIdx) {
      el.classList.add('tier-locked');
      el.setAttribute('disabled', 'disabled');
      el.title = `Requires ${required} tier`;
    } else {
      el.classList.remove('tier-locked');
      el.removeAttribute('disabled');
    }
  });

  const engPanel = document.getElementById('engineer-panel');
  if (engPanel) engPanel.style.display = TIER_CAPS[tier]?.engineerPanel ? 'block' : 'none';

  const forensicBtn = document.getElementById('btn-forensic-mode');
  if (forensicBtn) forensicBtn.style.display = TIER_CAPS[tier]?.forensicMode ? 'inline-flex' : 'none';

  const adminPanel = document.getElementById('admin-panel');
  if (adminPanel) adminPanel.style.display = role === 'admin' ? 'block' : 'none';

  const mlTab = document.querySelector('[data-tab="ml"]');
  if (mlTab) mlTab.style.display = TIER_CAPS[tier]?.mlModels?.length > 0 ? 'inline-flex' : 'none';
}
