import express from 'express';
import { NimGrpcClient } from './grpc-client.js';

const router = express.Router();
const nimClient = new NimGrpcClient();

// Limit request size for video + audio payloads
router.use(express.json({ limit: '50mb' }));

router.post('/detect', async (req, res) => {
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
