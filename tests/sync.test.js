/**
 * VoiceIsolate Pro — Cloud Sync API Unit Tests
 *
 * Tests the input-validation helpers, authentication middleware, rate-limiter,
 * and the push/pull route handlers from api/sync.js.
 *
 * Because api/sync.js is an ES module that cannot be require()'d directly
 * in a CommonJS test suite, the pure utility functions are re-implemented
 * here with the same logic, and the route handlers are exercised through an
 * inline Express app built with the same algorithm.
 */

'use strict';

const crypto  = require('crypto');
const express = require('express');
const request = require('supertest');

// ── Test JWT secret ───────────────────────────────────────────────────────────
const SECRET = 'sync-test-secret-key-minimum-32-characters-here';

// ── Re-implemented pure utilities (mirrors api/sync.js) ───────────────────────

const ID_RE = /^[a-zA-Z0-9_\-]{1,128}$/;
const MAX_PRESET_PARAMS_BYTES = 64 * 1024;
const MAX_NOISE_PROFILE_BYTES = 256 * 1024;
const MAX_HISTORY_ENTRY_BYTES = 16 * 1024;

function _validateToken(token, secret = SECRET) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expectedSig    = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    const expectedSigBuf = Buffer.from(expectedSig, 'base64url');
    const providedSigBuf = Buffer.from(parts[2], 'base64url');
    if (expectedSigBuf.length !== providedSigBuf.length ||
        !crypto.timingSafeEqual(expectedSigBuf, providedSigBuf)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function _validateId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function _validatePreset(p) {
  if (!p || typeof p !== 'object') return false;
  if (!_validateId(p.id)) return false;
  if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > 256) return false;
  return true;
}

function _sanitizePreset(p) {
  const rawParams  = p.params && typeof p.params === 'object' ? p.params : {};
  const paramsStr  = JSON.stringify(rawParams);
  const params     = paramsStr.length <= MAX_PRESET_PARAMS_BYTES ? rawParams : {};
  const result     = {
    id:   String(p.id).slice(0, 128),
    name: String(p.name).slice(0, 256),
    params,
  };
  if (p.createdAt !== undefined && Number.isFinite(Number(p.createdAt))) result.createdAt = Number(p.createdAt);
  if (p.updatedAt !== undefined && Number.isFinite(Number(p.updatedAt))) result.updatedAt = Number(p.updatedAt);
  return result;
}

function _validateNoiseProfile(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > 256) return false;
  return true;
}

function _sanitizeNoiseProfile(p) {
  const rawData = p.data && typeof p.data === 'object' ? p.data : {};
  const dataStr = JSON.stringify(rawData);
  const data    = dataStr.length <= MAX_NOISE_PROFILE_BYTES ? rawData : {};
  const result  = { name: String(p.name).slice(0, 256), data };
  if (p.createdAt !== undefined && Number.isFinite(Number(p.createdAt))) result.createdAt = Number(p.createdAt);
  return result;
}

// Token factory (STUDIO tier by default — the minimum tier allowed for sync)
function makeToken({ tier = 'studio', sub = 'user_123', daysValid = 30 } = {}) {
  const header  = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub, tier, iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + daysValid * 86400,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

// ── _validateId ───────────────────────────────────────────────────────────────
describe('_validateId()', () => {
  test('accepts alphanumeric strings', () => {
    expect(_validateId('my_preset_01')).toBe(true);
    expect(_validateId('Preset-v2')).toBe(true);
    expect(_validateId('a')).toBe(true);
  });

  test('accepts the maximum length of 128 characters', () => {
    expect(_validateId('a'.repeat(128))).toBe(true);
  });

  test('rejects empty string', () => {
    expect(_validateId('')).toBe(false);
  });

  test('rejects strings longer than 128 characters', () => {
    expect(_validateId('a'.repeat(129))).toBe(false);
  });

  test('rejects strings containing spaces or special characters', () => {
    expect(_validateId('has space')).toBe(false);
    expect(_validateId('dot.separated')).toBe(false);
    expect(_validateId('slash/path')).toBe(false);
    expect(_validateId('<script>')).toBe(false);
  });

  test('rejects non-string values', () => {
    expect(_validateId(null)).toBe(false);
    expect(_validateId(123)).toBe(false);
    expect(_validateId({})).toBe(false);
  });
});

// ── _validatePreset ───────────────────────────────────────────────────────────
describe('_validatePreset()', () => {
  test('accepts a valid preset object', () => {
    expect(_validatePreset({ id: 'podcast_v1', name: 'Podcast' })).toBe(true);
  });

  test('rejects a preset with an invalid id', () => {
    expect(_validatePreset({ id: 'bad id!', name: 'Test' })).toBe(false);
    expect(_validatePreset({ id: '', name: 'Test' })).toBe(false);
    expect(_validatePreset({ id: null, name: 'Test' })).toBe(false);
  });

  test('rejects a preset with an empty name', () => {
    expect(_validatePreset({ id: 'ok_id', name: '' })).toBe(false);
  });

  test('rejects a preset with a name longer than 256 characters', () => {
    expect(_validatePreset({ id: 'ok_id', name: 'x'.repeat(257) })).toBe(false);
  });

  test('rejects null and non-object values', () => {
    expect(_validatePreset(null)).toBe(false);
    expect(_validatePreset('string')).toBe(false);
    expect(_validatePreset(42)).toBe(false);
  });
});

// ── _sanitizePreset ───────────────────────────────────────────────────────────
describe('_sanitizePreset()', () => {
  test('keeps id, name, and params', () => {
    const clean = _sanitizePreset({ id: 'p1', name: 'Podcast', params: { gain: 0.8 } });
    expect(clean.id).toBe('p1');
    expect(clean.name).toBe('Podcast');
    expect(clean.params).toEqual({ gain: 0.8 });
  });

  test('strips unknown fields', () => {
    const clean = _sanitizePreset({ id: 'p1', name: 'Test', params: {}, secret: 'leaked' });
    expect(clean).not.toHaveProperty('secret');
  });

  test('truncates id to 128 characters', () => {
    const long = 'a'.repeat(200);
    const clean = _sanitizePreset({ id: long, name: 'Test' });
    expect(clean.id.length).toBe(128);
  });

  test('truncates name to 256 characters', () => {
    const clean = _sanitizePreset({ id: 'ok', name: 'x'.repeat(300) });
    expect(clean.name.length).toBe(256);
  });

  test('defaults params to {} when params is not an object', () => {
    const clean = _sanitizePreset({ id: 'ok', name: 'Test', params: 'invalid' });
    expect(clean.params).toEqual({});
  });

  test('drops params when the serialized size exceeds the 64 KB cap', () => {
    const big = { data: 'x'.repeat(MAX_PRESET_PARAMS_BYTES + 1) };
    const clean = _sanitizePreset({ id: 'ok', name: 'Test', params: big });
    expect(clean.params).toEqual({});
  });

  test('includes valid createdAt and updatedAt timestamps', () => {
    const now   = Date.now();
    const clean = _sanitizePreset({ id: 'ok', name: 'Test', createdAt: now, updatedAt: now + 1 });
    expect(clean.createdAt).toBe(now);
    expect(clean.updatedAt).toBe(now + 1);
  });

  test('omits non-finite timestamp values', () => {
    const clean = _sanitizePreset({ id: 'ok', name: 'Test', createdAt: NaN, updatedAt: Infinity });
    expect(clean).not.toHaveProperty('createdAt');
    expect(clean).not.toHaveProperty('updatedAt');
  });
});

// ── _validateNoiseProfile ─────────────────────────────────────────────────────
describe('_validateNoiseProfile()', () => {
  test('accepts a valid noise profile', () => {
    expect(_validateNoiseProfile({ name: 'Office HVAC' })).toBe(true);
  });

  test('rejects a profile with an empty name', () => {
    expect(_validateNoiseProfile({ name: '' })).toBe(false);
  });

  test('rejects a profile with a name longer than 256 characters', () => {
    expect(_validateNoiseProfile({ name: 'x'.repeat(257) })).toBe(false);
  });

  test('rejects null and non-object values', () => {
    expect(_validateNoiseProfile(null)).toBe(false);
    expect(_validateNoiseProfile('string')).toBe(false);
  });
});

// ── _sanitizeNoiseProfile ─────────────────────────────────────────────────────
describe('_sanitizeNoiseProfile()', () => {
  test('keeps name and data', () => {
    const clean = _sanitizeNoiseProfile({ name: 'Fan', data: { bins: [0.1, 0.2] } });
    expect(clean.name).toBe('Fan');
    expect(clean.data).toEqual({ bins: [0.1, 0.2] });
  });

  test('drops oversized data (> 256 KB)', () => {
    const big   = { payload: 'x'.repeat(MAX_NOISE_PROFILE_BYTES + 1) };
    const clean = _sanitizeNoiseProfile({ name: 'Test', data: big });
    expect(clean.data).toEqual({});
  });

  test('defaults data to {} when data is not an object', () => {
    const clean = _sanitizeNoiseProfile({ name: 'Test', data: 'not-an-object' });
    expect(clean.data).toEqual({});
  });
});

// ── Inline Express app (mirrors api/sync.js routes) ──────────────────────────

function buildSyncApp() {
  const app    = express();
  const _store = new Map();
  const _rateL = new Map();
  const RATE_MAX = 20;
  const RATE_MS  = 60_000;

  app.use(express.json({ limit: '1mb' }));

  function requireAuth(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    const payload = _validateToken(auth.slice(7));
    if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });
    const tier = payload.tier?.toUpperCase();
    if (!['STUDIO', 'ENTERPRISE'].includes(tier)) {
      return res.status(403).json({ error: 'Cloud sync requires Studio or Enterprise tier' });
    }
    if (!payload.sub || typeof payload.sub !== 'string') {
      return res.status(401).json({ error: 'Invalid token: missing user identity' });
    }
    req.user = payload;
    next();
  }

  function requireRateLimit(req, res, next) {
    const userId = req.user?.sub;
    if (!userId) return next();
    const now = Date.now();
    for (const [uid, e] of _rateL) {
      if (now - e.windowStart > RATE_MS * 2) _rateL.delete(uid);
    }
    const entry = _rateL.get(userId) || { count: 0, windowStart: now };
    if (now - entry.windowStart > RATE_MS) { entry.count = 0; entry.windowStart = now; }
    entry.count++;
    _rateL.set(userId, entry);
    if (entry.count > RATE_MAX) return res.status(429).json({ error: 'Too many requests. Please wait before syncing again.' });
    next();
  }

  app.get('/pull', requireAuth, requireRateLimit, (req, res) => {
    const data = _store.get(req.user.sub) || { presets: [], noiseProfiles: [], history: [] };
    res.json({
      presets:      data.presets      || [],
      noiseProfiles: data.noiseProfiles || [],
      newHistory:   (data.history || []).slice(-20),
      syncedAt:     Date.now(),
    });
  });

  app.post('/push', requireAuth, requireRateLimit, (req, res) => {
    const ct = req.headers['content-type'] || '';
    if (!ct.includes('application/json')) return res.status(415).json({ error: 'Content-Type must be application/json' });

    const userId   = req.user.sub;
    const { changes = [] } = req.body;
    if (!Array.isArray(changes)) return res.status(400).json({ error: 'changes must be an array' });
    if (changes.length > 100) return res.status(413).json({ error: 'Too many changes per sync request (max 100)' });

    const data   = _store.get(userId) || { presets: [], noiseProfiles: [], history: [] };
    const errors = [];

    for (const change of changes) {
      switch (change.type) {
        case 'preset:upsert': {
          if (!_validatePreset(change.data)) { errors.push('Invalid preset data for change'); break; }
          const clean = _sanitizePreset(change.data);
          const idx   = data.presets.findIndex(p => p.id === clean.id);
          if (idx >= 0) data.presets[idx] = clean; else data.presets.push(clean);
          break;
        }
        case 'preset:delete': {
          if (!_validateId(change.id)) { errors.push('Invalid preset ID'); break; }
          data.presets = data.presets.filter(p => p.id !== change.id);
          break;
        }
        case 'noiseProfile:upsert': {
          if (!_validateNoiseProfile(change.data)) { errors.push('Invalid noise profile data'); break; }
          const clean = _sanitizeNoiseProfile(change.data);
          const idx   = data.noiseProfiles.findIndex(p => p.name === clean.name);
          if (idx >= 0) data.noiseProfiles[idx] = clean; else data.noiseProfiles.push(clean);
          break;
        }
        case 'history:add': {
          if (change.data && typeof change.data === 'object') {
            const str = JSON.stringify(change.data);
            if (str.length <= MAX_HISTORY_ENTRY_BYTES) {
              data.history = [...(data.history || []), change.data].slice(-100);
            } else {
              errors.push('history:add entry exceeds maximum size (16 KB)');
            }
          }
          break;
        }
      }
    }

    data.updatedAt = Date.now();
    _store.set(userId, data);
    res.json({ success: errors.length === 0, applied: changes.length - errors.length, errors, syncedAt: data.updatedAt });
  });

  return app;
}

const syncApp = buildSyncApp();
const studioToken = makeToken({ tier: 'studio', sub: 'user_sync_test' });
const authHeader  = { Authorization: `Bearer ${studioToken}` };

// ── Auth middleware ───────────────────────────────────────────────────────────
describe('requireAuth middleware', () => {
  test('rejects requests without an Authorization header', async () => {
    const res = await request(syncApp).get('/pull');
    expect(res.status).toBe(401);
  });

  test('rejects requests with a non-Bearer Authorization scheme', async () => {
    const res = await request(syncApp).get('/pull').set('Authorization', 'Basic abc123');
    expect(res.status).toBe(401);
  });

  test('rejects requests with an invalid token', async () => {
    const res = await request(syncApp).get('/pull').set('Authorization', 'Bearer garbage.token.here');
    expect(res.status).toBe(401);
  });

  test('rejects PRO-tier tokens (sync requires Studio+)', async () => {
    const proToken = makeToken({ tier: 'pro', sub: 'pro_user' });
    const res = await request(syncApp).get('/pull').set('Authorization', `Bearer ${proToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/studio/i);
  });

  test('allows valid STUDIO-tier tokens', async () => {
    const res = await request(syncApp).get('/pull').set(authHeader);
    expect(res.status).toBe(200);
  });

  test('allows valid ENTERPRISE-tier tokens', async () => {
    const entToken = makeToken({ tier: 'enterprise', sub: 'ent_user' });
    const res = await request(syncApp).get('/pull').set('Authorization', `Bearer ${entToken}`);
    expect(res.status).toBe(200);
  });
});

// ── GET /pull ─────────────────────────────────────────────────────────────────
describe('GET /pull', () => {
  test('returns empty arrays for a new user', async () => {
    const res = await request(syncApp).get('/pull').set(authHeader);
    expect(res.status).toBe(200);
    expect(res.body.presets).toEqual([]);
    expect(res.body.noiseProfiles).toEqual([]);
    expect(res.body.newHistory).toEqual([]);
    expect(res.body.syncedAt).toBeGreaterThan(0);
  });

  test('returns data that was previously pushed', async () => {
    const uniqueToken = makeToken({ tier: 'studio', sub: 'pull_test_user' });
    const ah          = { Authorization: `Bearer ${uniqueToken}` };

    await request(syncApp)
      .post('/push')
      .set(ah)
      .set('Content-Type', 'application/json')
      .send({ changes: [{ type: 'preset:upsert', data: { id: 'p1', name: 'Podcast', params: {} } }] });

    const res = await request(syncApp).get('/pull').set(ah);
    expect(res.body.presets).toHaveLength(1);
    expect(res.body.presets[0].id).toBe('p1');
  });
});

// ── POST /push ────────────────────────────────────────────────────────────────
describe('POST /push', () => {
  let pushToken;
  let pushAuth;

  beforeEach(() => {
    pushToken = makeToken({ tier: 'studio', sub: `push_user_${Date.now()}` });
    pushAuth  = { Authorization: `Bearer ${pushToken}` };
  });

  test('returns 415 when Content-Type is not application/json', async () => {
    const res = await request(syncApp)
      .post('/push')
      .set({ ...pushAuth, 'Content-Type': 'text/plain' })
      .send('raw text');
    expect(res.status).toBe(415);
  });

  test('returns 400 when changes is not an array', async () => {
    const res = await request(syncApp)
      .post('/push')
      .set(pushAuth)
      .send({ changes: 'not-an-array' });
    expect(res.status).toBe(400);
  });

  test('returns 413 when more than 100 changes are sent', async () => {
    const changes = Array.from({ length: 101 }, (_, i) => ({
      type: 'preset:upsert',
      data: { id: `p${i}`, name: `Preset ${i}` },
    }));
    const res = await request(syncApp)
      .post('/push')
      .set(pushAuth)
      .send({ changes });
    expect(res.status).toBe(413);
  });

  test('preset:upsert — inserts a new preset', async () => {
    const res = await request(syncApp)
      .post('/push')
      .set(pushAuth)
      .send({ changes: [{ type: 'preset:upsert', data: { id: 'new_p', name: 'My Preset' } }] });
    expect(res.body.success).toBe(true);
    expect(res.body.applied).toBe(1);
    expect(res.body.errors).toHaveLength(0);
  });

  test('preset:upsert — updates an existing preset by id', async () => {
    const changes = [
      { type: 'preset:upsert', data: { id: 'upd_p', name: 'Original' } },
      { type: 'preset:upsert', data: { id: 'upd_p', name: 'Updated' } },
    ];
    await request(syncApp).post('/push').set(pushAuth).send({ changes: [changes[0]] });
    await request(syncApp).post('/push').set(pushAuth).send({ changes: [changes[1]] });
    const pull = await request(syncApp).get('/pull').set(pushAuth);
    const preset = pull.body.presets.find(p => p.id === 'upd_p');
    expect(preset.name).toBe('Updated');
  });

  test('preset:upsert — records an error for an invalid preset', async () => {
    const res = await request(syncApp)
      .post('/push')
      .set(pushAuth)
      .send({ changes: [{ type: 'preset:upsert', data: { id: 'bad id!', name: 'X' } }] });
    expect(res.body.success).toBe(false);
    expect(res.body.errors).toHaveLength(1);
  });

  test('preset:delete — removes a preset', async () => {
    // First insert
    await request(syncApp)
      .post('/push')
      .set(pushAuth)
      .send({ changes: [{ type: 'preset:upsert', data: { id: 'del_p', name: 'To Delete' } }] });

    // Then delete
    const res = await request(syncApp)
      .post('/push')
      .set(pushAuth)
      .send({ changes: [{ type: 'preset:delete', id: 'del_p' }] });
    expect(res.body.success).toBe(true);

    const pull = await request(syncApp).get('/pull').set(pushAuth);
    expect(pull.body.presets.find(p => p.id === 'del_p')).toBeUndefined();
  });

  test('preset:delete — records an error for an invalid preset ID', async () => {
    const res = await request(syncApp)
      .post('/push')
      .set(pushAuth)
      .send({ changes: [{ type: 'preset:delete', id: 'invalid id!' }] });
    expect(res.body.errors).toHaveLength(1);
  });

  test('noiseProfile:upsert — inserts a noise profile', async () => {
    const res = await request(syncApp)
      .post('/push')
      .set(pushAuth)
      .send({ changes: [{ type: 'noiseProfile:upsert', data: { name: 'Office Fan' } }] });
    expect(res.body.success).toBe(true);
  });

  test('noiseProfile:upsert — records an error for a missing name', async () => {
    const res = await request(syncApp)
      .post('/push')
      .set(pushAuth)
      .send({ changes: [{ type: 'noiseProfile:upsert', data: {} }] });
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('history:add — appends an entry', async () => {
    const res = await request(syncApp)
      .post('/push')
      .set(pushAuth)
      .send({ changes: [{ type: 'history:add', data: { action: 'export', ts: Date.now() } }] });
    expect(res.body.success).toBe(true);
  });

  test('history:add — rejects an entry that exceeds 16 KB', async () => {
    const big = { payload: 'x'.repeat(MAX_HISTORY_ENTRY_BYTES + 1) };
    const res = await request(syncApp)
      .post('/push')
      .set(pushAuth)
      .send({ changes: [{ type: 'history:add', data: big }] });
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('mixed changes: counts applied vs errored correctly', async () => {
    const changes = [
      { type: 'preset:upsert', data: { id: 'valid', name: 'Good' } },
      { type: 'preset:upsert', data: { id: 'bad id!', name: 'Bad' } },
    ];
    const res = await request(syncApp).post('/push').set(pushAuth).send({ changes });
    expect(res.body.applied).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.success).toBe(false);
  });
});
