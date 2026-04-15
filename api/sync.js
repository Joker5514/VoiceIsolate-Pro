/**
 * VoiceIsolate Pro — Cloud Sync API v22
 *
 * Endpoints:
 *   GET  /api/sync/pull  — Pull latest presets and noise profiles
 *   POST /api/sync/push  — Push pending changes
 *
 * Auth: Bearer token (license JWT)
 * Storage: In-memory for demo; replace with database in production
 *
 * Production: Use PostgreSQL/MySQL + S3/R2 for file storage
 * Install: npm install @aws-sdk/client-s3 (for file storage)
 */

import express from 'express';
import crypto from 'crypto';

const router = express.Router();

router.use(express.json({ limit: '1mb' }));

// ─── In-Memory Store (replace with DB in production) ─────────────────────────
const _store = new Map(); // userId → { presets, noiseProfiles, history, updatedAt }

// ─── Auth Middleware ──────────────────────────────────────────────────────────
// FIX: no throw on missing env var so Vercel deployments without the secret
// don't crash at startup. Set LICENSE_JWT_SECRET in Vercel Environment Variables.
const LICENSE_SECRET = (() => {
  if (process.env.LICENSE_JWT_SECRET) return process.env.LICENSE_JWT_SECRET;
  const fallback = 'vip-dev-fallback-secret-change-in-production-32chars';
  console.warn(
    '[sync] WARNING: LICENSE_JWT_SECRET not set. Using insecure dev fallback.\n' +
    '  → Set it in Vercel Dashboard → Settings → Environment Variables.'
  );
  return fallback;
})();

/**
 * Validate and decode a license token, returning its payload when valid.
 *
 * Verifies the token is a three-part dot-separated string, checks its HMAC-SHA256
 * signature using the module's license secret, and ensures the payload's `exp`
 * timestamp has not passed.
 *
 * @param {string} token - License token in `header.payload.signature` form (Base64URL parts).
 * @returns {Object|null} The decoded payload object when the token is valid and not expired, `null` otherwise.
 */
function _validateToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const expectedSig = crypto
      .createHmac('sha256', LICENSE_SECRET)
      .update(`${parts[0]}.${parts[1]}`)
      .digest('base64url');
    const expectedSigBuf = Buffer.from(expectedSig, 'base64url');
    const providedSigBuf = Buffer.from(parts[2], 'base64url');
    if (expectedSigBuf.length !== providedSigBuf.length || !crypto.timingSafeEqual(expectedSigBuf, providedSigBuf)) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

/**
 * Authenticate the request using a Bearer license JWT and enforce Studio/Enterprise tier for cloud sync.
 *
 * Validates the Authorization header contains a Bearer token and verifies the token payload and expiry; on success assigns the token payload to `req.user` and calls `next()`. If the header is missing or the token is invalid/expired, responds with 401 Unauthorized. If the token's `tier` is not `STUDIO` or `ENTERPRISE`, responds with 403 Forbidden and an explanatory error.
 */
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    console.warn(`[AUTH FAIL] ip=${req.ip} path=${req.path} reason=missing_bearer`);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const payload = _validateToken(auth.slice(7));
  if (!payload) {
    console.warn(`[AUTH FAIL] ip=${req.ip} path=${req.path} reason=invalid_token`);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  // Check tier allows cloud sync
  const tier = payload.tier?.toUpperCase();
  if (!['STUDIO', 'ENTERPRISE'].includes(tier)) {
    return res.status(403).json({ error: 'Cloud sync requires Studio or Enterprise tier' });
  }

  // Require a stable user identity for rate limiting and data storage
  if (!payload.sub || typeof payload.sub !== 'string') {
    console.warn(`[AUTH FAIL] ip=${req.ip} path=${req.path} reason=missing_sub`);
    return res.status(401).json({ error: 'Invalid token: missing user identity' });
  }

  req.user = payload;
  next();
}

// ─── Rate Limiter (per-user, in-memory; replace with Redis in production) ─────
const _rateLimits = new Map(); // userId → { count, windowStart }
const RATE_LIMIT_MAX = 20;    // requests per window
const RATE_LIMIT_MS  = 60_000; /**
 * Enforces a per-user rate limit and rejects requests that exceed the allowed quota.
 *
 * Uses req.user.sub as the user identifier; if no user ID is present the middleware is a no-op.
 * Limits each user to 20 requests per 60 seconds and, when the limit is exceeded, responds with
 * HTTP 429 and a JSON error: `{ error: 'Too many requests. Please wait before syncing again.' }`.
 *
 * @param {import("express").Request} req - Express request; expects `req.user?.sub` to identify the user.
 * @param {import("express").Response} res - Express response used to send a 429 when the rate limit is exceeded.
 * @param {import("express").NextFunction} next - Express next middleware function called when the request is allowed.
 */

function requireRateLimit(req, res, next) {
  const userId = req.user?.sub;
  if (!userId) return next();
  const now = Date.now();

  // Evict stale entries to prevent unbounded map growth
  for (const [uid, entry] of _rateLimits) {
    if (now - entry.windowStart > RATE_LIMIT_MS * 2) _rateLimits.delete(uid);
  }

  const entry = _rateLimits.get(userId) || { count: 0, windowStart: now };
  if (now - entry.windowStart > RATE_LIMIT_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  _rateLimits.set(userId, entry);
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'Too many requests. Please wait before syncing again.' });
  }
  next();
}

// ─── Input Validation ─────────────────────────────────────────────────────────
const ID_RE = /^[a-zA-Z0-9_\-]{1,128}$/;
const MAX_PRESET_PARAMS_BYTES   = 64 * 1024;  //  64 KB
const MAX_NOISE_PROFILE_BYTES   = 256 * 1024; // 256 KB
const MAX_HISTORY_ENTRY_BYTES   = 16 * 1024;  //  16 KB

/**
 * Determine whether a candidate identifier conforms to the allowed character set and length.
 * @param {string} id - Identifier to validate; must match /^[a-zA-Z0-9_\-]{1,128}$/ (letters, digits, underscore, or hyphen, length 1–128).
 * @returns {boolean} `true` if `id` is a string matching the allowed pattern, `false` otherwise.
 */
function _validateId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

/**
 * Check if an object exceeds a maximum depth using an iterative approach.
 * This prevents stack overflow errors during recursive operations like JSON.stringify.
 * @param {any} obj - The object to check.
 * @param {number} maxDepth - Maximum allowed nesting depth.
 * @returns {boolean} True if the object is too deep.
 */
function _isDeep(obj, maxDepth = 10) {
  if (!obj || typeof obj !== 'object') return false;
  const visited = new WeakSet();
  const stack = [[obj, 0]];
  while (stack.length > 0) {
    const [curr, depth] = stack.pop();
    if (depth > maxDepth) return true;
    if (curr && typeof curr === 'object') {
      if (visited.has(curr)) return true;
      visited.add(curr);
      const keys = Object.keys(curr);
      for (let i = 0; i < keys.length; i++) {
        stack.push([curr[keys[i]], depth + 1]);
      }
    }
  }
  return false;
}

/**
 * Determine whether an object is a valid preset with required id and name fields.
 *
 * @param {object} p - Preset candidate; must be a non-null object containing an `id` and `name`.
 * @returns {boolean} `true` if `p` has a valid `id` matching allowed ID pattern and a `name` string with length 1–256, `false` otherwise.
 */
function _validatePreset(p) {
  if (!p || typeof p !== 'object') return false;
  if (!_validateId(p.id)) return false;
  if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > 256) return false;
  return true;
}

/**
 * Produce a sanitized preset object containing only allowed fields and controlled values.
 * @param {object} p - Input preset object (may contain extra or untrusted fields).
 * @returns {object} Sanitized preset with:
 *   - `id` (string): truncated to 128 characters,
 *   - `name` (string): truncated to 256 characters,
 *   - `params` (object): preserved if an object, otherwise `{}`,
 *   - optionally `createdAt` and `updatedAt` if present on the input.
 */
function _sanitizePreset(p) {
  // Only keep known fields to prevent arbitrary data injection
  const rawParams = p.params && typeof p.params === 'object' ? p.params : {};

  let params = {};
  if (!_isDeep(rawParams)) {
    try {
      // Cap params payload to prevent oversized objects
      const paramsStr = JSON.stringify(rawParams);
      if (Buffer.byteLength(paramsStr) <= MAX_PRESET_PARAMS_BYTES) {
        params = rawParams;
      }
    } catch {
      params = {};
    }
  }

  const result = {
    id:     String(p.id).slice(0, 128),
    name:   String(p.name).slice(0, 256),
    params,
  };

  // Only include timestamps if they are valid finite numbers
  if (p.createdAt !== undefined && Number.isFinite(Number(p.createdAt))) {
    result.createdAt = Number(p.createdAt);
  }
  if (p.updatedAt !== undefined && Number.isFinite(Number(p.updatedAt))) {
    result.updatedAt = Number(p.updatedAt);
  }

  return result;
}

/**
 * Validate that a noise profile object is well-formed for storage.
 *
 * @param {object} p - Noise profile to validate. Must be a non-null object containing a `name` string with length between 1 and 256 characters.
 * @returns {boolean} `true` if `p` meets the required shape and `name` constraints, `false` otherwise.
 */
function _validateNoiseProfile(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > 256) return false;
  return true;
}

/**
 * Sanitizes a noise profile object to only include allowed fields.
 * @param {object} p - The input noise profile; may contain `name`, `data`, and optionally `createdAt`.
 * @returns {{name: string, data: object, createdAt?: any}} An object with `name` truncated to 256 characters, `data` ensured to be an object (defaults to `{}`), and `createdAt` included only if present on the input.
 */
function _sanitizeNoiseProfile(p) {
  const rawData = p.data && typeof p.data === 'object' ? p.data : {};

  let data = {};
  if (!_isDeep(rawData)) {
    try {
      // Cap data payload (noise profiles can be larger than presets)
      const dataStr = JSON.stringify(rawData);
      if (Buffer.byteLength(dataStr) <= MAX_NOISE_PROFILE_BYTES) {
        data = rawData;
      }
    } catch {
      data = {};
    }
  }

  const result = {
    name: String(p.name).slice(0, 256),
    data,
  };

  if (p.createdAt !== undefined && Number.isFinite(Number(p.createdAt))) {
    result.createdAt = Number(p.createdAt);
  }

  return result;
}

// ─── GET /api/sync/pull ───────────────────────────────────────────────────────
router.get('/pull', requireAuth, requireRateLimit, (req, res) => {
  const userId = req.user.sub;
  const data = _store.get(userId) || { presets: [], noiseProfiles: [], history: [] };

  res.json({
    presets: data.presets || [],
    noiseProfiles: data.noiseProfiles || [],
    newHistory: (data.history || []).slice(-20),
    syncedAt: Date.now(),
  });
});

// ─── POST /api/sync/push ──────────────────────────────────────────────────────
router.post('/push', requireAuth, requireRateLimit, (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.includes('application/json')) {
    return res.status(415).json({ error: 'Content-Type must be application/json' });
  }

  const userId = req.user.sub;
  const { changes = [] } = req.body;

  if (!Array.isArray(changes)) return res.status(400).json({ error: 'changes must be an array' });
  if (changes.length > 100) return res.status(413).json({ error: 'Too many changes per sync request (max 100)' });

  const data = _store.get(userId) || { presets: [], noiseProfiles: [], history: [] };
  const errors = [];

  for (const change of changes) {
    switch (change.type) {
      case 'preset:upsert': {
        if (!_validatePreset(change.data)) { errors.push(`Invalid preset data for change`); break; }
        const clean = _sanitizePreset(change.data);
        const idx = data.presets.findIndex(p => p.id === clean.id);
        if (idx >= 0) data.presets[idx] = clean;
        else data.presets.push(clean);
        break;
      }
      case 'preset:delete': {
        if (!_validateId(change.id)) { errors.push(`Invalid preset ID`); break; }
        data.presets = data.presets.filter(p => p.id !== change.id);
        break;
      }
      case 'noiseProfile:upsert': {
        if (!_validateNoiseProfile(change.data)) { errors.push(`Invalid noise profile data`); break; }
        const clean = _sanitizeNoiseProfile(change.data);
        const idx = data.noiseProfiles.findIndex(p => p.name === clean.name);
        if (idx >= 0) data.noiseProfiles[idx] = clean;
        else data.noiseProfiles.push(clean);
        break;
      }
      case 'history:add': {
        if (change.data && typeof change.data === 'object') {
          if (_isDeep(change.data)) {
            errors.push('history:add entry is too deep');
          } else {
            try {
              // Cap each history entry to prevent injection of oversized objects
              const entryStr = JSON.stringify(change.data);
              if (Buffer.byteLength(entryStr) <= MAX_HISTORY_ENTRY_BYTES) {
                data.history.push(change.data);
                if (data.history.length > 100) data.history.shift();
              } else {
                errors.push('history:add entry exceeds maximum size (16 KB)');
              }
            } catch {
              errors.push('history:add entry is invalid');
            }
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

export default router;