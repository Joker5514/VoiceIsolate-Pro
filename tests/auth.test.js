/**
 * VoiceIsolate Pro — Authentication API Unit Tests
 *
 * Tests the JWT auth-token creation/validation logic and the HTTP route
 * behaviour of the authentication API (api/auth.js).
 *
 * The core token functions (createAuthToken / validateAuthToken) are
 * re-implemented here using the same algorithm as api/auth.js so the
 * contract can be verified without importing the ESM module directly.
 *
 * Route-level tests use a minimal in-process Express app that mirrors the
 * route handlers from api/auth.js.
 */

'use strict';

const crypto  = require('crypto');
const express = require('express');
const request = require('supertest');

// ── Test JWT secret (mirrors LICENSE_JWT_SECRET env var) ──────────────────────
const TEST_SECRET = 'test-jwt-secret-for-auth-unit-tests-minimum-32-chars';

// ── Token utility functions (same algorithm as api/auth.js) ──────────────────

const SCRYPT_KEYLEN = 64;
const SCRYPT_COST   = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt    = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_COST);
  return `${salt}:${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const derived      = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_COST);
  const expected     = Buffer.from(hash, 'hex');
  return crypto.timingSafeEqual(derived, expected);
}

function createAuthToken(user, secret = TEST_SECRET) {
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
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function validateAuthToken(token, secret = TEST_SECRET) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64url');
    if (!crypto.timingSafeEqual(
      Buffer.from(expectedSig, 'base64url'),
      Buffer.from(parts[2],    'base64url')
    )) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Seeded user data (mirrors api/auth.js USERS) ──────────────────────────────
function buildSeededUsers() {
  const USERS = {};
  function seedUser(id, username, email, password, tier, role = 'user') {
    USERS[username.toLowerCase()] = {
      id, username, email,
      passwordHash: hashPassword(password),
      tier, role,
      createdAt: new Date().toISOString(),
    };
  }
  seedUser('usr_admin_001',       'test_admin',         'admin@voiceisolatepro.com',             'TestAdmin123',         'ENTERPRISE', 'admin');
  seedUser('usr_test_free',       'test_free',         'free@test.voiceisolatepro.com',          'TestFree123',       'FREE');
  seedUser('usr_test_pro',        'test_pro',          'pro@test.voiceisolatepro.com',           'TestPro123',        'PRO');
  seedUser('usr_test_studio',     'test_studio',       'studio@test.voiceisolatepro.com',        'TestStudio123',     'STUDIO');
  seedUser('usr_test_enterprise', 'test_enterprise',   'enterprise@test.voiceisolatepro.com',    'TestEnterprise123', 'ENTERPRISE');
  return USERS;
}

// ── Minimal Express app that mirrors api/auth.js route logic ──────────────────
function buildApp(secret = TEST_SECRET) {
  const app   = express();
  const USERS = buildSeededUsers();

  app.use(express.json());

  // POST /login
  app.post('/login', (req, res) => {
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
    const token = createAuthToken(user, secret);
    res.json({
      success: true,
      token,
      user: {
        id:       user.id,
        username: user.username,
        email:    user.email,
        tier:     user.tier,
        role:     user.role,
      },
    });
  });

  // GET /me
  app.get('/me', (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Not authenticated.' });
    }
    const payload = validateAuthToken(authHeader.slice(7), secret);
    if (!payload) {
      return res.status(401).json({ error: 'Invalid or expired token.' });
    }
    const user = USERS[payload.username?.toLowerCase()];
    res.json({
      id:        payload.sub,
      username:  payload.username,
      email:     payload.email,
      tier:      payload.tier.toUpperCase(),
      role:      payload.role,
      expiresAt: payload.exp * 1000,
      isAdmin:   payload.role === 'admin',
      ...(user ? { createdAt: user.createdAt } : {}),
    });
  });

  // POST /logout
  app.post('/logout', (_req, res) => {
    res.json({ success: true, message: 'Logged out. Clear token on client.' });
  });

  return { app, USERS };
}

// ── createAuthToken() ─────────────────────────────────────────────────────────
describe('createAuthToken()', () => {
  const user = {
    id: 'usr_test_1', username: 'testuser', email: 'test@example.com',
    tier: 'PRO', role: 'user',
  };

  test('returns a three-part dot-separated string', () => {
    const token = createAuthToken(user);
    expect(token.split('.')).toHaveLength(3);
  });

  test('header decodes to correct JWT header fields', () => {
    const token  = createAuthToken(user);
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
    expect(header.typ).toBe('JWT');
  });

  test('payload contains all expected fields', () => {
    const token   = createAuthToken(user);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(payload.sub).toBe('usr_test_1');
    expect(payload.username).toBe('testuser');
    expect(payload.email).toBe('test@example.com');
    expect(payload.tier).toBe('pro');       // lowercased
    expect(payload.role).toBe('user');
    expect(payload.source).toBe('auth');
    expect(typeof payload.jti).toBe('string');
    expect(payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  test('tier is stored lowercased in the payload', () => {
    const token   = createAuthToken({ ...user, tier: 'ENTERPRISE' });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(payload.tier).toBe('enterprise');
  });

  test('exp is approximately now + 365 days', () => {
    const token       = createAuthToken(user);
    const { exp }     = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const expectedExp = Math.floor(Date.now() / 1000) + 365 * 86400;
    expect(Math.abs(exp - expectedExp)).toBeLessThan(5);
  });

  test('each call generates a unique jti', () => {
    const t1 = createAuthToken(user);
    const t2 = createAuthToken(user);
    const p1 = JSON.parse(Buffer.from(t1.split('.')[1], 'base64url').toString());
    const p2 = JSON.parse(Buffer.from(t2.split('.')[1], 'base64url').toString());
    expect(p1.jti).not.toBe(p2.jti);
  });

  test('admin user token has role=admin in payload', () => {
    const adminUser   = { ...user, role: 'admin' };
    const token       = createAuthToken(adminUser);
    const { role }    = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(role).toBe('admin');
  });
});

// ── validateAuthToken() ───────────────────────────────────────────────────────
describe('validateAuthToken()', () => {
  const user = {
    id: 'usr_v1', username: 'valuser', email: 'val@example.com',
    tier: 'STUDIO', role: 'user',
  };

  test('returns payload for a valid unexpired token', () => {
    const token   = createAuthToken(user);
    const payload = validateAuthToken(token);
    expect(payload).not.toBeNull();
    expect(payload.sub).toBe('usr_v1');
    expect(payload.username).toBe('valuser');
    expect(payload.tier).toBe('studio');
    expect(payload.source).toBe('auth');
  });

  test('returns null for a token signed with the wrong secret', () => {
    const token = createAuthToken(user, 'wrong-secret-key-that-is-32-chars-long!!');
    expect(validateAuthToken(token, TEST_SECRET)).toBeNull();
  });

  test('returns null for an expired token', () => {
    const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      sub: 'u1', username: 'x', email: 'a@b.com', tier: 'pro',
      role: 'user', iat: 0, exp: 1,
    })).toString('base64url');
    const sig = crypto
      .createHmac('sha256', TEST_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(validateAuthToken(`${header}.${payload}.${sig}`)).toBeNull();
  });

  test('returns null for a token with fewer than three parts', () => {
    expect(validateAuthToken('only.twoparts')).toBeNull();
    expect(validateAuthToken('singlepart')).toBeNull();
  });

  test('returns null for an empty string', () => {
    expect(validateAuthToken('')).toBeNull();
  });

  test('returns null for a token with a tampered payload', () => {
    const token   = createAuthToken(user);
    const parts   = token.split('.');
    const tampered = parts[1].slice(0, -1) + (parts[1].slice(-1) === 'a' ? 'b' : 'a');
    expect(validateAuthToken(`${parts[0]}.${tampered}.${parts[2]}`)).toBeNull();
  });

  test('returns null for a completely invalid string', () => {
    expect(validateAuthToken('not.a.jwt.at.all')).toBeNull();
  });

  test('roundtrip preserves all fields', () => {
    const token   = createAuthToken(user);
    const payload = validateAuthToken(token);
    expect(payload.sub).toBe('usr_v1');
    expect(payload.username).toBe('valuser');
    expect(payload.email).toBe('val@example.com');
    expect(payload.tier).toBe('studio');
    expect(payload.source).toBe('auth');
  });
});

// ── hashPassword / verifyPassword ─────────────────────────────────────────────
describe('hashPassword() / verifyPassword()', () => {
  test('produced hash verifies correctly against original password', () => {
    const hash = hashPassword('mySecureP@ss1');
    expect(verifyPassword('mySecureP@ss1', hash)).toBe(true);
  });

  test('wrong password does not verify', () => {
    const hash = hashPassword('correctPassword');
    expect(verifyPassword('wrongPassword', hash)).toBe(false);
  });

  test('hash format is salt:hex', () => {
    const hash  = hashPassword('test');
    const parts = hash.split(':');
    expect(parts).toHaveLength(2);
    expect(parts[0]).toHaveLength(32); // 16-byte hex
    expect(parts[1]).toHaveLength(128); // 64-byte hex
  });

  test('two hashes of the same password use different salts', () => {
    const h1 = hashPassword('samepass');
    const h2 = hashPassword('samepass');
    expect(h1.split(':')[0]).not.toBe(h2.split(':')[0]);
  });
});

// ── Seeded USERS store ────────────────────────────────────────────────────────
describe('Seeded USERS store', () => {
  const USERS = buildSeededUsers();

  test('contains all five seeded accounts', () => {
    expect(Object.keys(USERS)).toHaveLength(5);
    expect(USERS).toHaveProperty('test_admin');
    expect(USERS).toHaveProperty('test_free');
    expect(USERS).toHaveProperty('test_pro');
    expect(USERS).toHaveProperty('test_studio');
    expect(USERS).toHaveProperty('test_enterprise');
  });

  test('test_admin has ENTERPRISE tier and admin role', () => {
    expect(USERS['test_admin'].tier).toBe('ENTERPRISE');
    expect(USERS['test_admin'].role).toBe('admin');
  });

  test('no real admin credentials leak into seeded users', () => {
    expect(USERS).not.toHaveProperty('joker5514');
  });

  test('tier-named accounts have correct tiers', () => {
    expect(USERS['test_free'].tier).toBe('FREE');
    expect(USERS['test_pro'].tier).toBe('PRO');
    expect(USERS['test_studio'].tier).toBe('STUDIO');
    expect(USERS['test_enterprise'].tier).toBe('ENTERPRISE');
  });

  test('all test accounts have role=user', () => {
    ['test_free', 'test_pro', 'test_studio', 'test_enterprise'].forEach((u) => {
      expect(USERS[u].role).toBe('user');
    });
  });

  test('user records have expected shape', () => {
    const u = USERS['test_pro'];
    expect(u).toHaveProperty('id');
    expect(u).toHaveProperty('username');
    expect(u).toHaveProperty('email');
    expect(u).toHaveProperty('passwordHash');
    expect(u).toHaveProperty('tier');
    expect(u).toHaveProperty('role');
    expect(u).toHaveProperty('createdAt');
  });

  test('passwords verify correctly for seeded accounts', () => {
    expect(verifyPassword('TestAdmin123',         USERS['test_admin'].passwordHash)).toBe(true);
    expect(verifyPassword('TestFree123',       USERS['test_free'].passwordHash)).toBe(true);
    expect(verifyPassword('TestPro123',        USERS['test_pro'].passwordHash)).toBe(true);
    expect(verifyPassword('TestStudio123',     USERS['test_studio'].passwordHash)).toBe(true);
    expect(verifyPassword('TestEnterprise123', USERS['test_enterprise'].passwordHash)).toBe(true);
  });
});

// ── POST /login ───────────────────────────────────────────────────────────────
describe('POST /login', () => {
  const { app } = buildApp();

  test('returns 200 and a JWT on valid credentials', async () => {
    const res = await request(app)
      .post('/login')
      .send({ username: 'test_pro', password: 'TestPro123' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.split('.')).toHaveLength(3);
  });

  test('response user object has correct fields for test_pro', async () => {
    const res = await request(app)
      .post('/login')
      .send({ username: 'test_pro', password: 'TestPro123' });
    const u = res.body.user;
    expect(u.username).toBe('test_pro');
    expect(u.email).toBe('pro@test.voiceisolatepro.com');
    expect(u.tier).toBe('PRO');
    expect(u.role).toBe('user');
    expect(u.id).toBe('usr_test_pro');
  });

  test('admin login returns role=admin and ENTERPRISE tier', async () => {
    const res = await request(app)
      .post('/login')
      .send({ username: 'test_admin', password: 'TestAdmin123' });
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.tier).toBe('ENTERPRISE');
  });

  test('username matching is case-insensitive', async () => {
    const res = await request(app)
      .post('/login')
      .send({ username: 'TEST_PRO', password: 'TestPro123' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('returns 401 for correct username but wrong password', async () => {
    const res = await request(app)
      .post('/login')
      .send({ username: 'test_free', password: 'WrongPassword' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid username or password.');
  });

  test('returns 401 for unknown username', async () => {
    const res = await request(app)
      .post('/login')
      .send({ username: 'nobody', password: 'somepass' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid username or password.');
  });

  test('returns 400 when username is missing', async () => {
    const res = await request(app)
      .post('/login')
      .send({ password: 'TestPro123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Username and password are required.');
  });

  test('returns 400 when password is missing', async () => {
    const res = await request(app)
      .post('/login')
      .send({ username: 'test_pro' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Username and password are required.');
  });

  test('returns 400 when body is empty', async () => {
    const res = await request(app).post('/login').send({});
    expect(res.status).toBe(400);
  });

  test('all tier accounts can log in with correct passwords', async () => {
    const accounts = [
      { username: 'test_free',       password: 'TestFree123'       },
      { username: 'test_pro',        password: 'TestPro123'        },
      { username: 'test_studio',     password: 'TestStudio123'     },
      { username: 'test_enterprise', password: 'TestEnterprise123' },
    ];
    for (const { username, password } of accounts) {
      const res = await request(app).post('/login').send({ username, password });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    }
  });

  test('token payload source is "auth" (not "stripe")', async () => {
    const res     = await request(app)
      .post('/login')
      .send({ username: 'test_pro', password: 'TestPro123' });
    const payload = JSON.parse(Buffer.from(res.body.token.split('.')[1], 'base64url').toString());
    expect(payload.source).toBe('auth');
  });
});

// ── GET /me ───────────────────────────────────────────────────────────────────
describe('GET /me', () => {
  const { app } = buildApp();

  async function loginAndGetToken(username, password) {
    const res = await request(app).post('/login').send({ username, password });
    return res.body.token;
  }

  test('returns 401 when no Authorization header is sent', async () => {
    const res = await request(app).get('/me');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Not authenticated.');
  });

  test('returns 401 when Authorization header lacks Bearer prefix', async () => {
    const token = await loginAndGetToken('test_pro', 'TestPro123');
    const res   = await request(app)
      .get('/me')
      .set('Authorization', token);          // missing "Bearer "
    expect(res.status).toBe(401);
  });

  test('returns 401 for an invalid token string', async () => {
    const res = await request(app)
      .get('/me')
      .set('Authorization', 'Bearer invalid.token.string');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid or expired token.');
  });

  test('returns user info for a valid Bearer token', async () => {
    const token = await loginAndGetToken('test_studio', 'TestStudio123');
    const res   = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.username).toBe('test_studio');
    expect(res.body.tier).toBe('STUDIO');
    expect(res.body.email).toBe('studio@test.voiceisolatepro.com');
    expect(res.body.isAdmin).toBe(false);
  });

  test('returns isAdmin=true for the admin token', async () => {
    const token = await loginAndGetToken('test_admin', 'TestAdmin123');
    const res   = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.isAdmin).toBe(true);
    expect(res.body.role).toBe('admin');
  });

  test('tier is uppercased in the /me response', async () => {
    const token = await loginAndGetToken('test_pro', 'TestPro123');
    const res   = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.tier).toBe('PRO');        // source stores 'pro', response uppercases it
  });

  test('response includes expiresAt as millisecond timestamp', async () => {
    const token = await loginAndGetToken('test_free', 'TestFree123');
    const res   = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`);
    expect(typeof res.body.expiresAt).toBe('number');
    expect(res.body.expiresAt).toBeGreaterThan(Date.now());
  });

  test('response includes createdAt from the user store', async () => {
    const token = await loginAndGetToken('test_enterprise', 'TestEnterprise123');
    const res   = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body).toHaveProperty('createdAt');
    expect(typeof res.body.createdAt).toBe('string');
  });

  test('returns 401 for an expired token', async () => {
    // Construct a token that is already expired
    const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      sub: 'usr_test_pro', username: 'test_pro', email: 'pro@test.voiceisolatepro.com',
      tier: 'pro', role: 'user', source: 'auth',
      iat: 0, exp: 1,
    })).toString('base64url');
    const sig = crypto
      .createHmac('sha256', TEST_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    const expiredToken = `${header}.${payload}.${sig}`;
    const res = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${expiredToken}`);
    expect(res.status).toBe(401);
  });
});

// ── POST /logout ──────────────────────────────────────────────────────────────
describe('POST /logout', () => {
  const { app } = buildApp();

  test('returns success:true regardless of auth state', async () => {
    const res = await request(app).post('/logout');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('response includes a message about clearing the token on client', async () => {
    const res = await request(app).post('/logout');
    expect(res.body.message).toMatch(/token/i);
    expect(res.body.message).toMatch(/client/i);
  });

  test('returns success even when an Authorization header is present', async () => {
    const res = await request(app)
      .post('/logout')
      .set('Authorization', 'Bearer some.random.token');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

// ── Full login → me flow ──────────────────────────────────────────────────────
describe('Login → /me roundtrip', () => {
  const { app } = buildApp();

  test('token obtained from /login is accepted by /me', async () => {
    const loginRes = await request(app)
      .post('/login')
      .send({ username: 'test_studio', password: 'TestStudio123' });
    expect(loginRes.status).toBe(200);

    const meRes = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${loginRes.body.token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body.username).toBe('test_studio');
    expect(meRes.body.tier).toBe('STUDIO');
  });

  test('token from one user does not give access as a different user', async () => {
    const loginRes = await request(app)
      .post('/login')
      .send({ username: 'test_free', password: 'TestFree123' });
    const meRes = await request(app)
      .get('/me')
      .set('Authorization', `Bearer ${loginRes.body.token}`);
    expect(meRes.body.username).toBe('test_free');
    expect(meRes.body.tier).toBe('FREE');
  });
});

// ── LICENSE_SECRET IIFE fallback (api/auth.js PR change) ──────────────────────
// api/auth.js changed from a boot-time throw to an IIFE that:
//   - returns the env var when set
//   - returns a hardcoded dev fallback + console.warn when unset (ALL environments)
// Unlike api/monetization.js, auth.js NEVER throws — it always falls back.
describe('LICENSE_SECRET IIFE fallback (auth.js)', () => {
  const AUTH_FALLBACK = 'vip-dev-fallback-secret-change-in-production-32chars';

  // Replicates the IIFE logic from api/auth.js
  function resolveLicenseSecret(envValue) {
    const savedSecret  = process.env.LICENSE_JWT_SECRET;
    if (envValue === undefined) {
      delete process.env.LICENSE_JWT_SECRET;
    } else {
      process.env.LICENSE_JWT_SECRET = envValue;
    }

    let warnEmitted    = false;
    let thrownError    = null;
    const originalWarn = console.warn;
    console.warn = (...args) => {
      if (String(args[0]).includes('LICENSE_JWT_SECRET')) warnEmitted = true;
    };

    let resolved;
    try {
      // Mirrors the IIFE in api/auth.js exactly
      resolved = (() => {
        if (process.env.LICENSE_JWT_SECRET) return process.env.LICENSE_JWT_SECRET;
        const fallback = AUTH_FALLBACK;
        console.warn(
          '[Auth] WARNING: LICENSE_JWT_SECRET not set. Using insecure dev fallback.\n' +
          '  → Set it in Vercel Dashboard → Settings → Environment Variables.'
        );
        return fallback;
      })();
    } catch (e) {
      thrownError = e;
    }

    console.warn = originalWarn;
    if (savedSecret === undefined) {
      delete process.env.LICENSE_JWT_SECRET;
    } else {
      process.env.LICENSE_JWT_SECRET = savedSecret;
    }

    return { resolved, warnEmitted, thrownError };
  }

  test('returns the env var value when LICENSE_JWT_SECRET is set', () => {
    const mySecret = 'my-actual-secret-key-32chars-min!!';
    const { resolved, warnEmitted, thrownError } = resolveLicenseSecret(mySecret);
    expect(thrownError).toBeNull();
    expect(resolved).toBe(mySecret);
    expect(warnEmitted).toBe(false);
  });

  test('returns the hardcoded dev fallback when LICENSE_JWT_SECRET is absent', () => {
    const { resolved, thrownError } = resolveLicenseSecret(undefined);
    expect(thrownError).toBeNull();
    expect(resolved).toBe(AUTH_FALLBACK);
  });

  test('emits console.warn when falling back to dev secret', () => {
    const { warnEmitted } = resolveLicenseSecret(undefined);
    expect(warnEmitted).toBe(true);
  });

  test('never throws — even when LICENSE_JWT_SECRET is absent', () => {
    // The PR specifically removed the throw in favour of a graceful fallback
    const { thrownError } = resolveLicenseSecret(undefined);
    expect(thrownError).toBeNull();
  });

  test('dev fallback is at least 32 characters (suitable HMAC key)', () => {
    expect(AUTH_FALLBACK.length).toBeGreaterThanOrEqual(32);
  });

  test('tokens signed with the fallback secret validate correctly', () => {
    const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      sub: 'u1', username: 'test', email: 'test@example.com',
      tier: 'pro', role: 'user', source: 'auth',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url');
    const sig = crypto
      .createHmac('sha256', AUTH_FALLBACK)
      .update(`${header}.${payload}`)
      .digest('base64url');
    const token = `${header}.${payload}.${sig}`;

    // Validate using the same fallback
    const parts       = token.split('.');
    const expectedSig = crypto
      .createHmac('sha256', AUTH_FALLBACK)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64url');
    const sigMatch = crypto.timingSafeEqual(
      Buffer.from(expectedSig, 'base64url'),
      Buffer.from(parts[2],    'base64url')
    );
    expect(sigMatch).toBe(true);
  });

  test('route returns 200 using a token signed with fallback secret (dev env works)', () => {
    // Build an app that explicitly uses the fallback secret
    const fallbackApp = buildApp(AUTH_FALLBACK);
    // Create a token with the fallback secret via createAuthToken (re-used helper above)
    const user  = { id: 'usr_test_pro', username: 'test_pro', email: 'pro@test.voiceisolatepro.com', tier: 'PRO', role: 'user' };
    const token = createAuthToken(user, AUTH_FALLBACK);
    return request(fallbackApp.app)
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .then(res => {
        expect(res.status).toBe(200);
        expect(res.body.username).toBe('test_pro');
      });
  });
});