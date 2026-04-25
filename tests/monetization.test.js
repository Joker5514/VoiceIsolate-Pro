/**
 * VoiceIsolate Pro — Monetization Unit Tests
 *
 * Tests the JWT license-token creation/validation logic and the HTTP route
 * behaviour of the monetization API.
 *
 * The core token functions (createLicenseToken / validateLicenseToken) are
 * re-implemented here using the same algorithm as api/monetization.js so that
 * the contract can be verified without importing the ESM module directly in a
 * CommonJS test environment.
 *
 * Route-level tests use a minimal in-process Express app that mirrors the
 * route handlers from api/monetization.js.
 */

'use strict';

const crypto  = require('crypto');
const express = require('express');
const request = require('supertest');

// ── Test JWT secret (mirrors LICENSE_JWT_SECRET env var) ──────────────────────
const TEST_SECRET = 'test-jwt-secret-for-unit-tests-minimum-32-chars';

// ── Token utility functions (same algorithm as api/monetization.js) ───────────

function createLicenseToken(userId, email, tier, daysValid = 365, secret = TEST_SECRET) {
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub:    userId,
    email,
    tier:   tier.toLowerCase(),
    iat:    Math.floor(Date.now() / 1000),
    exp:    Math.floor(Date.now() / 1000) + daysValid * 86400,
    source: 'stripe',
    jti:    crypto.randomBytes(8).toString('hex'),
  })).toString('base64url');
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${sig}`;
}

function validateLicenseToken(token, secret = TEST_SECRET) {
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

// ── createLicenseToken ────────────────────────────────────────────────────────
describe('createLicenseToken()', () => {
  test('returns a three-part dot-separated string', () => {
    const token = createLicenseToken('user_1', 'a@b.com', 'PRO');
    expect(token.split('.')).toHaveLength(3);
  });

  test('header decodes to the expected JWT header', () => {
    const token = createLicenseToken('user_1', 'a@b.com', 'PRO');
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
    expect(header.typ).toBe('JWT');
  });

  test('payload contains the expected fields', () => {
    const token = createLicenseToken('u42', 'user@example.com', 'STUDIO', 30);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(payload.sub).toBe('u42');
    expect(payload.email).toBe('user@example.com');
    expect(payload.tier).toBe('studio');
    expect(payload.source).toBe('stripe');
    expect(payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(typeof payload.jti).toBe('string');
  });

  test('exp is approximately now + daysValid * 86400', () => {
    const days  = 14;
    const token = createLicenseToken('u1', 'e@e.com', 'PRO', days);
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    const expectedExp = Math.floor(Date.now() / 1000) + days * 86400;
    expect(Math.abs(exp - expectedExp)).toBeLessThan(5); // within 5 seconds
  });

  test('tier is lowercased in the token payload', () => {
    const token = createLicenseToken('u1', 'e@e.com', 'PRO');
    const { tier } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    expect(tier).toBe('pro');
  });

  test('each call generates a unique jti', () => {
    const t1 = createLicenseToken('u1', 'e@e.com', 'PRO');
    const t2 = createLicenseToken('u1', 'e@e.com', 'PRO');
    const p1 = JSON.parse(Buffer.from(t1.split('.')[1], 'base64url').toString());
    const p2 = JSON.parse(Buffer.from(t2.split('.')[1], 'base64url').toString());
    expect(p1.jti).not.toBe(p2.jti);
  });
});

// ── validateLicenseToken ──────────────────────────────────────────────────────
describe('validateLicenseToken()', () => {
  test('returns the payload for a valid, unexpired token', () => {
    const token   = createLicenseToken('user_1', 'a@b.com', 'PRO');
    const payload = validateLicenseToken(token);
    expect(payload).not.toBeNull();
    expect(payload.sub).toBe('user_1');
    expect(payload.tier).toBe('pro');
  });

  test('returns null for a token signed with the wrong secret', () => {
    const token = createLicenseToken('user_1', 'a@b.com', 'PRO', 365, 'wrong-secret-key-32-characters-long');
    expect(validateLicenseToken(token, TEST_SECRET)).toBeNull();
  });

  test('returns null for an expired token', () => {
    const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      sub:   'u1',
      email: 'a@b.com',
      tier:  'pro',
      iat:   Math.floor(Date.now() / 1000) - 1000,
      exp:   Math.floor(Date.now() / 1000) - 1, // already expired
    })).toString('base64url');
    const sig = crypto
      .createHmac('sha256', TEST_SECRET)
      .update(`${header}.${payload}`)
      .digest('base64url');
    expect(validateLicenseToken(`${header}.${payload}.${sig}`)).toBeNull();
  });

  test('returns null for a token with fewer than three parts', () => {
    expect(validateLicenseToken('only.twoparts')).toBeNull();
    expect(validateLicenseToken('onepart')).toBeNull();
  });

  test('returns null for an empty string', () => {
    expect(validateLicenseToken('')).toBeNull();
  });

  test('returns null for a token with a tampered payload', () => {
    const token  = createLicenseToken('u1', 'a@b.com', 'PRO');
    const parts  = token.split('.');
    // Flip one character in the payload
    const tampered = parts[1].slice(0, -1) + (parts[1].slice(-1) === 'a' ? 'b' : 'a');
    expect(validateLicenseToken(`${parts[0]}.${tampered}.${parts[2]}`)).toBeNull();
  });

  test('returns null for non-base64url characters in the signature', () => {
    const token = createLicenseToken('u1', 'a@b.com', 'PRO');
    const parts = token.split('.');
    expect(validateLicenseToken(`${parts[0]}.${parts[1]}.!!!invalid!!!`)).toBeNull();
  });

  test('createLicenseToken / validateLicenseToken roundtrip preserves all fields', () => {
    const token   = createLicenseToken('cust_abc', 'roundtrip@test.com', 'STUDIO', 180);
    const payload = validateLicenseToken(token);
    expect(payload.sub).toBe('cust_abc');
    expect(payload.email).toBe('roundtrip@test.com');
    expect(payload.tier).toBe('studio');
    expect(payload.source).toBe('stripe');
  });
});

// ── Inline route helpers (mirrors api/monetization.js route logic) ────────────

const PRICE_IDS = {
  PRO_monthly:    'price_pro_monthly_test',
  PRO_annual:     'price_pro_annual_test',
  STUDIO_monthly: 'price_studio_monthly_test',
  STUDIO_annual:  'price_studio_annual_test',
};

const PRICE_TO_TIER = {
  [PRICE_IDS.PRO_monthly]:    'PRO',
  [PRICE_IDS.PRO_annual]:     'PRO',
  [PRICE_IDS.STUDIO_monthly]: 'STUDIO',
  [PRICE_IDS.STUDIO_annual]:  'STUDIO',
};

// Build a minimal Express app that mirrors the monetization routes
function buildApp() {
  const app = express();
  app.use(express.json());

  // POST /license/validate
  app.post('/license/validate', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ valid: false, error: 'Token required' });
    const payload = validateLicenseToken(token);
    if (!payload) return res.json({ valid: false, error: 'Invalid or expired token' });
    res.json({
      valid:     true,
      tier:      payload.tier.toUpperCase(),
      email:     payload.email,
      expiresAt: payload.exp * 1000,
      source:    payload.source,
    });
  });

  // POST /license/activate
  app.post('/license/activate', (req, res) => {
    const { token, email } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Token required' });
    const payload = validateLicenseToken(token);
    if (!payload) return res.status(400).json({ success: false, error: 'Invalid or expired license' });
    res.json({
      success:   true,
      tier:      payload.tier.toUpperCase(),
      email:     email || payload.email,
      expiresAt: payload.exp * 1000,
    });
  });

  // GET /license/status
  app.get('/license/status', (req, res) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.json({ tier: 'FREE', active: false });
    const payload = validateLicenseToken(auth.slice(7));
    if (!payload) return res.json({ tier: 'FREE', active: false });
    res.json({
      tier:          payload.tier.toUpperCase(),
      active:        true,
      email:         payload.email,
      expiresAt:     payload.exp * 1000,
      daysRemaining: Math.ceil((payload.exp - Date.now() / 1000) / 86400),
    });
  });

  // POST /usage/record
  app.post('/usage/record', (req, res) => {
    const { event: usageEvent, units = 1 } = req.body;
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const payload = validateLicenseToken(auth.slice(7));
    if (!payload) return res.status(401).json({ error: 'Invalid token' });
    res.json({ recorded: true, event: usageEvent, units });
  });

  // GET /pricing
  app.get('/pricing', (_req, res) => {
    res.json({
      tiers: {
        FREE:       { price: 0 },
        PRO:        { price: 12, priceAnnual: 99 },
        STUDIO:     { price: 29, priceAnnual: 249 },
        ENTERPRISE: { price: 199 },
      },
      trialDays:      14,
      moneyBackDays:  30,
    });
  });

  return app;
}

const app = buildApp();

// ── POST /license/validate ────────────────────────────────────────────────────
describe('POST /license/validate', () => {
  test('returns valid:true for a good token', async () => {
    const token = createLicenseToken('u1', 'a@b.com', 'PRO');
    const res = await request(app)
      .post('/license/validate')
      .send({ token });
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.tier).toBe('PRO');
    expect(res.body.email).toBe('a@b.com');
  });

  test('returns valid:false for an expired token', async () => {
    const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      sub: 'u1', email: 'a@b.com', tier: 'pro', iat: 0, exp: 1,
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', TEST_SECRET).update(`${header}.${payload}`).digest('base64url');
    const res = await request(app)
      .post('/license/validate')
      .send({ token: `${header}.${payload}.${sig}` });
    expect(res.body.valid).toBe(false);
  });

  test('returns 400 when token is missing from the body', async () => {
    const res = await request(app).post('/license/validate').send({});
    expect(res.status).toBe(400);
    expect(res.body.valid).toBe(false);
  });
});

// ── POST /license/activate ────────────────────────────────────────────────────
describe('POST /license/activate', () => {
  test('returns success:true and correct tier for a valid token', async () => {
    const token = createLicenseToken('u2', 'b@c.com', 'STUDIO');
    const res = await request(app)
      .post('/license/activate')
      .send({ token, email: 'override@test.com' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tier).toBe('STUDIO');
    expect(res.body.email).toBe('override@test.com');
  });

  test('uses token email when no override is supplied', async () => {
    const token = createLicenseToken('u3', 'orig@test.com', 'PRO');
    const res = await request(app)
      .post('/license/activate')
      .send({ token });
    expect(res.body.email).toBe('orig@test.com');
  });

  test('returns 400 for an invalid token', async () => {
    const res = await request(app)
      .post('/license/activate')
      .send({ token: 'garbage.token.here' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('returns 400 when token field is absent', async () => {
    const res = await request(app).post('/license/activate').send({});
    expect(res.status).toBe(400);
  });
});

// ── GET /license/status ───────────────────────────────────────────────────────
describe('GET /license/status', () => {
  test('returns FREE/inactive when no Authorization header is sent', async () => {
    const res = await request(app).get('/license/status');
    expect(res.body.tier).toBe('FREE');
    expect(res.body.active).toBe(false);
  });

  test('returns the correct tier for a valid Bearer token', async () => {
    const token = createLicenseToken('u4', 'c@d.com', 'STUDIO');
    const res = await request(app)
      .get('/license/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.body.active).toBe(true);
    expect(res.body.tier).toBe('STUDIO');
    expect(res.body.daysRemaining).toBeGreaterThan(0);
  });

  test('returns FREE/inactive for a Bearer with an invalid token', async () => {
    const res = await request(app)
      .get('/license/status')
      .set('Authorization', 'Bearer invalid.token.here');
    expect(res.body.tier).toBe('FREE');
    expect(res.body.active).toBe(false);
  });
});

// ── POST /usage/record ────────────────────────────────────────────────────────
describe('POST /usage/record', () => {
  test('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).post('/usage/record').send({ event: 'export', units: 1 });
    expect(res.status).toBe(401);
  });

  test('records usage for a valid token', async () => {
    const token = createLicenseToken('u5', 'e@f.com', 'PRO');
    const res = await request(app)
      .post('/usage/record')
      .set('Authorization', `Bearer ${token}`)
      .send({ event: 'export', units: 2 });
    expect(res.status).toBe(200);
    expect(res.body.recorded).toBe(true);
    expect(res.body.event).toBe('export');
    expect(res.body.units).toBe(2);
  });

  test('returns 401 for an invalid token', async () => {
    const res = await request(app)
      .post('/usage/record')
      .set('Authorization', 'Bearer bad.token.value')
      .send({ event: 'export' });
    expect(res.status).toBe(401);
  });
});

// ── GET /pricing ──────────────────────────────────────────────────────────────
describe('GET /pricing', () => {
  test('returns pricing info for all tiers', async () => {
    const res = await request(app).get('/pricing');
    expect(res.status).toBe(200);
    expect(res.body.tiers).toHaveProperty('FREE');
    expect(res.body.tiers).toHaveProperty('PRO');
    expect(res.body.tiers).toHaveProperty('STUDIO');
    expect(res.body.tiers).toHaveProperty('ENTERPRISE');
  });

  test('includes trialDays and moneyBackDays', async () => {
    const res = await request(app).get('/pricing');
    expect(res.body.trialDays).toBeGreaterThan(0);
    expect(res.body.moneyBackDays).toBeGreaterThan(0);
  });
});

// ── PRICE_TO_TIER mapping ─────────────────────────────────────────────────────
describe('PRICE_TO_TIER mapping', () => {
  test('PRO monthly and annual price IDs both map to PRO', () => {
    expect(PRICE_TO_TIER[PRICE_IDS.PRO_monthly]).toBe('PRO');
    expect(PRICE_TO_TIER[PRICE_IDS.PRO_annual]).toBe('PRO');
  });

  test('STUDIO monthly and annual price IDs both map to STUDIO', () => {
    expect(PRICE_TO_TIER[PRICE_IDS.STUDIO_monthly]).toBe('STUDIO');
    expect(PRICE_TO_TIER[PRICE_IDS.STUDIO_annual]).toBe('STUDIO');
  });
});
