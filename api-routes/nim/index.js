import express from 'express';
import { NimGrpcClient } from './grpc-client.js';
import { _validateToken } from '../sync.js';

const router = express.Router();
const nimClient = new NimGrpcClient();

// Limit request size for video + audio payloads
router.use(express.json({ limit: '50mb' }));

// NIM cloud inference is an opt-in, paid feature (Studio/Enterprise) — gate it
// the same way api-routes/sync.js gates cloud sync, so it can't be hit anonymously.
// Reuses sync.js's token validator (and its LICENSE_SECRET) rather than deriving
// its own — independent random dev-mode secrets would never agree across modules,
// so a token minted/validated by one router would be rejected by the other.
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
