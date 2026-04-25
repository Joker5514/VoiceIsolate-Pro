/**
 * VoiceIsolate Pro — Authentication API v24
 *
 * Endpoints:
 *   POST /api/auth/login   — Authenticate with username + password, returns JWT
 *   GET  /api/auth/me      — Get current user info from Bearer token
 *   POST /api/auth/logout  — Invalidate session (client-side only for now)
 *
 * Security model:
 *   - LICENSE_JWT_SECRET is required in production. In non-production we use a
 *     cryptographically-random per-process secret so preview/test deploys work,
 *     but the secret is never shared across processes or committed to git.
 *     Tokens signed with the random fallback won't validate after a redeploy.
 *   - No admin account is seeded from source. To provision an admin, set
 *     VIP_ADMIN_USERNAME + VIP_ADMIN_PASSWORD (and optionally VIP_ADMIN_EMAIL).
 *     These are read once at module load.
 *   - Test accounts (test_free/test_pro/test_studio/test_enterprise) are
 *     seeded only when NODE_ENV !== 'production'. Opt out with
 *     VIP_DISABLE_TEST_ACCOUNTS=1.
 */

import express from 'express';
import crypto  from 'crypto';

const router = express.Router();

// ─── Secret resolution ───────────────────────────────────────────────────────
// Production: env var is required. Non-production: fall back to a random
// per-process secret so preview/test deploys don't crash-start, and so the
// fallback is never reusable across processes or known to an attacker.
const LICENSE_SECRET = (() => {
  if (process.env.LICENSE_JWT_SECRET) return process.env.LICENSE_JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[api/auth] LICENSE_JWT_SECRET is required in production.');
  }
  const random = crypto.randomBytes(48).toString('base64url');
  console.warn(
    '[api/auth] WARNING: LICENSE_JWT_SECRET not set. Using random per-process secret. ' +
    'Tokens will not validate after restart. Set LICENSE_JWT_SECRET for stable tokens.'
  );
  return random;
})();

// ─── Password Hashing (scrypt) ───────────────────────────────────────────────
const SCRYPT_KEYLEN = 64;
const SCRYPT_OPTS   = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt    = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  return `${salt}:${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const derived  = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_OPTS);
  const expected = Buffer.from(hash, 'hex');
  return crypto.timingSafeEqual(derived, expected);
}

// ─── JWT Utilities ────────────────────────────────────────────────────────────
function createAuthToken(user) {
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub:      user.id,
    username: user.username,
    email:    user.email,
    tier:     user.tier.toLowerCase(),
    role:     user.role,
    iat:      Math.floor(Date.now() / 1000),
    exp:      Math.floor(Date.now() / 1000) + (365 * 86400),
    source:   'auth',
    jti:      crypto.randomBytes(8).toString('hex'),
  })).toString('base64url');
  const sig = crypto
    .createHmac('sha256', LICENSE_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function validateAuthToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expectedSig = crypto
      .createHmac('sha256', LICENSE_SECRET)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64url');
    if (!crypto.timingSafeEqual(
      Buffer.from(expectedSig, 'base64url'),
      Buffer.from(parts[2],    'base64url')
    )) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (Date.now() / 1000 > p.exp) return null;
    return p;
  } catch { return null; }
}

// ─── Seeded User Store ───────────────────────────────────────────────────────
const USERS = {};

function seedUser(id, username, email, password, tier, role = 'user') {
  USERS[username.toLowerCase()] = {
    id, username, email,
    passwordHash: hashPassword(password),
    tier, role,
    createdAt: new Date().toISOString(),
  };
}

// Admin account: seeded only when explicitly provisioned via env vars.
// Never hardcode credentials here.
if (process.env.VIP_ADMIN_USERNAME && process.env.VIP_ADMIN_PASSWORD) {
  seedUser(
    'usr_admin_001',
    process.env.VIP_ADMIN_USERNAME,
    process.env.VIP_ADMIN_EMAIL || 'admin@voiceisolatepro.com',
    process.env.VIP_ADMIN_PASSWORD,
    'ENTERPRISE',
    'admin'
  );
} else if (process.env.NODE_ENV === 'production') {
  console.warn('[api/auth] No admin account provisioned. Set VIP_ADMIN_USERNAME + VIP_ADMIN_PASSWORD.');
}

// Test accounts: seeded only in non-production, and only if not explicitly
// disabled. Useful for Vercel preview deploys where there's no real DB.
const enableTestAccounts =
  process.env.NODE_ENV !== 'production' &&
  process.env.VIP_DISABLE_TEST_ACCOUNTS !== '1';

if (enableTestAccounts) {
  seedUser('usr_test_free',       'test_free',        'free@test.voiceisolatepro.com',       'TestFree123',       'FREE');
  seedUser('usr_test_pro',        'test_pro',         'pro@test.voiceisolatepro.com',        'TestPro123',        'PRO');
  seedUser('usr_test_studio',     'test_studio',      'studio@test.voiceisolatepro.com',     'TestStudio123',     'STUDIO');
  seedUser('usr_test_enterprise', 'test_enterprise',  'enterprise@test.voiceisolatepro.com', 'TestEnterprise123', 'ENTERPRISE');
}

// ─── POST /api/auth/login ────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const user = USERS[username.toLowerCase()];
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const token = createAuthToken(user);
  res.json({
    success: true,
    token,
    user: { id: user.id, username: user.username, email: user.email, tier: user.tier, role: user.role },
  });
});

// ─── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }
  const payload = validateAuthToken(authHeader.slice(7));
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
  const user = USERS[payload.username?.toLowerCase()];
  res.json({
    id:         payload.sub,
    username:   payload.username,
    email:      payload.email,
    tier:       payload.tier.toUpperCase(),
    role:       payload.role,
    expiresAt:  payload.exp * 1000,
    isAdmin:    payload.role === 'admin',
    ...(user ? { createdAt: user.createdAt } : {}),
  });
});

// ─── POST /api/auth/logout ───────────────────────────────────────────────────
router.post('/logout', (_req, res) => {
  res.json({ success: true, message: 'Logged out. Clear token on client.' });
});

export default router;
export { validateAuthToken, USERS };
