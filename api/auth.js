/**
 * VoiceIsolate Pro — Authentication API v22
 *
 * Endpoints:
 *   POST /api/auth/login   — Authenticate with username + password, returns JWT
 *   GET  /api/auth/me      — Get current user info from Bearer token
 *   POST /api/auth/logout  — Invalidate session (client-side only for now)
 *
 * Seeded accounts:
 *   admin    — joker5514 (ENTERPRISE + admin)
 *   test_free / test_pro / test_studio / test_enterprise — tier test accounts
 *
 * Passwords hashed with scrypt (Node.js built-in crypto).
 */

import express from 'express';
import crypto from 'crypto';

const router = express.Router();

// ─── Password Hashing (scrypt) ───────────────────────────────────────────────
const SCRYPT_KEYLEN = 64;
const SCRYPT_COST = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_COST);
  return `${salt}:${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_COST);
  const expected = Buffer.from(hash, 'hex');
  return crypto.timingSafeEqual(derived, expected);
}

// ─── JWT Utilities (reuses same secret as license tokens) ────────────────────
if (!process.env.LICENSE_JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('LICENSE_JWT_SECRET environment variable is required');
  }
  throw new Error('LICENSE_JWT_SECRET environment variable is required');
}
const LICENSE_SECRET = process.env.LICENSE_JWT_SECRET;

function createAuthToken(user) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    username: user.username,
    email: user.email,
    tier: user.tier.toLowerCase(),
    role: user.role,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (365 * 86400),
    source: 'auth',
    jti: crypto.randomBytes(8).toString('hex'),
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
      Buffer.from(parts[2], 'base64url')
    )) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Seeded User Store ───────────────────────────────────────────────────────
// In-memory store; production would use DATABASE_URL.
const USERS = {};

function seedUser(id, username, email, password, tier, role = 'user') {
  USERS[username.toLowerCase()] = {
    id,
    username,
    email,
    passwordHash: hashPassword(password),
    tier,
    role,
    createdAt: new Date().toISOString(),
  };
}

// Admin account
if (process.env.NODE_ENV !== 'production') {
  // Admin account
  seedUser('usr_admin_001', 'joker5514', 'admin@voiceisolatepro.com', 'Admin8052', 'ENTERPRISE', 'admin');

  // Test accounts per tier
  seedUser('usr_test_free', 'test_free', 'free@test.voiceisolatepro.com', 'TestFree123', 'FREE', 'user');
  seedUser('usr_test_pro', 'test_pro', 'pro@test.voiceisolatepro.com', 'TestPro123', 'PRO', 'user');
  seedUser('usr_test_studio', 'test_studio', 'studio@test.voiceisolatepro.com', 'TestStudio123', 'STUDIO', 'user');
  seedUser('usr_test_enterprise', 'test_enterprise', 'enterprise@test.voiceisolatepro.com', 'TestEnterprise123', 'ENTERPRISE', 'user');
}

// ─── POST /api/auth/login ────────────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = USERS[username.toLowerCase()];
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  if (!verifyPassword(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const token = createAuthToken(user);

  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      tier: user.tier,
      role: user.role,
    },
  });
});

// ─── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  const payload = validateAuthToken(authHeader.slice(7));
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  const user = USERS[payload.username?.toLowerCase()];
  res.json({
    id: payload.sub,
    username: payload.username,
    email: payload.email,
    tier: payload.tier.toUpperCase(),
    role: payload.role,
    expiresAt: payload.exp * 1000,
    isAdmin: payload.role === 'admin',
    ...(user ? { createdAt: user.createdAt } : {}),
  });
});

// ─── POST /api/auth/logout ───────────────────────────────────────────────────
router.post('/logout', (_req, res) => {
  // Stateless JWT — logout is handled client-side by clearing the token.
  // A production system would add the token to a revocation list.
  res.json({ success: true, message: 'Logged out. Clear token on client.' });
});

export default router;
export { validateAuthToken, USERS };
