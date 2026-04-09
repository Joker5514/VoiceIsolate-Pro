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
if (!process.env.LICENSE_JWT_SECRET) {
  throw new Error('LICENSE_JWT_SECRET environment variable is required');
}
const LICENSE_SECRET = process.env.LICENSE_JWT_SECRET;

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

  req.user = payload;
  next();
}

// ─── Rate Limiter (per-user, in-memory; replace with Redis in production) ─────
const _rateLimits = new Map(); // userId → { count, windowStart }
const RATE_LIMIT_MAX = 20;    // requests per window
const RATE_LIMIT_MS  = 60_000; // 1 minute window

function requireRateLimit(req, res, next) {
  const userId = req.user?.sub;
  if (!userId) return next();
  const now = Date.now();
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
  // Only keep known fields to prevent arbitrary data injection
  return {
    id:     String(p.id).slice(0, 128),
    name:   String(p.name).slice(0, 256),
    params: p.params && typeof p.params === 'object' ? p.params : {},
    ...(p.createdAt  !== undefined ? { createdAt:  p.createdAt  } : {}),
    ...(p.updatedAt  !== undefined ? { updatedAt:  p.updatedAt  } : {}),
  };
}

function _validateNoiseProfile(p) {
  if (!p || typeof p !== 'object') return false;
  if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > 256) return false;
  return true;
}

function _sanitizeNoiseProfile(p) {
  return {
    name:    String(p.name).slice(0, 256),
    data:    p.data && typeof p.data === 'object' ? p.data : {},
    ...(p.createdAt !== undefined ? { createdAt: p.createdAt } : {}),
  };
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
          data.history = [...(data.history || []), change.data].slice(-100);
        }
        break;
      }
    }
  }

  data.updatedAt = Date.now();
  _store.set(userId, data);

  res.json({ success: true, applied: changes.length, errors, syncedAt: data.updatedAt });
});

export default router;
