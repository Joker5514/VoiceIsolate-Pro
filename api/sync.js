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
    if (expectedSig !== parts[2]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const payload = _validateToken(auth.slice(7));
  if (!payload) return res.status(401).json({ error: 'Invalid or expired token' });

  // Check tier allows cloud sync
  const tier = payload.tier?.toUpperCase();
  if (!['STUDIO', 'ENTERPRISE'].includes(tier)) {
    return res.status(403).json({ error: 'Cloud sync requires Studio or Enterprise tier' });
  }

  req.user = payload;
  next();
}

// ─── GET /api/sync/pull ───────────────────────────────────────────────────────
router.get('/pull', requireAuth, (req, res) => {
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
router.post('/push', requireAuth, (req, res) => {
  const userId = req.user.sub;
  const { changes = [] } = req.body;

  if (!Array.isArray(changes)) return res.status(400).json({ error: 'changes must be an array' });
  if (changes.length > 500) return res.status(413).json({ error: 'Too many changes per sync request (max 500)' });

  const data = _store.get(userId) || { presets: [], noiseProfiles: [], history: [] };

  for (const change of changes) {
    switch (change.type) {
      case 'preset:upsert': {
        const idx = data.presets.findIndex(p => p.id === change.data?.id);
        if (idx >= 0) data.presets[idx] = change.data;
        else data.presets.push(change.data);
        break;
      }
      case 'preset:delete': {
        data.presets = data.presets.filter(p => p.id !== change.id);
        break;
      }
      case 'noiseProfile:upsert': {
        const idx = data.noiseProfiles.findIndex(p => p.name === change.data?.name);
        if (idx >= 0) data.noiseProfiles[idx] = change.data;
        else data.noiseProfiles.push(change.data);
        break;
      }
      case 'history:add': {
        data.history = [...(data.history || []), change.data].slice(-100);
        break;
      }
    }
  }

  data.updatedAt = Date.now();
  _store.set(userId, data);

  res.json({ success: true, applied: changes.length, syncedAt: data.updatedAt });
});

export default router;
