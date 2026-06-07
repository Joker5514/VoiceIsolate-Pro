import express from 'express';
import crypto from 'crypto';
import { NimGrpcClient } from './grpc-client.js';

const router = express.Router();
const nimClient = new NimGrpcClient();

// Limit request size for video + audio payloads
router.use(express.json({ limit: '50mb' }));

// NIM cloud inference is an opt-in, paid feature (Studio/Enterprise) — gate it
// the same way api-routes/sync.js gates cloud sync, so it can't be hit anonymously.
const LICENSE_SECRET = (() => {
  if (process.env.LICENSE_JWT_SECRET) return process.env.LICENSE_JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[nim] LICENSE_JWT_SECRET is required in production.');
  }
  return crypto.randomBytes(48).toString('base64url');
})();

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

function requireCloudTier(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const payload = _validateToken(auth.slice(7));
  if (!payload) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const tier = payload.tier?.toUpperCase();
  if (!['STUDIO', 'ENTERPRISE'].includes(tier)) {
    return res.status(403).json({ error: 'NIM cloud inference requires Studio or Enterprise tier' });
  }
  req.user = payload;
  next();
}

router.post('/detect', requireCloudTier, async (req, res) => {
    try {
        const { video, audio, mfcc } = req.body;

        if (!video || !audio) {
            return res.status(400).json({ error: 'Video and audio data are required' });
        }

        // Call gRPC service
        const result = await nimClient.detectActiveSpeaker(video, audio, mfcc);

        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        console.error('NIM gRPC Error:', error);
        res.status(500).json({ error: 'Failed to process media through NIM service' });
    }
});

export default router;
